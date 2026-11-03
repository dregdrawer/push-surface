// Maps Push 2 controls onto the disting NT and builds the screen view.
import { CC, COLOR } from './push2.js';
import { UNIT, MIDI_TYPES, formatValue } from './nt.js';

const SCALES = [
  ['Chromatic', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]], ['Major', [0, 2, 4, 5, 7, 9, 11]], ['Minor', [0, 2, 3, 5, 7, 8, 10]],
  ['Dorian', [0, 2, 3, 5, 7, 9, 10]], ['Phrygian', [0, 1, 3, 5, 7, 8, 10]], ['Lydian', [0, 2, 4, 6, 7, 9, 11]],
  ['Mixolydian', [0, 2, 4, 5, 7, 9, 10]], ['Harmonic minor', [0, 2, 3, 5, 7, 8, 11]], ['Pentatonic major', [0, 2, 4, 7, 9]],
  ['Pentatonic minor', [0, 3, 5, 7, 10]], ['Blues', [0, 3, 5, 6, 7, 10]], ['Whole tone', [0, 2, 4, 6, 8, 10]],
];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BUS = (n) => (n === 0 ? 'None' : n <= 12 ? `Input ${n}` : n <= 20 ? `Output ${n - 12}` : n <= 28 ? `Aux ${n - 20}` : `Bus ${n}`);
const MODE_BUTTONS = { device: CC.device, mix: CC.mix, browse: CC.browse, add: CC.addDevice, specs: CC.addDevice, mapping: CC.automate, panel: CC.clip, info: CC.setup, scale: CC.scale };

export class Controller {
  constructor(nt, push, { noteChannel = 0, onChange = () => {}, onReload = () => {} } = {}) {
    Object.assign(this, { nt, push, ch: noteChannel, onChange, onReload });
    this.mode = 'device';
    this.slot = 0; this.page = 0; this.scroll = 0;
    this.shift = false; this.del = false; this.muteHeld = false;
    this.touched = new Set();
    this.acc = new Map();
    this.focus = null; // last touched/turned { slotIndex, num }
    this.padMode = 'note';
    this.octave = 0; this.root = 0; this.scaleIdx = 0; this.inKey = false; this.fixedVel = false;
    this.held = new Map();
    this.undoStack = []; this.redoStack = []; this.gesture = new Map();
    this.status = 'Looking for disting NT…';
    this.toastMsg = null; this.confirmDlg = null; this.busyMsg = null;
    this.list = null; // { title, items, sel, bottom, onPick, kind }
    this.panel = { pots: [2048, 2048, 2048], image: null };
    this.perf = null; this.mapping = null; this.specs = null; this.info = null;

    push.on('encoder', (e, d) => this.encoder(e, d));
    push.on('touch', (e, on) => this.touch(e, on));
    push.on('buttonDown', (cc) => this.button(cc, true));
    push.on('buttonUp', (cc) => this.button(cc, false));
    push.on('padDown', (x, y, v) => this.pad(x, y, v));
    push.on('padUp', (x, y) => this.pad(x, y, 0));
    push.on('padPressure', (x, y, v) => { const n = this.held.get(y * 8 + x); if (n != null) nt.pressure(this.ch, n, v); });
    push.on('pitchbend', (v) => nt.t.send([0xe0 | this.ch, v & 127, (v >> 7) & 127]));
    nt.on('slot', () => this.changed());
    nt.on('values', () => this.changed());
    nt.on('preset', () => { this.status = null; this.clamp(); this.prefetch(); this.findBypasses(); this.changed(); });
  }

