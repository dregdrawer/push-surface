// disting NT SysEx driver.
// Protocol: F0 00 21 27 6D <sysExId> <cmd> ... F7 (Expert Sleepers manual, "MIDI SysEx reference").
// 16-bit numbers travel as three 7-bit bytes, MSB first: [bits 14-15][bits 7-13][bits 0-6].
import { EventEmitter } from 'node:events';

export const CMD = {
  takeScreenshot: 0x01,
  requestNumAlgorithms: 0x30,
  requestAlgorithmInfo: 0x31,
  addAlgorithm: 0x32,
  removeAlgorithm: 0x33,
  loadPreset: 0x34,
  newPreset: 0x35,
  savePreset: 0x36,
  moveAlgorithm: 0x37,
  requestMappings: 0x4b,
  setCvMapping: 0x4d,
  setMidiMapping: 0x4e,
  setI2cMapping: 0x4f,
  setSlotName: 0x51,
  requestPerfPageItem: 0x57,
  setPerfPageItem: 0x58,
  requestCpuUsage: 0x62,
  remoteControl: 0x78,
  sdCard: 0x7a,
  requestAlgorithm: 0x40,
  requestPresetName: 0x41,
  requestNumParameters: 0x42,
  requestParameterInfo: 0x43,
  requestAllParameterValues: 0x44,
  requestParameterValue: 0x45,
  setParameterValue: 0x46,
  requestUnitStrings: 0x48,
  requestEnumStrings: 0x49,
  setFocus: 0x4a,
  requestParameterValueString: 0x50,
  requestParameterPages: 0x52,
  requestNumAlgorithmsInPreset: 0x60,
};

export const UNIT = { none: 0, enum: 1, volts: 13, bpm: 14, degrees: 15, hasStrings: 16, confirm: 17, text: 18 };

const HEADER = [0xf0, 0x00, 0x21, 0x27, 0x6d];
const RESPONSE_CMD = { [CMD.takeScreenshot]: 0x33 };

export function encode16(v) {
  v &= 0xffff;
  return [(v >> 14) & 0x03, (v >> 7) & 0x7f, v & 0x7f];
}
export function decode16(d, o) {
  let v = (d[o] << 14) | (d[o + 1] << 7) | d[o + 2];
  if (v & 0x8000) v -= 0x10000;
  return v;
}
// Value fields carry flag bits above bit 15 in the first byte (bit 2 of byte 0 = "disabled").
function decodeValue(d, o) {
  return { value: decode16([d[o] & 0x03, d[o + 1], d[o + 2]], 0), disabled: ((d[o] >> 2) & 0x1f) === 1 };
}
export function decodeAscii(d, o) {
  let s = '';
  while (o < d.length && d[o] !== 0) s += String.fromCharCode(d[o++]);
  return { value: s, next: o + 1 };
}

export function buildMessage(sysExId, cmd, body = []) {
  return [...HEADER, sysExId & 0x7f, cmd, ...body, 0xf7];
}

// Parse an incoming NT message into { cmd, payload } or null.
export function parseMessage(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return null;
  for (let i = 0; i < HEADER.length; i++) if (bytes[i] !== HEADER[i]) return null;
  return { sysExId: bytes[5], cmd: bytes[6], payload: bytes.slice(7, -1) };
}

// Response decoders, keyed by command byte.
export const decoders = {
  [CMD.requestPresetName]: (p) => decodeAscii(p, 0).value,
  [CMD.requestNumAlgorithmsInPreset]: (p) => p[0],
  [CMD.requestAlgorithm]: (p) => {
    const name = decodeAscii(p, 5);
    // Newer firmware appends specifications (optionally after a 6-byte visual style block).
    let specs = null;
    for (const off of [name.next + 6, name.next]) {
      const n = p[off];
      if (n != null && p.length === off + 1 + n * 3) { specs = Array.from({ length: n }, (_, i) => decode16(p, off + 1 + i * 3)); break; }
    }
    return { slot: p[0], guid: String.fromCharCode(...p.slice(1, 5)), name: name.value.trim(), specs };
  },
  [CMD.requestNumParameters]: (p) => ({ slot: p[0], count: decode16(p, 1) }),
  [CMD.requestParameterInfo]: (p) => {
    const name = decodeAscii(p, 14);
    const flags = name.next < p.length ? p[name.next] : 0;
    return {
      slot: p[0], num: decode16(p, 1), min: decode16(p, 4), max: decode16(p, 7),
      def: decode16(p, 10), unit: p[13], name: name.value, pow10: -(flags & 0x3),
    };
  },
  [CMD.requestAllParameterValues]: (p) => {
    const values = [];
    for (let o = 1; o + 2 < p.length; o += 3) values.push(decodeValue(p, o));
    return { slot: p[0], values };
  },
  [CMD.requestParameterValue]: (p) => ({ slot: p[0], num: decode16(p, 1), ...decodeValue(p, 4) }),
  [CMD.requestUnitStrings]: (p) => {
    const out = []; let o = 1;
    for (let i = 0; i < p[0]; i++) { const s = decodeAscii(p, o); out.push(s.value); o = s.next; }
    return out;
  },
  [CMD.requestEnumStrings]: (p) => {
    const out = []; let o = 5;
    for (let i = 0; i < p[4] && o < p.length; i++) { const s = decodeAscii(p, o); out.push(s.value); o = s.next; }
    return { slot: p[0], num: decode16(p, 1), strings: out };
  },
  [CMD.requestParameterValueString]: (p) => ({ slot: p[0], num: decode16(p, 1), text: decodeAscii(p, 4).value }),
  [CMD.requestNumAlgorithms]: (p) => decode16(p, 0),
  [CMD.requestAlgorithmInfo]: (p) => {
    let o = 3;
    const guid = String.fromCharCode(...p.slice(o, o + 4)); o += 4;
    const n = p[o++]; const specs = [];
    for (let i = 0; i < n; i++) { specs.push({ min: decode16(p, o), max: decode16(p, o + 3), def: decode16(p, o + 6), type: p[o + 9] }); o += 10; }
    const name = decodeAscii(p, o); o = name.next;
    for (const sp of specs) { const sn = decodeAscii(p, o); sp.name = sn.value; o = sn.next; }
    const isPlugin = o < p.length ? p[o] !== 0 : false;
    return { index: decode16(p, 0), guid, name: name.value, specs, isPlugin };
  },
  0x33: (p) => p, // screenshot: 256×64 bytes, 4-bit grey levels
  [CMD.requestCpuUsage]: (p) => ({ cpu1: p[0], cpu2: p[1], slots: [...p.slice(2)] }),
  [CMD.requestMappings]: (p) => ({ slot: p[0], num: decode16(p, 1), mapping: decodeMapping(p[4], p.slice(5)) }),
  [CMD.requestPerfPageItem]: (p) => {
    const item = { index: p[1], enabled: (p[2] & 1) === 1 };
    if (!item.enabled) return item;
    const a = decodeAscii(p, 13), b = decodeAscii(p, a.next);
    return { ...item, slot: p[3], num: decode16(p, 4), min: decode16(p, 7), max: decode16(p, 10), upper: a.value, lower: b.value };
  },
  [CMD.sdCard]: (p) => {
    if (p[0] !== 0 || p[1] !== 1) return { entries: [], error: p[0] !== 0 ? decodeAscii(p, 1).value : null };
    const d = p.slice(2); const entries = []; let i = 0;
    while (d.length - i >= 18) {
      const attr = d[i]; i += 17; // attributes, date(3), time(3), size(10)
      let name = ''; while (i < d.length && d[i] !== 0) name += String.fromCharCode(d[i++]); i++;
      if (!name) break;
      entries.push({ name, dir: (attr & 0x10) !== 0 });
    }
    return { entries };
  },
  [CMD.requestParameterPages]: (p) => {
    const pages = []; let o = 2;
    for (let i = 0; i < p[1] && o < p.length; i++) {
      const s = decodeAscii(p, o); o = s.next;
      const n = p[o++] ?? 0; const params = [];
      for (let k = 0; k < n && o + 1 < p.length; k++) { params.push((p[o] << 7) | p[o + 1]); o += 2; }
      pages.push({ name: s.value, params });
    }
    return { slot: p[0], pages };
  },
};