  // ======================================================================
  // model helpers
  get curSlot() { return this.nt.slots[this.slot]; }
  get curPage() { return this.curSlot?.pages[this.page]; }
  visible() {
    const s = this.curSlot, pg = this.curPage;
    if (!s || !pg) return [];
    return pg.params.slice(this.scroll * 8, this.scroll * 8 + 8).map((n) => s.params[n]);
  }
  clamp() {
    this.slot = Math.max(0, Math.min(this.slot, this.nt.slots.length - 1));
    this.page = Math.max(0, Math.min(this.page, (this.curSlot?.pages.length ?? 1) - 1));
    const rows = Math.ceil((this.curPage?.params.length ?? 0) / 8);
    this.scroll = Math.max(0, Math.min(this.scroll, rows - 1));
  }
  prefetch() {
    const s = this.curSlot;
    if (s) for (const p of this.visible()) if (p) this.nt.loadParam(s, p, 0).catch(() => {});
  }
  async findBypasses() {
    const gen = this.nt.gen;
    for (const s of this.nt.slots) {
      if (this.nt.gen !== gen) return;
      s.bypass = await this.nt.bypassParam(s, 1).catch(() => null);
    }
    this.changed();
  }
  isBypassed(s) { return !!(s?.bypass && s.bypass.value === s.bypass.max && s.bypass.max > 0); }
  go({ slot = this.slot, page, scroll = 0 }) {
    if (slot !== this.slot) page = page ?? 0;
    this.slot = slot; this.page = page ?? this.page; this.scroll = scroll;
    this.clamp(); this.prefetch(); this.changed();
  }
  changed() { this.updateLeds(); this.onChange(); }
  toast(msg, ms = 1500) {
    this.toastMsg = msg; this.changed();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastMsg = null; this.changed(); }, ms);
  }
  ask(text, yes, run) { this.confirmDlg = { text, yes, run }; this.changed(); }
  async busy(msg, fn, done) {
    this.busyMsg = msg; this.changed();
    try { await fn(); if (done) this.toast(done); }
    catch (e) { this.toast(`Failed: ${e.message}`, 3000); }
    finally { this.busyMsg = null; this.clamp(); this.prefetch(); this.changed(); }
  }
  setMode(m) {
    this.stopTimers();
    if (this.mode === m && m !== 'device') m = 'device'; // pressing a mode button again goes back
    this.mode = m;
    if (m === 'mix') this.openPerf();
    if (m === 'browse') this.openBrowser('/presets');
    if (m === 'add') this.openLibrary();
    if (m === 'mapping') this.openMapping();
    if (m === 'panel') this.openPanel();
    if (m === 'info') this.openInfo();
    this.changed();
  }
  stopTimers() { clearInterval(this.panelTimer); clearInterval(this.infoTimer); this.panelTimer = this.infoTimer = null; }

  // ======================================================================
  // editable fields: a uniform shape for NT parameters, mapping options, specifications…
  paramField(slot, p, { min = p.min, max = p.max } = {}) {
    return {
      name: p.loaded ? p.name : '', loaded: p.loaded, disabled: p.disabled,
      min, max, def: p.def, small: p.unit === UNIT.enum || max - min <= 24,
      get: () => p.value, text: () => formatValue(this.nt, p),
      set: (v) => this.setParam(slot, p, v), param: p, slot,
      readOnly: p.unit === UNIT.text,
    };
  }
  valueField(name, obj, key, min, max, { fmt = (v) => String(v), onSet = () => {}, def = min } = {}) {
    return { name, loaded: true, min, max, def, small: max - min <= 32, get: () => +obj[key], text: () => fmt(obj[key]),
      set: (v) => { obj[key] = typeof obj[key] === 'boolean' ? !!v : v; onSet(); this.changed(); } };
  }
  boolField(name, obj, key, onSet) { return this.valueField(name, obj, key, 0, 1, { fmt: (v) => (v ? 'On' : 'Off'), onSet }); }
  fields() {
    switch (this.mode) {
      case 'device': return this.visible().map((p) => p && this.paramField(this.curSlot, p));
      case 'mix': return this.perfFields();
      case 'mapping': return this.mappingFields();
      case 'specs': return this.specs?.fields ?? [];
      case 'scale': return this.scaleFields();
      default: return [];
    }
  }
  turnField(key, f, delta) {
    if (!f || !f.loaded || f.readOnly) return;
    const range = f.max - f.min;
    const perTick = f.small ? (this.shift ? 0.08 : 0.2) : this.shift ? Math.max(range / 4000, 0.25) : Math.max(range / 400, 0.3);
    const a = (this.acc.get(key) ?? 0) + delta * perTick;
    const whole = a < 0 ? Math.ceil(a) : Math.floor(a);
    this.acc.set(key, a - whole);
    if (whole) f.set(Math.max(f.min, Math.min(f.max, f.get() + whole)));
  }

  // parameter edits go through here so they can be undone
  setParam(slot, p, v, { record = true } = {}) {
    v = Math.max(p.min, Math.min(p.max, Math.round(v)));
    if (v === p.value) return;
    if (record) {
      const key = `${slot.index}:${p.num}`;
      // one undo step per gesture: consecutive turns of the same parameter merge
      const open = this.gesture.get(key);
      if (open && this.undoStack.at(-1) === open) open.to = v;
      else {
        const e = { slot: slot.index, guid: slot.guid, num: p.num, from: p.value, to: v };
        this.undoStack.push(e); this.redoStack = []; this.gesture.set(key, e);
        if (this.undoStack.length > 200) this.undoStack.shift();
      }
      clearTimeout(this.gestureTimer);
      this.gestureTimer = setTimeout(() => this.gesture.clear(), 800);
    }
    this.focus = { slot: slot.index, num: p.num };
    this.nt.setValue(slot, p, v);
  }
  undo(redo = false) {
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    const e = from.pop();
    if (!e) return this.toast(redo ? 'Nothing to redo' : 'Nothing to undo');
    const s = this.nt.slots[e.slot];
    const p = s?.guid === e.guid ? s.params[e.num] : null;
    if (!p) return this.toast('Preset changed — cannot undo');
    this.gesture.clear();
    this.nt.setValue(s, p, redo ? e.to : e.from);
    to.push(e);
    this.go({ slot: e.slot, page: Math.max(0, s.pages.findIndex((pg) => pg.params.includes(e.num))), scroll: 0 });
    this.toast(`${redo ? 'Redo' : 'Undo'}: ${p.name}`);
  }

  // ======================================================================
  // input
  encoder(e, delta) {
    if (this.confirmDlg || this.busyMsg) return;
    if (this.mode === 'panel') return this.panelEncoder(e, delta);
    if (this.list && (this.mode === 'browse' || this.mode === 'add')) {
      if (e === 'master' || e === 0) return this.step('list', delta, () => this.listMove(Math.sign(delta)), 2);
      if (e === 1) return this.step('letter', delta, () => this.listJump(Math.sign(delta)), 4);
      return;
    }
    if (e === 'master') return this.step('slot', delta, () => this.go({ slot: this.slot + Math.sign(delta) }));
    if (e === 'tempo') return this.step('page', delta, () => this.go({ page: this.page + Math.sign(delta) }));
    if (e === 'swing') return this.step('scroll', delta, () => this.go({ page: this.page, scroll: this.scroll + Math.sign(delta) }));
    const f = this.fields()[e];
    if (f?.param) this.focus = { slot: f.slot.index, num: f.param.num };
    this.turnField(e, f, delta);
  }
  step(key, delta, fn, ticks = 6) {
    const a = (this.acc.get(key) ?? 0) + delta;
    if (Math.abs(a) >= ticks) { this.acc.set(key, 0); fn(); } else this.acc.set(key, a);
  }
  touch(e, on) {
    if (typeof e !== 'number') return;
    on ? this.touched.add(e) : this.touched.delete(e);
    this.acc.set(e, 0);
    if (on && this.mode !== 'panel') {
      const f = this.fields()[e];
      if (f?.param) {
        this.focus = { slot: f.slot.index, num: f.param.num };
        if (this.mode === 'mix' && this.del) return this.removePerfItem(e);
        this.nt.focus(f.slot, f.param);
      }
      if (f && this.del && f.loaded && !f.readOnly && f.def != null) f.set(f.def); // Delete + touch = default
    }
    this.changed();
  }

  button(cc, down) {
    if (cc === CC.shift) { this.shift = down; return this.changed(); }
    if (cc === CC.delete) { this.del = down; return this.changed(); }
    if (cc === CC.mute) { this.muteHeld = down; if (!down && !this.muteUsed) this.toggleBypass(this.slot); this.muteUsed = false; return this.changed(); }
    if (this.mode === 'panel' && this.panelButton(cc, down)) return;
    if (!down) return;

    // dialogs
    if (this.confirmDlg) {
      const d = this.confirmDlg; this.confirmDlg = null;
      if (cc === CC.select || cc === CC.lower[7]) d.run();
      return this.changed();
    }
    if (this.busyMsg) return;

    // mode buttons
    const mode = { [CC.device]: 'device', [CC.mix]: 'mix', [CC.browse]: 'browse', [CC.addDevice]: 'add', [CC.automate]: 'mapping', [CC.clip]: 'panel', [CC.setup]: 'info', [CC.scale]: 'scale' }[cc];
    if (mode === 'device') {
      return this.setMode('device');
    }
    if (mode) {
      if (mode === 'mix' && this.shift) return this.addPerfItem();
      if (mode === 'info' && this.shift) return this.onReload();
      return this.setMode(mode);
    }
    if (cc === CC.note) { this.padMode = 'note'; return this.changed(); }
    if (cc === CC.session) { this.padMode = 'session'; return this.changed(); }


    // global actions
    switch (cc) {
      case CC.undo: return this.undo(this.shift);
      case CC.newBtn: return this.ask('Start a new, empty preset? Unsaved changes are lost.', 'New preset', () => this.busy('Clearing preset…', () => this.nt.newPreset(), 'New preset'));
      case CC.record: return this.ask(`Save preset "${this.nt.presetName}" to the SD card?`, 'Save', () => this.busy('Saving…', () => this.nt.savePreset(), 'Saved'));
      case CC.duplicate: return this.curSlot && this.busy(`Duplicating ${this.curSlot.name}…`, async () => { const i = this.slot; await this.nt.duplicateSlot(i); this.slot = i + 1; }, 'Duplicated');
      case CC.solo: return this.solo();
      case CC.accent: this.fixedVel = !this.fixedVel; this.toast(this.fixedVel ? 'Fixed velocity' : 'Velocity'); return;
      case CC.octaveUp: this.octave = Math.min(this.octave + 1, 5); return this.changed();
      case CC.octaveDown: this.octave = Math.max(this.octave - 1, -2); return this.changed();
    }

    // mode-specific
    if (this.list && (this.mode === 'browse' || this.mode === 'add')) return this.listButton(cc);
    if (this.mode === 'specs') return this.specsButton(cc);
    if (this.mode === 'mapping') { const i = CC.lower.indexOf(cc); if (i >= 0 && i < 3) { this.mapping.kind = ['cv', 'midi', 'i2c'][i]; return this.changed(); } }
    if (this.mode === 'mix') { const i = CC.lower.indexOf(cc); if (i >= 0 && this.perf?.items) { this.perf.bank = i; return this.changed(); } }
    if (this.mode === 'info') { if (cc === CC.lower[0]) return this.onReload(); if (cc === CC.lower[7]) return this.setMode('device'); }
    if (this.mode === 'scale' && cc === CC.lower[7]) return this.setMode('device');

    // slot / page navigation (device and others)
    const up = CC.upper.indexOf(cc);
    if (up >= 0) {
      const target = Math.floor(this.slot / 8) * 8 + up;
      if (!this.nt.slots[target]) return;
      if (this.muteHeld) { this.muteUsed = true; return this.toggleBypass(target); }
      if (this.del) return this.ask(`Remove slot ${target + 1} "${this.nt.slots[target].name}"?`, 'Remove', () => this.busy('Removing…', () => this.nt.removeSlot(target), 'Removed'));
      return this.go({ slot: target });
    }
    if (this.mode !== 'device') return;
    const lo = CC.lower.indexOf(cc);
    if (lo >= 0) {
      const page = Math.floor(this.page / 8) * 8 + lo;
      if (!this.curSlot?.pages[page]) return;
      if (page === this.page) {
        const rows = Math.ceil((this.curPage?.params.length ?? 0) / 8);
        return this.go({ page, scroll: (this.scroll + 1) % Math.max(rows, 1) });
      }
      return this.go({ page });
    }
    switch (cc) {
      case CC.left: case CC.right: {
        const d = cc === CC.left ? -1 : 1, to = this.slot + d;
        if (this.shift) { // move the slot
          if (!this.nt.slots[to]) return;
          const from = this.slot;
          return this.busy('Moving…', async () => { await this.nt.moveSlot(from, to); this.slot = to; });
        }
        return this.go({ slot: to });
      }
      case CC.pageLeft: return this.go({ page: this.page - (this.shift ? 8 : 1) });
      case CC.pageRight: return this.go({ page: this.page + (this.shift ? 8 : 1) });
      case CC.up: return this.go({ page: this.page, scroll: this.scroll - 1 });
      case CC.down: return this.go({ page: this.page, scroll: this.scroll + 1 });
    }
  }

  // ======================================================================
  // bypass / solo
  async toggleBypass(i) {
    const s = this.nt.slots[i];
    if (!s) return;
    const p = s.bypass ?? (s.bypass = await this.nt.bypassParam(s));
    if (!p) return this.toast('No bypass on this algorithm');
    this.setParam(s, p, this.isBypassed(s) ? p.min : p.max);
    this.toast(`${s.name}: ${this.isBypassed(s) ? 'bypassed' : 'on'}`);
  }
  async solo() {
    const me = this.slot;
    const others = this.nt.slots.filter((_, i) => i !== me);
    const soloed = others.length && others.every((s) => this.isBypassed(s)) && !this.isBypassed(this.curSlot);
    for (const s of this.nt.slots) {
      const p = s.bypass ?? (s.bypass = await this.nt.bypassParam(s));
      if (p) this.setParam(s, p, soloed || s.index === me ? p.min : p.max);
    }
    this.toast(soloed ? 'Solo off' : `Solo ${this.curSlot.name}`);
  }

  // ======================================================================
  // lists (preset browser, algorithm library)
  listMove(d) { const l = this.list; l.moved = true; l.sel = Math.max(0, Math.min(l.items.length - 1, l.sel + d)); this.changed(); }
  listJump(d) {
    const l = this.list, cur = (l.items[l.sel]?.label ?? '')[0]?.toUpperCase();
    let i = l.sel;
    while (i + d >= 0 && i + d < l.items.length) { i += d; if ((l.items[i].label[0] ?? '').toUpperCase() !== cur) break; }
    if (d < 0) { const c = (l.items[i]?.label[0] ?? '').toUpperCase(); while (i > 0 && (l.items[i - 1].label[0] ?? '').toUpperCase() === c) i--; }
    l.sel = i; l.moved = true; this.changed();
  }
  listButton(cc) {
    const l = this.list, item = l.items[l.sel];
    if (cc === CC.select || cc === CC.lower[0]) return item && l.onPick(item, false);
    if (cc === CC.lower[1] && l.kind === 'presets') return item && l.onPick(item, true);
    if (cc === CC.lower[2] && l.kind === 'presets' && l.path !== '/') return this.openBrowser(l.path.replace(/\/[^/]+$/, '') || '/');
    if (cc === CC.lower[7]) return this.setMode('device');
    if (cc === CC.up) return this.listMove(-1);
    if (cc === CC.down) return this.listMove(1);
    if (cc === CC.pageLeft) return this.listMove(-5);
    if (cc === CC.pageRight) return this.listMove(5);
  }
  async openBrowser(path) {
    this.list = { kind: 'presets', title: `Presets  ${path}`, path, items: [], sel: 0, loading: true,
      bottom: ['Load', 'Append', path === '/' ? '' : 'Up', '', '', '', '', 'Close'],
      onPick: (item, append) => {
        const full = `${path === '/' ? '' : path}/${item.name}`;
        if (item.dir) return this.openBrowser(full);
        this.ask(append ? `Add "${item.label}" to the current preset?` : `Load "${item.label}"? Unsaved changes are lost.`, append ? 'Append' : 'Load', () =>
          this.busy('Loading preset…', async () => { await this.nt.loadPreset(full, append); this.slot = 0; this.page = 0; this.mode = 'device'; }, 'Loaded'));
      } };
    this.changed();
    try {
      const entries = await this.nt.listDir(path);
      this.list.items = entries.filter((e) => e.dir || /\.json$/i.test(e.name))
        .map((e) => ({ ...e, label: e.dir ? `${e.name}/` : e.name.replace(/\.json$/i, '') }))
        .sort((a, b) => (b.dir - a.dir) || a.label.localeCompare(b.label));
      this.list.sel = Math.max(0, this.list.items.findIndex((i) => i.label === this.nt.presetName));
    } catch (e) { this.list.error = 'Could not read the SD card'; }
    this.list.loading = false; this.changed();
  }
  openLibrary() {
    const build = (items) => items.map((a) => ({ label: a.name, detail: a.isPlugin ? 'plug-in' : a.guid, alg: a })).sort((a, b) => a.label.localeCompare(b.label));
    this.list = { kind: 'algorithms', title: 'Add algorithm', items: build(this.nt.library?.items ?? []), sel: 0, loading: !this.nt.library?.complete,
      bottom: ['Add', '', '', '', '', '', '', 'Close'],
      onPick: (item) => this.openSpecs(item.alg) };
    // (selection stays put while the library streams in, unless you've moved it)
    this.changed();
    this.nt.loadLibrary((items) => {
      if (this.list?.kind !== 'algorithms') return;
      const keep = this.list.moved ? this.list.items[this.list.sel]?.label : null;
      this.list.items = build(items);
      this.list.sel = keep ? Math.max(0, this.list.items.findIndex((i) => i.label === keep)) : 0;
      this.changed();
    }).then(() => { if (this.list?.kind === 'algorithms') { this.list.loading = false; this.changed(); } }).catch(() => {});
  }
  openSpecs(alg) {
    const add = () => this.busy(`Adding ${alg.name}…`, async () => { await this.nt.addAlgorithm(alg.guid, vals.map((v) => v.v)); this.slot = this.nt.slots.length - 1; this.page = 0; this.mode = 'device'; this.list = null; }, 'Added');
    const vals = alg.specs.map((sp) => ({ v: sp.def }));
    if (!alg.specs.length) return add();
    this.mode = 'specs';
    this.specs = { alg, add, fields: alg.specs.map((sp, i) => this.valueField(sp.name || `Spec ${i + 1}`, vals[i], 'v', sp.min, sp.max, { def: sp.def })) };
    this.changed();
  }
  specsButton(cc) {
    if (cc === CC.select || cc === CC.lower[0]) return this.specs.add();
    if (cc === CC.lower[7]) { this.mode = 'add'; return this.changed(); }
  }

  // ======================================================================
  // performance page (Mix)
  async openPerf() {
    this.perf = { items: null, bank: 0, error: null };
    this.changed();
    try { this.perf.items = (await this.nt.getPerfItems()); }
    catch { this.perf.error = 'Performance page needs disting NT firmware 1.16 or later'; }
    this.changed();
  }
  perfFields() {
    const items = (this.perf?.items ?? []).filter((it) => it.enabled);
    return items.slice(this.perf.bank * 8, this.perf.bank * 8 + 8).map((it) => {
      const s = this.nt.slots[it.slot], p = s?.params[it.num];
      if (!p) return null;
      if (!p.loaded) this.nt.loadParam(s, p, 0).catch(() => {});
      const f = this.paramField(s, p, { min: Math.max(p.min, it.min), max: Math.min(p.max, it.max) });
      f.name = it.upper || f.name; f.sub = it.lower || s.name; f.item = it;
      return f;
    });
  }
  async addPerfItem() {
    const s = this.nt.slots[this.focus?.slot], p = s?.params[this.focus?.num];
    if (!p) return this.toast('Touch a parameter first, then Shift + Mix');
    try {
      const items = this.perf?.items ?? (await this.nt.getPerfItems());
      if (items.some((it) => it.enabled && it.slot === s.index && it.num === p.num)) return this.toast('Already on the performance page');
      const free = items.find((it) => !it.enabled)?.index ?? items.length;
      await this.nt.setPerfItem({ index: free, enabled: true, slot: s.index, num: p.num, min: p.min, max: p.max, upper: p.name, lower: s.name });
      this.toast(`${p.name} → performance page`);
      if (this.mode === 'mix') this.openPerf();
    } catch { this.toast('Performance page needs firmware 1.16+'); }
  }
  async removePerfItem(e) {
    const f = this.perfFields()[e];
    if (!f) return;
    await this.nt.setPerfItem({ index: f.item.index, enabled: false });
    this.toast(`Removed ${f.name}`);
    this.openPerf();
  }

  // ======================================================================
  // mappings (Automate)
  async openMapping() {
    const s = this.nt.slots[this.focus?.slot], p = s?.params[this.focus?.num];
    this.mapping = { slot: s, p, kind: this.mapping?.kind ?? 'midi', m: null, error: p ? null : 'Touch or turn a parameter first, then press Automate' };
    this.changed();
    if (!p) return;
    try { this.mapping.m = await this.nt.getMapping(s, p); }
    catch { this.mapping.error = 'Could not read mappings'; }
    this.changed();
  }
  mappingFields() {
    const mp = this.mapping;
    if (!mp?.m) return [];
    const m = mp.m, kind = mp.kind;
    const save = () => { clearTimeout(this.mapTimer); this.mapTimer = setTimeout(() => this.nt.setMapping(mp.slot, mp.p, kind, m), 60); };
    const V = (n, k, lo, hi, o = {}) => this.valueField(n, m, k, lo, hi, { onSet: save, ...o });
    const B = (n, k) => this.boolField(n, m, k, save);
    const pr = [mp.p.min, mp.p.max];
    if (kind === 'cv') return [V('CV input', 'cvInput', 0, 28, { fmt: BUS }), B('Unipolar', 'unipolar'), B('Gate', 'gate'), V('Volts', 'volts', 0, 127), V('Delta', 'delta', 0, 10000)];
    if (kind === 'midi') return [B('MIDI enabled', 'midiEnabled'), V('Channel', 'midiChannel', 0, 15, { fmt: (v) => String(v + 1) }), V('Type', 'midiType', 0, MIDI_TYPES.length - 1, { fmt: (v) => MIDI_TYPES[v] }),
      V(m.midiType === 1 || m.midiType === 2 ? 'Note' : 'CC', 'midiCC', 0, 127), B('Relative', 'midiRelative'), B('Symmetric', 'midiSymmetric'), V('Min', 'midiMin', ...pr, { def: pr[0] }), V('Max', 'midiMax', ...pr, { def: pr[1] })];
    return [B('I2C enabled', 'i2cEnabled'), V('I2C CC', 'i2cCC', 0, 255), B('Symmetric', 'i2cSymmetric'), V('Min', 'i2cMin', ...pr, { def: pr[0] }), V('Max', 'i2cMax', ...pr, { def: pr[1] })];
  }

  // ======================================================================
  // NT front panel (Clip): mirror its screen, Push controls act as its pots, encoders and buttons
  openPanel() {
    const grab = async () => {
      if (this.grabbing) return;
      this.grabbing = true;
      try { this.panel.image = await this.nt.screenshot(); this.changed(); } catch { /* skip frame */ }
      finally { this.grabbing = false; }
    };
    grab();
    this.panelTimer = setInterval(grab, 100);
  }
  panelEncoder(e, delta) {
    if (e === 0 || e === 1 || e === 2) {
      const step = this.shift ? 4 : 24;
      this.panel.pots[e] = Math.max(0, Math.min(4095, this.panel.pots[e] + delta * step));
      this.nt.remotePot(e, this.panel.pots[e]);
    } else if (e === 3 || e === 4) this.step(`nte${e}`, delta, () => this.nt.remoteEncoder(e - 3, Math.sign(delta)), 3);
    else if (e === 'master') this.step('nte4', delta, () => this.nt.remoteEncoder(1, Math.sign(delta)), 3);
  }
  // upper buttons 1-5: press L/C/R pot, L/R encoder · lower buttons 1-4: NT buttons 1-4
  panelButton(cc, down) {
    const up = CC.upper.indexOf(cc), lo = CC.lower.indexOf(cc);
    if (up >= 0 && up < 5) { this.nt.remotePress(4 + up, down); return true; }
    if (lo >= 0 && lo < 4) { this.nt.remotePress(lo, down); return true; }
    return false;
  }

  // ======================================================================
  // Setup: CPU and housekeeping
  openInfo() {
    const poll = async () => { try { this.info = await this.nt.cpu(); this.changed(); } catch { /* ignore */ } };
    poll();
    this.infoTimer = setInterval(poll, 1000);
  }

  // ======================================================================
  // Scale + pads
  scaleFields() {
    const self = this, o = { root: this.root, scale: this.scaleIdx, key: this.inKey ? 1 : 0, vel: this.fixedVel ? 1 : 0, ch: this.ch };
    const sync = () => { self.root = o.root; self.scaleIdx = o.scale; self.inKey = !!o.key; self.fixedVel = !!o.vel; self.ch = o.ch; self.updatePads(); };
    return [
      this.valueField('Root', o, 'root', 0, 11, { fmt: (v) => NOTES[v], onSet: sync }),
      this.valueField('Scale', o, 'scale', 0, SCALES.length - 1, { fmt: (v) => SCALES[v][0], onSet: sync }),
      this.valueField('Layout', o, 'key', 0, 1, { fmt: (v) => (v ? 'In key' : 'Chromatic'), onSet: sync }),
      this.valueField('Velocity', o, 'vel', 0, 1, { fmt: (v) => (v ? 'Fixed' : 'Dynamic'), onSet: sync }),
      this.valueField('MIDI channel', o, 'ch', 0, 15, { fmt: (v) => String(v + 1), onSet: sync }),
    ];
  }
  noteFor(x, y) {
    const base = 36 + this.octave * 12 + this.root;
    if (!this.inKey) return base + x + y * 5;
    const sc = SCALES[this.scaleIdx][1], deg = x + y * 3;
    return base + Math.floor(deg / sc.length) * 12 + sc[deg % sc.length];
  }
  inScale(n) { return SCALES[this.scaleIdx][1].includes((((n - this.root) % 12) + 12) % 12); }
  pad(x, y, vel) {
    if (this.padMode === 'session') {
      if (!vel) return;
      const slot = Math.floor(this.slot / 8) * 8 + x;
      const s = this.nt.slots[slot];
      if (!s?.pages[y]) return;
      if (this.mode !== 'device') this.setMode('device');
      return this.go({ slot, page: y });
    }
    const k = y * 8 + x;
    if (vel) {
      const n = this.noteFor(x, y);
      if (n < 0 || n > 127) return;
      this.held.set(k, n);
      this.nt.noteOn(this.ch, n, this.fixedVel ? 127 : vel);
    } else {
      const n = this.held.get(k);
      if (n == null) return;
      this.held.delete(k);
      this.nt.noteOff(this.ch, n);
    }
    this.updatePads();
  }

  // ======================================================================
  // LEDs
  updateLeds() {
    const push = this.push, slots = this.nt.slots, s = this.curSlot;
    const sb = Math.floor(this.slot / 8) * 8, pb = Math.floor(this.page / 8) * 8;
    const panel = this.mode === 'panel';
    CC.upper.forEach((cc, i) => {
      if (panel) return push.button(cc, i < 5 ? COLOR.dim : COLOR.off);
      const sl = slots[sb + i];
      push.button(cc, !sl ? COLOR.off : sb + i === this.slot ? COLOR.accent : this.isBypassed(sl) ? COLOR.warn : COLOR.dim);
    });
    const lower = this.lowerLabels();
    CC.lower.forEach((cc, i) => push.button(cc, !lower[i] ? COLOR.off : lower[i].selected ? COLOR.accent : COLOR.dim));
    const rows = Math.ceil((this.curPage?.params.length ?? 0) / 8);
    const dev = this.mode === 'device';
    push.button(CC.left, dev && this.slot > 0 ? COLOR.white : COLOR.off);
    push.button(CC.right, dev && this.slot < slots.length - 1 ? COLOR.white : COLOR.off);
    push.button(CC.pageLeft, dev && this.page > 0 ? COLOR.white : COLOR.off);
    push.button(CC.pageRight, dev && s && this.page < s.pages.length - 1 ? COLOR.white : COLOR.off);
    push.button(CC.up, (dev && this.scroll > 0) || this.list ? COLOR.white : COLOR.off);
    push.button(CC.down, (dev && this.scroll < rows - 1) || this.list ? COLOR.white : COLOR.off);
    for (const [m, cc] of Object.entries(MODE_BUTTONS)) if (m !== 'specs') push.button(cc, (this.mode === m || (m === 'add' && this.mode === 'specs')) ? COLOR.white : COLOR.dim);
    push.button(CC.note, this.padMode === 'note' ? COLOR.white : COLOR.dim);
    push.button(CC.session, this.padMode === 'session' ? COLOR.white : COLOR.dim);
    for (const cc of [CC.octaveUp, CC.octaveDown, CC.shift, CC.newBtn, CC.duplicate, CC.record, CC.solo, CC.select]) push.button(cc, COLOR.dim);
    push.button(CC.undo, this.undoStack.length || this.redoStack.length ? COLOR.white : COLOR.dim);
    push.button(CC.delete, this.del ? COLOR.white : COLOR.dim);
    push.button(CC.mute, this.isBypassed(s) ? COLOR.warn : COLOR.dim);
    push.button(CC.accent, this.fixedVel ? COLOR.white : COLOR.dim);
    this.updatePads();
  }
  updatePads() {
    if (this.padMode === 'session') {
      const sb = Math.floor(this.slot / 8) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const s = this.nt.slots[sb + x];
        const c = !s?.pages[y] ? COLOR.off : sb + x === this.slot && y === this.page ? COLOR.accent : this.isBypassed(s) ? COLOR.warn : sb + x === this.slot ? COLOR.root : COLOR.pad;
        this.push.pad(x, y, c);
      }
      return;
    }
    const lit = new Set(this.held.values());
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const n = this.noteFor(x, y);
      const pc = (((n - this.root) % 12) + 12) % 12;
      const c = n < 0 || n > 127 ? COLOR.off : lit.has(n) ? COLOR.padLit : pc === 0 ? COLOR.root : !this.inKey && this.scaleIdx && !this.inScale(n) ? COLOR.off : COLOR.pad;
      this.push.pad(x, y, c);
    }
  }

  // ======================================================================
  // screen
  lowerLabels() {
    const sel = (labels, i) => labels.map((l, k) => (l ? { label: l, selected: k === i } : null));
    switch (this.mode) {
      case 'device': {
        const s = this.curSlot, pb = Math.floor(this.page / 8) * 8;
        return (s?.pages.slice(pb, pb + 8) ?? []).map((pg, i) => ({ label: pg.name, selected: pb + i === this.page }));
      }
      case 'mix': {
        const n = Math.ceil((this.perf?.items?.filter((i) => i.enabled).length ?? 0) / 8);
        return Array.from({ length: n }, (_, i) => ({ label: `${i * 8 + 1}–${i * 8 + 8}`, selected: i === this.perf.bank }));
      }
      case 'mapping': return sel(['CV', 'MIDI', 'I2C'], ['cv', 'midi', 'i2c'].indexOf(this.mapping?.kind));
      case 'browse': case 'add': return (this.list?.bottom ?? []).map((l) => (l ? { label: l } : null));
      case 'specs': return sel(['Add', '', '', '', '', '', '', 'Back'], -1);
      case 'panel': return sel(['Button 1', 'Button 2', 'Button 3', 'Button 4'], -1);
      case 'info': return sel(['Reload', '', '', '', '', '', '', 'Close'], -1);
      case 'scale': return sel(['', '', '', '', '', '', '', 'Done'], -1);
    }
    return [];
  }
  topLabels() {
    if (this.mode === 'panel') return ['Push L pot', 'Push C pot', 'Push R pot', 'Push L enc', 'Push R enc'].map((label) => ({ label }));
    const slots = this.nt.slots, sb = Math.floor(this.slot / 8) * 8;
    return slots.slice(sb, sb + 8).map((sl, i) => ({ label: `${sb + i + 1} ${sl.name || sl.guid}`, selected: sb + i === this.slot, warn: this.isBypassed(sl) }));
  }
  fieldView(f, i) {
    if (!f) return { empty: true };
    const range = f.max - f.min;
    const known = f.known ? f.known() : true;
    return { name: f.name, sub: f.sub, value: f.loaded ? f.text() : '…', norm: f.loaded && known && range > 0 ? (f.get() - f.min) / range : null,
      bipolar: f.bipolar ?? (f.min < 0 && f.max > 0), touched: this.touched.has(i), disabled: f.disabled };
  }
  view() {
    if (this.status || !this.nt.slots) return { kind: 'status', status: this.status ?? 'Preset is empty' };
    const base = { preset: this.nt.presetName, top: this.topLabels(), bottom: this.lowerLabels(), toast: this.busyMsg ?? this.toastMsg, confirm: this.confirmDlg, shift: this.shift, del: this.del };
    const rows = Math.ceil((this.curPage?.params.length ?? 0) / 8);
    switch (this.mode) {
      case 'browse': case 'add': {
        const l = this.list;
        return { ...base, kind: 'list', top: [], title: l.title, items: l.items, sel: l.sel, note: l.error ?? (l.loading ? (l.kind === 'algorithms' ? `Reading library… ${l.items.length}` : 'Reading SD card…') : l.items.length ? '' : 'Nothing here') };
      }
      case 'panel': return { ...base, kind: 'panel', image: this.panel.image, encoders: ['L pot', 'C pot', 'R pot', 'L encoder', 'R encoder'],
        buttons: ['Lower 1–4 → Buttons 1–4', 'Master → R encoder', 'Clip → back'] };
      case 'info': {
        const c = this.info;
        return { ...base, kind: 'params', title: c ? `CPU  ${c.cpu1}% · ${c.cpu2}%` : 'Setup',
          params: this.nt.slots.slice(0, 8).map((s, i) => ({ name: s.name, value: c ? `${c.slots[i] ?? 0}%` : '…', norm: c ? (c.slots[i] ?? 0) / 100 : null })),
          hint: 'Shift + Setup reloads too' };
      }
    }
    if (this.nt.slots.length === 0 && this.mode === 'device') return { ...base, kind: 'status', status: 'Empty preset — press Add Device to add an algorithm' };
    const fields = this.fields();
    const msg = this.mode === 'mix' ? (this.perf?.error ?? (!this.perf?.items ? 'Reading performance page…' : fields.length ? '' : 'Performance page is empty — touch a parameter, then Shift + Mix to add it'))
      : this.mode === 'mapping' ? (this.mapping?.error ?? (!this.mapping?.m ? 'Reading mappings…' : '')) : '';
    const title = { mix: 'Performance', mapping: this.mapping?.p ? `Mapping · ${this.mapping.slot.name} · ${this.mapping.p.name}` : 'Mapping', specs: `Add ${this.specs?.alg.name ?? ''} — specifications`, scale: 'Pads' }[this.mode];
    return { ...base, kind: 'params', title, message: msg,
      params: Array.from({ length: 8 }, (_, i) => this.fieldView(fields[i], i)),
      hint: [this.mode === 'device' && rows > 1 ? `${this.scroll * 8 + 1}–${Math.min((this.scroll + 1) * 8, this.curPage.params.length)} of ${this.curPage.params.length}` : '', this.octave ? `Oct ${this.octave > 0 ? '+' : ''}${this.octave}` : ''].filter(Boolean).join('   ') };
  }
}