// How to recognise the reply to a request (same command byte, and same slot/param where present).
function matcher(cmd, body) {
  return (msg) => {
    if (msg.cmd !== (RESPONSE_CMD[cmd] ?? cmd)) return false;
    if ([CMD.requestAlgorithm, CMD.requestNumParameters, CMD.requestAllParameterValues, CMD.requestParameterPages].includes(cmd))
      return msg.payload[0] === body[0];
    if ([CMD.requestParameterInfo, CMD.requestParameterValue, CMD.requestEnumStrings, CMD.requestParameterValueString, CMD.requestMappings].includes(cmd))
      return msg.payload[0] === body[0] && decode16(msg.payload, 1) === decode16(body, 1);
    if (cmd === CMD.requestAlgorithmInfo) return decode16(msg.payload, 0) === decode16(body, 0);
    if (cmd === CMD.requestPerfPageItem) return msg.payload[1] === body[0];
    return true;
  };
}

// ---- mapping data (CV / MIDI / I2C), versions 1-7 as used by Expert Sleepers' preset editor ----
export const MIDI_TYPES = ['CC', 'Note (momentary)', 'Note (toggle)', 'CC 14-bit low', 'CC 14-bit high', 'Pitch bend', 'Channel pressure'];
export function decodeMapping(version, d) {
  const v = Math.min(Math.max(version, 1), 7); let o = 0;
  const b = () => d[o++] ?? 0;
  const s16 = () => { const r = d.length >= o + 3 ? decode16(d, o) : 0; o += 3; return r; };
  const m = { version };
  m.source = v >= 4 ? b() : 0;
  m.cvInput = b(); const cf = b(); m.unipolar = !!(cf & 1); m.gate = !!(cf & 2);
  m.volts = b(); m.delta = s16() & 0xffff;
  m.midiCC = b(); const mf = b(); const mf2 = v >= 2 ? b() : 0;
  m.midiEnabled = !!(mf & 1); m.midiSymmetric = !!(mf & 2); m.midiChannel = (mf >> 3) & 15;
  m.midiRelative = !!(mf2 & 1); m.midiType = Math.min(mf2 >> 2, MIDI_TYPES.length - 1);
  if (v < 7 && mf & 4) m.midiType = 6;
  m.midiMin = s16(); m.midiMax = s16();
  m.i2cCC = b(); if (v >= 3) m.i2cCC |= (b() & 1) << 7;
  const i2f = b(); m.i2cEnabled = !!(i2f & 1); m.i2cSymmetric = !!(i2f & 2);
  m.i2cMin = s16(); m.i2cMax = s16();
  return m;
}
export function encodeMapping(kind, m) {
  const v = Math.min(m.version, 7);
  if (kind === 'cv') return [...(v >= 4 ? [m.source & 127] : []), m.cvInput & 127, (m.unipolar ? 1 : 0) | (m.gate ? 2 : 0), m.volts & 127, ...encode16(m.delta)];
  if (kind === 'midi') {
    let type = m.midiType, cc = type >= 5 ? 0 : m.midiCC;
    let flags = (m.midiEnabled ? 1 : 0) | (m.midiSymmetric ? 2 : 0) | ((m.midiChannel & 15) << 3);
    if (v < 7 && type === 6) { flags |= 4; type = 0; }
    const f2 = (m.midiRelative && type < 5 ? 1 : 0) | (type << 2);
    return [cc & 127, flags, ...(v >= 2 ? [f2 & 127] : []), ...encode16(m.midiMin), ...encode16(m.midiMax)];
  }
  return [m.i2cCC & 127, ...(v >= 3 ? [(m.i2cCC >> 7) & 1] : []), (m.i2cEnabled ? 1 : 0) | (m.i2cSymmetric ? 2 : 0), ...encode16(m.i2cMin), ...encode16(m.i2cMax)];
}

/**
 * DistingNT keeps a model of the preset (slots → pages → parameters) in sync with the module.
 * Transport: an object with send(bytes[]) and an 'message' event delivering raw SysEx arrays.
 * Events: 'preset' (full reload done), 'slot' (slot data changed), 'values' (slot values changed), 'status'.
 */
export class DistingNT extends EventEmitter {
  constructor(transport, { sysExId = 0, timeout = 500, retries = 2 } = {}) {
    super();
    this.t = transport;
    this.id = sysExId;
    this.timeout = timeout;
    this.retries = retries;
    this.queue = [[], []]; // [high priority, background]
    this.inflight = null;
    this.units = [];
    this.presetName = '';
    this.slots = [];
    this.recentEdits = new Map(); // "slot:param" -> timestamp, so polling doesn't fight the encoders
    this.pendingSets = new Map();
    this.connected = false;
    this.lastCommand = 0;
    transport.on('message', (bytes) => this._onMessage(bytes));
  }

  // ---- request plumbing -------------------------------------------------
  request(cmd, body = [], { priority = 0, keep = false } = {}) {
    return new Promise((resolve, reject) => {
      this.queue[priority].push({ cmd, body, resolve, reject, tries: 0, keep });
      this._pump();
    });
  }
  // A command with no reply, kept in order with requests.
  command(cmd, body = []) {
    this.lastCommand = Date.now();
    return new Promise((resolve) => { this.queue[0].push({ cmd, body, resolve, noReply: true }); this._pump(); });
  }
  _pump() {
    if (this.inflight) return;
    const job = this.queue[0].shift() ?? this.queue[1].shift();
    if (!job) return;
    if (job.noReply) { this.t.send(buildMessage(this.id, job.cmd, job.body)); job.resolve(); return this._pump(); }
    this.inflight = job;
    job.match = matcher(job.cmd, job.body);
    job.tries++;
    this.t.send(buildMessage(this.id, job.cmd, job.body));
    job.timer = setTimeout(() => {
      this.inflight = null;
      if (job.tries <= this.retries) this.queue[0].unshift(job);
      else job.reject(new Error(`disting NT did not answer 0x${job.cmd.toString(16)}`));
      this._pump();
    }, this.timeout);
  }
  _onMessage(bytes) {
    const msg = parseMessage(bytes);
    if (!msg || msg.sysExId !== this.id) return;
    const job = this.inflight;
    if (job && job.match(msg)) {
      clearTimeout(job.timer);
      this.inflight = null;
      const dec = decoders[msg.cmd];
      try { job.resolve(dec ? dec(msg.payload) : msg.payload); } catch (e) { job.reject(e); }
      this._pump();
    }
  }
  clearBackground() {
    for (const j of this.queue[1]) if (!j.keep) j.reject?.(new Error('cancelled'));
    this.queue[1] = this.queue[1].filter((j) => j.keep);
  }

  // ---- loading ----------------------------------------------------------
  async load() {
    this.loadingNow = true;
    try { return await this._load(); } finally { this.loadingNow = false; }
  }
  async _load() {
    this.gen = (this.gen ?? 0) + 1;
    this.clearBackground();
    this.units = await this.request(CMD.requestUnitStrings);
    this.presetName = await this.request(CMD.requestPresetName);
    const n = await this.request(CMD.requestNumAlgorithmsInPreset);
    const slots = [];
    for (let i = 0; i < n; i++) slots.push(await this._loadSlotHeader(i));
    this.slots = slots;
    this.connected = true;
    this.emit('preset');
    // Fill in every parameter's info in the background; the UI asks for its visible page first.
    for (const s of slots) this._backgroundInfo(s);
    return slots;
  }
  async _loadSlotHeader(i) {
    const alg = await this.request(CMD.requestAlgorithm, [i]);
    const { count } = await this.request(CMD.requestNumParameters, [i]);
    let pages = [];
    try { pages = (await this.request(CMD.requestParameterPages, [i])).pages; } catch { /* older firmware */ }
    const params = Array.from({ length: count }, (_, num) => ({ num, name: `P${num + 1}`, min: 0, max: 0, def: 0, unit: 0, pow10: 0, value: 0, loaded: false }));
    if (!pages.length) for (let k = 0; k < count; k += 8) pages.push({ name: `Page ${k / 8 + 1}`, params: params.slice(k, k + 8).map((p) => p.num) });
    pages = pages.filter((p) => p.params.length);
    const slot = { index: i, guid: alg.guid, name: alg.name, specs: alg.specs, params, pages };
    const vals = await this.request(CMD.requestAllParameterValues, [i]);
    vals.values.forEach((v, k) => { if (params[k]) Object.assign(params[k], v); });
    return slot;
  }
  _backgroundInfo(slot) {
    for (const p of slot.params) if (!p.loaded) this.loadParam(slot, p, 1).catch(() => {});
  }
  // Load name/range/unit (+ enum strings) for one parameter. Priority 0 jumps the queue.
  async loadParam(slot, p, priority = 0) {
    if (p.loaded) return p;
    if (p.loading) return p.loading;
    p.loading = (async () => {
      const info = await this.request(CMD.requestParameterInfo, [slot.index, ...encode16(p.num)], { priority });
      Object.assign(p, { name: info.name, min: info.min, max: info.max, def: info.def, unit: info.unit, pow10: info.pow10 });
      if (p.unit === UNIT.enum) {
        try { p.enums = (await this.request(CMD.requestEnumStrings, [slot.index, ...encode16(p.num)], { priority })).strings; } catch { p.enums = []; }
      }
      if (p.unit === UNIT.hasStrings || p.unit === UNIT.confirm) await this.refreshValueString(slot, p, priority);
      p.loaded = true;
      this.emit('slot', slot.index);
      return p;
    })().finally(() => { p.loading = null; });
    return p.loading;
  }
  async refreshValueString(slot, p, priority = 0) {
    try {
      p.valueString = (await this.request(CMD.requestParameterValueString, [slot.index, ...encode16(p.num)], { priority })).text;
      this.emit('values', slot.index);
    } catch { /* ignore */ }
  }

  // ---- editing ----------------------------------------------------------
  // Sets are fire-and-forget and coalesced so a fast encoder doesn't flood the module.
  setValue(slot, p, value) {
    value = Math.max(p.min, Math.min(p.max, Math.round(value)));
    if (value === p.value) return;
    p.value = value;
    const key = `${slot.index}:${p.num}`;
    this.recentEdits.set(key, Date.now());
    this.pendingSets.set(key, [slot.index, p.num, value]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flushSets(), 8);
    if (p.unit === UNIT.hasStrings || p.unit === UNIT.confirm) {
      clearTimeout(p.vsTimer);
      p.vsTimer = setTimeout(() => this.refreshValueString(slot, p), 60);
    }
    this.emit('values', slot.index);
  }
  _flushSets() {
    this.flushTimer = null;
    for (const [s, num, v] of this.pendingSets.values()) this.t.send(buildMessage(this.id, CMD.setParameterValue, [s, ...encode16(num), ...encode16(v)]));
    this.pendingSets.clear();
  }
  // Ask the module to show this parameter on its own screen (best effort; firmware 1.10+).
  focus(slot, p) {
    this.t.send(buildMessage(this.id, CMD.setFocus, [slot.index, ...encode16(p.num)]));
  }

  // ---- keeping in sync with knob turns / preset loads on the module ------
  async pollValues(slotIndex) {
    const slot = this.slots[slotIndex];
    if (!slot || this.queue[0].length) return;
    const res = await this.request(CMD.requestAllParameterValues, [slotIndex]);
    const now = Date.now();
    let changed = false;
    res.values.forEach((v, k) => {
      const p = slot.params[k];
      if (!p) return;
      if (now - (this.recentEdits.get(`${slotIndex}:${k}`) ?? 0) < 600) return;
      if (p.value !== v.value || p.disabled !== v.disabled) {
        p.value = v.value; p.disabled = v.disabled; changed = true;
        if (p.unit === UNIT.hasStrings || p.unit === UNIT.confirm) this.refreshValueString(slot, p, 1);
      }
    });
    if (changed) this.emit('values', slotIndex);
  }
  // Cheap check for preset/slot changes made on the module itself.
  async presetChanged() {
    const name = await this.request(CMD.requestPresetName);
    const n = await this.request(CMD.requestNumAlgorithmsInPreset);
    if (name !== this.presetName || n !== this.slots.length) return true;
    for (let i = 0; i < n; i++) {
      const alg = await this.request(CMD.requestAlgorithm, [i], { priority: 1 });
      if (alg.guid !== this.slots[i].guid || alg.name !== this.slots[i].name) return true;
    }
    return false;
  }

  // ---- algorithm library --------------------------------------------------
  // Every algorithm the module knows (built-ins + plug-ins), loaded once and cached.
  async loadLibrary(onProgress = () => {}) {
    if (this.library?.complete) return this.library.items;
    if (this.libraryLoading) return this.libraryLoading;
    this.library = { items: [], complete: false };
    this.libraryLoading = (async () => {
      const n = await this.request(CMD.requestNumAlgorithms);
      for (let i = 0; i < n; i++) {
        try { this.library.items.push(await this.request(CMD.requestAlgorithmInfo, encode16(i), { priority: 1, keep: true })); onProgress(this.library.items); }
        catch { /* skip */ }
      }
      this.library.complete = true;
      return this.library.items;
    })().finally(() => { this.libraryLoading = null; });
    return this.libraryLoading;
  }

  // ---- preset structure ---------------------------------------------------
  // Structural commands have no reply; give the module a moment, then re-read everything.
  async _thenReload(ms = 400) { await new Promise((r) => setTimeout(r, ms)); return this.load(); }
  async addAlgorithm(guid, specs = []) {
    await this.command(CMD.addAlgorithm, [...[...guid.padEnd(4)].map((c) => c.charCodeAt(0) & 127), ...specs.flatMap(encode16)]);
    return this._thenReload(600);
  }
  async removeSlot(i) { await this.command(CMD.removeAlgorithm, [i]); return this._thenReload(); }
  async moveSlot(from, to) {
    // one step at a time, which every firmware accepts
    const dir = Math.sign(to - from);
    for (let i = from; i !== to; i += dir) await this.command(CMD.moveAlgorithm, [i, i + dir]);
    return this._thenReload(300);
  }
  async duplicateSlot(i) {
    const src = this.slots[i];
    let specs = src.specs;
    if (!specs) specs = (await this.loadLibrary()).find((a) => a.guid === src.guid)?.specs.map((sp) => sp.def) ?? [];
    const values = src.params.map((p) => p.value);
    const name = src.name;
    await this.command(CMD.addAlgorithm, [...[...src.guid].map((c) => c.charCodeAt(0) & 127), ...specs.flatMap(encode16)]);
    await new Promise((r) => setTimeout(r, 600));
    const n = await this.request(CMD.requestNumAlgorithmsInPreset);
    const added = n - 1;
    for (let k = 0; k < values.length; k++) await this.command(CMD.setParameterValue, [added, ...encode16(k), ...encode16(values[k])]);
    if (name) await this.command(CMD.setSlotName, [added, ...[...name].map((c) => c.charCodeAt(0) & 127), 0]);
    for (let k = added; k > i + 1; k--) await this.command(CMD.moveAlgorithm, [k, k - 1]);
    return this._thenReload(300);
  }
  async renameSlot(i, name) { await this.command(CMD.setSlotName, [i, ...[...name].map((c) => c.charCodeAt(0) & 127), 0]); }
  async newPreset() { await this.command(CMD.newPreset); return this._thenReload(); }
  async loadPreset(path, append = false) {
    await this.command(CMD.loadPreset, [append ? 1 : 0, ...[...path].map((c) => c.charCodeAt(0) & 127), 0]);
    return this._thenReload(1200);
  }
  async savePreset() { await this.command(CMD.savePreset, [2]); }

  // ---- SD card -------------------------------------------------------------
  async listDir(path) {
    const payload = [1, ...[...path].map((c) => c.charCodeAt(0) & 127)];
    const sum = (-payload.reduce((a, b) => a + b, 0)) & 0x7f;
    const res = await this.request(CMD.sdCard, [...payload, sum]);
    return res.entries;
  }

  // ---- mappings ------------------------------------------------------------
  async getMapping(slot, p) { return (await this.request(CMD.requestMappings, [slot.index, ...encode16(p.num)])).mapping; }
  async setMapping(slot, p, kind, m) {
    const cmd = { cv: CMD.setCvMapping, midi: CMD.setMidiMapping, i2c: CMD.setI2cMapping }[kind];
    await this.command(cmd, [slot.index, ...encode16(p.num), m.version & 127, ...encodeMapping(kind, m)]);
  }

  // ---- performance page ------------------------------------------------------
  async getPerfItems(max = 30) {
    const items = [];
    for (let i = 0; i < max; i++) {
      try { items.push(await this.request(CMD.requestPerfPageItem, [i])); }
      catch (e) { if (i === 0) throw e; break; }
    }
    return items;
  }
  async setPerfItem(item) {
    const body = [1, item.index & 127];
    if (!item.enabled) body.push(0);
    else {
      const str = (t) => [...String(t ?? '').slice(0, 15)].map((c) => c.charCodeAt(0) & 127).concat(0);
      body.push(1, item.slot & 127, ...encode16(item.num), ...encode16(item.min), ...encode16(item.max), ...str(item.upper), ...str(item.lower));
    }
    await this.command(CMD.setPerfPageItem, body);
  }

  // ---- front panel -----------------------------------------------------------
  screenshot() { return this.request(CMD.takeScreenshot, [], { priority: 0 }); }
  // index: 0-3 buttons 1-4, 4-6 left/centre/right pot press, 7-8 left/right encoder press
  remotePress(index, down) { return this.command(CMD.remoteControl, [down ? 1 : 2, index]); }
  remoteEncoder(index, delta) { return this.command(CMD.remoteControl, [3, index, Math.max(-64, Math.min(63, delta)) & 127]); }
  remotePot(index, value) { value = Math.max(0, Math.min(4095, value | 0)); return this.command(CMD.remoteControl, [4, index, value & 127, value >> 7]); }
  cpu() { return this.request(CMD.requestCpuUsage); }

  // Every algorithm has a "Bypass" parameter; find it by name.
  async bypassParam(slot, priority = 0) {
    const gen = this.gen;
    let p = slot.params.find((q) => q.loaded && /^bypass$/i.test(q.name));
    if (p) return p;
    // usually near the end of the list, so search backwards
    for (const q of [...slot.params].reverse()) {
      if (this.gen !== gen) return null; // preset changed underneath us
      await this.loadParam(slot, q, priority);
      if (/^bypass$/i.test(q.name)) return q;
    }
    return null;
  }

  // ---- notes into the NT (its synth algorithms listen on USB MIDI) -------
  noteOn(ch, note, vel) { this.t.send([0x90 | (ch & 15), note & 127, vel & 127]); }
  noteOff(ch, note) { this.t.send([0x80 | (ch & 15), note & 127, 0]); }
  pressure(ch, note, v) { this.t.send([0xa0 | (ch & 15), note & 127, v & 127]); }
}

// Human-readable value text for the display.
export function formatValue(nt, p) {
  if (!p.loaded) return '…';
  if (p.unit === UNIT.enum && p.enums?.length) {
    // strings cover min..max; most enums start at 0, bus selectors often at 1
    const i = p.enums.length === p.max - p.min + 1 ? p.value - p.min : p.value;
    return p.enums[i] ?? String(p.value);
  }
  if ((p.unit === UNIT.hasStrings || p.unit === UNIT.confirm) && p.valueString) return p.valueString;
  if (p.unit === UNIT.text) return 'text';
  const n = p.pow10 ? (p.value * 10 ** p.pow10).toFixed(-p.pow10) : String(p.value);
  const u = p.unit > 0 && p.unit !== UNIT.enum ? (nt.units[p.unit - 1] ?? '').trim() : '';
  const short = { semitones: 'st', 'MIDI note': '', frames: 'fr' }[u] ?? u;
  return short ? `${n} ${short}` : n;
}
