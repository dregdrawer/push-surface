// A fake disting NT that answers the SysEx protocol, for testing without hardware.
import { EventEmitter } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { CMD, encode16, decode16, parseMessage, decodeMapping, encodeMapping } from './nt.js';

// the module speaks 7-bit ASCII
const ASCII_MAP = { 'Ω': 'Ohm', 'µ': 'u', '°': 'deg', '→': '->', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '×': 'x' };
const ascii = (s) => [...String(s)].flatMap((c) => [...(ASCII_MAP[c] ?? (c.charCodeAt(0) < 128 ? c : '?'))]).map((c) => c.charCodeAt(0) & 0x7f).concat(0);
const reply = (id, cmd, body) => [0xf0, 0x00, 0x21, 0x27, 0x6d, id, cmd, ...body, 0xf7];

export const UNITS = ['dB', 'dB', '%', 'Hz', 'semitones', 'cents', 'ms', 's', 'frames', 'MIDI note', 'BPM', 'deg', 'V'];

export function demoPreset() {
  const p = (name, min, max, def, unit = 0, pow10 = 0, enums) => ({ name, min, max, def, unit, pow10, value: def, enums });
  return {
    name: 'Dub chords',
    slots: [
      { guid: 'pywt', name: 'Poly Wavetable', pages: [
        { name: 'Wavetable', params: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
        { name: 'Envelope', params: [10, 11, 12, 13] },
        { name: 'Filter', params: [14, 15, 16] },
        { name: 'Setup', params: [17, 18] },
      ], params: [
        p('Wavetable', 0, 40, 3, 16), p('Wave offset', -100, 100, 0, 3), p('Wave spread', 0, 100, 20, 3),
        p('Coarse tune', -36, 36, 0, 5), p('Fine tune', -100, 100, 0, 6), p('Mod wheel', 0, 100, 0, 3),
        p('Voices', 1, 14, 8), p('Unison', 1, 8, 1), p('Spread', 0, 1000, 120, 6, -1), p('Detune', 0, 100, 10, 6),
        p('Attack', 0, 1000, 50, 7), p('Decay', 0, 1000, 800, 7), p('Sustain', 0, 100, 60, 3), p('Release', 0, 1000, 1500, 7),
        p('Filter type', 0, 3, 1, 1, 0, ['Off', 'Lowpass', 'Bandpass', 'Highpass']), p('Cutoff', 0, 127, 72, 10), p('Resonance', 0, 100, 25, 3),
        p('MIDI channel', 1, 16, 1), p('Output', 0, 28, 13, 1, 0, Array.from({ length: 29 }, (_, i) => (i === 0 ? 'None' : i <= 12 ? `Input ${i}` : i <= 20 ? `Output ${i - 12}` : `Aux ${i - 20}`))),
      ] },
      { guid: 'revc', name: 'Reverb (Clouds)', pages: [{ name: 'Reverb', params: [0, 1, 2, 3, 4] }, { name: 'Routing', params: [5, 6] }], params: [
        p('Mix', 0, 100, 35, 3), p('Size', 0, 100, 80, 3), p('Decay', 0, 100, 70, 3), p('Diffusion', 0, 100, 60, 3), p('Gain', -400, 60, 0, 2, -1),
        p('Input', 0, 28, 13, 1, 0, ['None', ...Array.from({ length: 28 }, (_, i) => `Bus ${i + 1}`)]), p('Output', 0, 28, 13, 1, 0, ['None', ...Array.from({ length: 28 }, (_, i) => `Bus ${i + 1}`)]),
      ] },
      { guid: 'dels', name: 'Delay (Stereo)', pages: [{ name: 'Delay', params: [0, 1, 2] }], params: [p('Time', 1, 2000, 375, 7), p('Feedback', 0, 100, 55, 3), p('Mix', 0, 100, 30, 3)] },
      { guid: 'lfo ', name: 'LFO', pages: [{ name: 'LFO', params: [0, 1, 2] }], params: [p('Speed', -1000, 1000, 0), p('Shape', 0, 4, 0, 1, 0, ['Sine', 'Triangle', 'Saw', 'Square', 'S&H']), p('Amplitude', 0, 100, 50, 13, -1)] },
    ],
  };
}

// Algorithms the simulated module can add, with their specifications.
const P = (name, min, max, def, unit = 0, pow10 = 0, enums) => ({ name, min, max, def, unit, pow10, value: def, enums });
const BUSES = ['None', ...Array.from({ length: 12 }, (_, i) => `Input ${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `Output ${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `Aux ${i + 1}`)];
export const LIBRARY = [
  { guid: 'pywt', name: 'Poly Wavetable', specs: [{ name: 'Max voices', min: 1, max: 14, def: 8, type: 0 }] },
  { guid: 'revc', name: 'Reverb (Clouds)', specs: [] },
  { guid: 'dels', name: 'Delay (Stereo)', specs: [] },
  { guid: 'lfo ', name: 'LFO', specs: [{ name: 'Channels', min: 1, max: 8, def: 1, type: 0 }] },
  { guid: 'vcf ', name: 'VCF (State Variable)', specs: [] },
  { guid: 'quan', name: 'Quantizer', specs: [{ name: 'Channels', min: 1, max: 12, def: 1, type: 0 }] },
  { guid: 'clck', name: 'Clock', specs: [] },
  { guid: 'eucp', name: 'Euclidean Patterns', specs: [{ name: 'Channels', min: 1, max: 8, def: 4, type: 0 }] },
  { guid: 'mix2', name: 'Mixer Stereo', specs: [{ name: 'Channels', min: 1, max: 12, def: 4, type: 0 }] },
  { guid: 'gran', name: 'Granulator', specs: [] },
  { guid: 'loop', name: 'Looper', specs: [] },
  { guid: 'tune', name: 'Tuner (Fancy)', specs: [] },
  { guid: 'Mrbl', name: 'Marbles (plug-in)', specs: [], isPlugin: true },
].map((a) => ({ ...a, specs: a.specs.map((sp) => ({ ...sp })) }));
function makeSlot(guid, specs = []) {
  const demo = demoPreset().slots.find((s) => s.guid === guid);
  if (demo) return addBypass(structuredClone(demo));
  const name = LIBRARY.find((a) => a.guid === guid)?.name ?? guid;
  const n = specs[0] ?? 2;
  const params = [P('Level', -400, 60, 0, 2, -1), P('Rate', 0, 1000, 250, 4, -1), P('Depth', 0, 100, 50, 3),
    ...Array.from({ length: n }, (_, i) => P(`Ch ${i + 1} amount`, 0, 100, 50, 3)), P('Input', 0, 28, 1, 1, 0, BUSES), P('Output', 0, 28, 13, 1, 0, BUSES)];
  const io = [params.length - 2, params.length - 1];
  return addBypass({ guid, name, specs, params, pages: [{ name: 'Main', params: [0, 1, 2] }, { name: 'Channels', params: params.slice(3, -2).map((_, i) => i + 3) }, { name: 'Routing', params: io }] });
}
function addBypass(slot) {
  if (!slot.params.some((p) => p.name === 'Bypass')) {
    slot.params.push(P('Bypass', 0, 1, 0, 1, 0, ['Off', 'On']));
    slot.pages.at(-1).params.push(slot.params.length - 1);
  }
  return slot;
}
const PRESETS = {
  'Dub chords': () => demoPreset().slots.map((s) => addBypass(s)),
  'Techno kit': () => ['clck', 'eucp', 'vcf ', 'dels'].map((g) => makeSlot(g)),
  'Ambient wash': () => ['gran', 'revc', 'lfo ', 'mix2'].map((g) => makeSlot(g)),
};
const emptyMapping = () => ({ version: 6, source: 0, cvInput: 0, unipolar: false, gate: false, volts: 10, delta: 0, midiCC: 0, midiEnabled: false, midiSymmetric: false, midiChannel: 0, midiRelative: false, midiType: 0, midiMin: 0, midiMax: 0, i2cCC: 0, i2cEnabled: false, i2cSymmetric: false, i2cMin: 0, i2cMax: 0 });

// ---- realistic mode: algorithms rebuilt from the disting NT manual (src/library.json) ----
let REAL = null;
export function realLibrary() {
  REAL ??= JSON.parse(readFileSync(new URL('./library.json', import.meta.url), 'utf8'));
  return REAL;
}
// Build a slot the way the module lays it out: one page per parameter table, per-channel tables
// repeated for each channel set by the specification, plus every algorithm's Bypass parameter.
export function realSlot(guid, specVals) {
  const alg = realLibrary().algorithms.find((a) => a.guid === guid);
  if (!alg) return null;
  const specs = specVals ?? alg.specs.map((sp) => sp.def);
  const params = [], pages = [];
  const add = (q, prefix = '') => { params.push({ ...q, name: prefix + q.name, value: q.def, enums: q.enums ? [...q.enums] : undefined }); return params.length - 1; };
  for (const pg of alg.pages) {
    if (pg.perSpec != null) {
      const n = Math.max(1, specs[pg.perSpec] ?? 1);
      for (let i = 1; i <= n; i++) {
        const name = pg.name.replace(/^Per[- ]\w+/, `${pg.unit} ${i}`);
        pages.push({ name, params: pg.params.map((q) => add(q, n > 1 ? `${i}:` : '')) });
      }
    } else pages.push({ name: pg.name, params: pg.params.map((q) => add(q)) });
  }
  if (!pages.length) pages.push({ name: alg.name, params: [] });
  params.push(P('Bypass', 0, 1, 0, 1, 0, ['Off', 'On']));
  pages.at(-1).params.push(params.length - 1);
  return { guid, name: alg.name, specs, params, pages };
}
const byName = (n) => realLibrary().algorithms.find((a) => a.name.toLowerCase() === n.toLowerCase())?.guid;
const setP = (slot, name, v) => { const p = slot.params.find((q) => q.name === name); if (p) p.value = Math.max(p.min, Math.min(p.max, v)); return slot; };
export const REAL_PRESETS = {
  'Dub chords': () => [
    setP(setP(realSlot('pywt'), 'Filter freq', 60), 'Release', 80),
    setP(realSlot('revc'), 'Reverb mix', 45),
    setP(realSlot('dels', [10]), 'Feedback', 55),
    realSlot('lfo ', [2]),
  ],
  'Grain cloud': () => [
    setP(setP(setP(realSlot('gran', [10]), 'Right input', 2), 'Drone 1 enable', 1), 'Pan spread', 60),
    realSlot('revc'),
    realSlot('lfo ', [1]),
  ],
  'Techno kit': () => [realSlot('clck', [4]), realSlot('eucp', [4]), realSlot(byName('VCF (State Variable)')), realSlot('dels', [4])],
  'Modular utility': () => [realSlot('attn', [4]), realSlot('quan', [2]), realSlot('saho', [2]), realSlot('mix2', [4, 1])],
};
export function realPreset(name = 'Grain cloud') { return { name, slots: REAL_PRESETS[name]() }; }

export class FakeNT extends EventEmitter {
  constructor(preset = demoPreset(), id = 0, { real = false } = {}) {
    super();
    this.real = real;
    if (!real) preset.slots.forEach(addBypass);
    this.preset = preset; this.id = id; this.sent = []; this.log = [];
    this.perf = Array.from({ length: 30 }, (_, index) => ({ index, enabled: false }));
    this.perf[0] = { index: 0, enabled: true, slot: 0, num: 15, min: 0, max: 127, upper: 'Cutoff', lower: 'Poly WT' };
    this.perf[1] = { index: 1, enabled: true, slot: 1, num: 0, min: 0, max: 100, upper: 'Verb mix', lower: 'Clouds' };
    this.perf[2] = { index: 2, enabled: true, slot: 2, num: 1, min: 0, max: 100, upper: 'Feedback', lower: 'Delay' };
    this.ui = { slot: 0, param: 0 };
    if (real) {
      this.perf = Array.from({ length: 30 }, (_, index) => ({ index, enabled: false }));
      const pick = (slot, name, upper) => { const num = preset.slots[slot]?.params.findIndex((q) => q.name === name); return num >= 0 ? { slot, num, min: preset.slots[slot].params[num].min, max: preset.slots[slot].params[num].max, upper, lower: preset.slots[slot].name } : null; };
      [pick(0, 'Size mean', 'Grain size'), pick(0, 'Pitch spread', 'Pitch spr'), pick(1, 'Reverb mix', 'Verb mix')].filter(Boolean)
        .forEach((it, i) => { this.perf[i] = { index: i, enabled: true, ...it }; });
    }
  }
  get library() { return this.real ? realLibrary().algorithms : LIBRARY; }
  get unitList() { return this.real ? realLibrary().units : UNITS; }
  newSlot(guid, specs) { return this.real ? realSlot(guid, specs) : makeSlot(guid, specs); }
  presetSlots(name) { return this.real ? REAL_PRESETS[name]?.() : PRESETS[name]?.(); }
  get presetNames() { return Object.keys(this.real ? REAL_PRESETS : PRESETS); }
  // transport API used by DistingNT
  send(bytes) {
    this.sent.push(bytes);
    const m = parseMessage(bytes);
    if (!m || m.sysExId !== this.id) return;
    const r = this.handle(m.cmd, m.payload);
    const rc = m.cmd === CMD.takeScreenshot ? 0x33 : m.cmd;
    if (r) setImmediate(() => this.emit('message', reply(this.id, rc, r)));
  }
  handle(cmd, b) {
    const P = this.preset, s = P.slots[b[0]];
    const prm = () => s?.params[decode16(b, 1)];
    const str = (a, o) => { let t = ''; while (o < a.length && a[o]) t += String.fromCharCode(a[o++]); return t; };
    switch (cmd) {
      case CMD.requestUnitStrings: return [this.unitList.length, ...this.unitList.flatMap(ascii)];
      case CMD.requestPresetName: return ascii(P.name);
      case CMD.requestNumAlgorithmsInPreset: return [P.slots.length, 12, 8, 8];
      case CMD.requestAlgorithm: return s && [b[0], ...ascii(s.guid).slice(0, 4), ...ascii(s.name), (s.specs ?? []).length, ...(s.specs ?? []).flatMap(encode16)];
      case CMD.requestNumParameters: return s && [b[0], ...encode16(s.params.length)];
      case CMD.requestParameterPages: return s && [b[0], s.pages.length, ...s.pages.flatMap((pg) => [...ascii(pg.name), pg.params.length, ...pg.params.flatMap((n) => [n >> 7, n & 127])])];
      case CMD.requestAllParameterValues: return s && [b[0], ...s.params.flatMap((p) => encode16(p.value))];
      case CMD.requestParameterInfo: { const p = prm(); return p && [b[0], b[1], b[2], b[3], ...encode16(p.min), ...encode16(p.max), ...encode16(p.def), p.unit, ...ascii(p.name), -p.pow10 & 3]; }
      case CMD.requestEnumStrings: { const p = prm(); return p && [b[0], b[1], b[2], b[3], p.enums.length, ...p.enums.flatMap(ascii)]; }
      case CMD.requestParameterValueString: { const p = prm(); return p && [b[0], b[1], b[2], b[3], ...ascii(p.name === 'Wavetable' ? ['Basic', 'Fold', 'Glass', 'Organ', 'Vox'][p.value % 5] + ` ${p.value}` : String(p.value))]; }
      case CMD.setParameterValue: { const p = prm(); if (p) { p.value = decode16(b, 4); this.log.push([b[0], decode16(b, 1), p.value]); } return null; }
      // library & structure
      case CMD.requestNumAlgorithms: return encode16(this.library.length);
      case CMD.requestAlgorithmInfo: {
        const a = this.library[decode16(b, 0)];
        return a && [...encode16(decode16(b, 0)), ...ascii(a.guid).slice(0, 4), a.specs.length, ...a.specs.flatMap((sp) => [...encode16(sp.min), ...encode16(sp.max), ...encode16(sp.def), sp.type ?? 0]), ...ascii(a.name), ...a.specs.flatMap((sp) => ascii(sp.name)), a.isPlugin ? 1 : 0, 1];
      }
      case CMD.addAlgorithm: {
        const guid = String.fromCharCode(...b.slice(0, 4)); const specs = [];
        for (let o = 4; o + 2 < b.length; o += 3) specs.push(decode16(b, o));
        const ns = this.newSlot(guid, specs); if (ns) P.slots.push(ns); this.log.push(['add', guid, specs]); return null;
      }
      case CMD.removeAlgorithm: P.slots.splice(b[0], 1); this.log.push(['remove', b[0]]); return null;
      case CMD.moveAlgorithm: { const [x] = P.slots.splice(b[0], 1); if (x) P.slots.splice(b[1], 0, x); this.log.push(['move', b[0], b[1]]); return null; }
      case CMD.setSlotName: if (s) s.name = str(b, 1); return null;
      case CMD.newPreset: P.name = 'Init'; P.slots = []; return null;
      case CMD.savePreset: this.log.push(['save', P.name]); return null;
      case CMD.loadPreset: {
        const path = str(b, 1), name = path.split('/').pop().replace(/\.json$/i, '');
        const slots = this.presetSlots(name) ?? [this.newSlot(this.real ? 'fsvf' : 'vcf ')];
        if (b[0]) P.slots.push(...slots); else { P.slots = slots; P.name = name; }
        this.log.push(['load', path, !!b[0]]); return null;
      }
      case CMD.sdCard: {
        const path = String.fromCharCode(...b.slice(1, -1)); // opcode, path, checksum
        const files = path.replace(/\/$/, '') === '/presets'
          ? [...this.presetNames.map((n) => [`${n}.json`, 0]), ['Live sets', 0x10]]
          : path.includes('Live sets') ? [['Gig 1.json', 0], ['Gig 2.json', 0]] : [['presets', 0x10], ['samples', 0x10]];
        return [0, 1, ...files.flatMap(([n, a]) => [a, 0, 0, 0, 0, 0, 0, ...Array(10).fill(0), ...ascii(n)])];
      }
      // mappings & performance page
      case CMD.requestMappings: { const p = prm(); if (!p) return null; p.mapping ??= { ...emptyMapping(), midiMax: p.max, midiMin: p.min, i2cMax: p.max, i2cMin: p.min }; return [b[0], b[1], b[2], b[3], 6, ...encodeMapping('cv', p.mapping), ...encodeMapping('midi', p.mapping), ...encodeMapping('i2c', p.mapping)]; }
      case CMD.setCvMapping: case CMD.setMidiMapping: case CMD.setI2cMapping: {
        const p = prm(); if (!p) return null;
        const kind = { [CMD.setCvMapping]: 'cv', [CMD.setMidiMapping]: 'midi', [CMD.setI2cMapping]: 'i2c' }[cmd];
        const cur = p.mapping ?? emptyMapping();
        const parts = { cv: encodeMapping('cv', cur), midi: encodeMapping('midi', cur), i2c: encodeMapping('i2c', cur) };
        parts[kind] = [...b.slice(5)];
        p.mapping = decodeMapping(b[4], [...parts.cv, ...parts.midi, ...parts.i2c]);
        this.log.push(['map', kind, b[0], decode16(b, 1)]); return null;
      }
      case CMD.requestPerfPageItem: {
        const it = this.perf[b[0]]; if (!it) return null;
        if (!it.enabled) return [1, it.index, 0];
        return [1, it.index, 1, it.slot, ...encode16(it.num), ...encode16(it.min), ...encode16(it.max), ...ascii(it.upper), ...ascii(it.lower)];
      }
      case CMD.setPerfPageItem: {
        const idx = b[1];
        if (!(b[2] & 1)) this.perf[idx] = { index: idx, enabled: false };
        else { const up = str(b, 13), lo = str(b, 13 + up.length + 1); this.perf[idx] = { index: idx, enabled: true, slot: b[3], num: decode16(b, 4), min: decode16(b, 7), max: decode16(b, 10), upper: up, lower: lo }; }
        return null;
      }
      // panel
      case CMD.requestCpuUsage: return [20 + Math.round(Math.random() * 10), 12 + Math.round(Math.random() * 6), ...P.slots.map((_, i) => 3 + ((i * 7 + Math.round(Math.random() * 3)) % 15))];
      case CMD.remoteControl: this.remote(b); return null;
      case CMD.takeScreenshot: return this.screen();
      default: return null;
    }
  }
  // left encoder: slot · right encoder: parameter · right pot: value · buttons are logged
  remote(b) {
    const P = this.preset, ui = this.ui;
    if (b[0] === 3) {
      const d = b[2] > 63 ? b[2] - 128 : b[2];
      if (b[1] === 0) { ui.slot = Math.max(0, Math.min(P.slots.length - 1, ui.slot + d)); ui.param = 0; }
      else ui.param = Math.max(0, Math.min((P.slots[ui.slot]?.params.length ?? 1) - 1, ui.param + d));
    } else if (b[0] === 4 && b[1] === 2) {
      const p = P.slots[ui.slot]?.params[ui.param];
      if (p) p.value = Math.round(p.min + ((b[2] | (b[3] << 7)) / 4095) * (p.max - p.min));
    } else if (b[0] === 1) this.log.push(['press', b[1]]);
  }
  screen() {
    const c = this.cv ??= createCanvas(256, 64), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 64);
    const P = this.preset, s = P.slots[this.ui.slot], p = s?.params[this.ui.param];
    g.fillStyle = '#888'; g.font = '9px sans-serif';
    g.fillText(`${P.name}  ·  ${this.ui.slot + 1}/${P.slots.length}`, 4, 10);
    g.fillStyle = '#fff'; g.font = 'bold 14px sans-serif';
    g.fillText(s?.name ?? 'Empty preset', 4, 30);
    if (p) {
      g.font = '12px sans-serif'; g.fillStyle = '#bbb'; g.fillText(p.name, 4, 50);
      g.fillStyle = '#fff'; g.fillText(p.enums ? p.enums[p.enums.length === p.max - p.min + 1 ? p.value - p.min : p.value] ?? p.value : String(p.value), 150, 50);
      g.fillStyle = '#666'; g.fillRect(4, 56, 248, 2); g.fillStyle = '#fff'; g.fillRect(4, 55, 248 * ((p.value - p.min) / Math.max(1, p.max - p.min)), 4);
    }
    const d = g.getImageData(0, 0, 256, 64).data, out = new Array(256 * 64);
    for (let i = 0; i < out.length; i++) out[i] = Math.round((d[i * 4] / 255) * 15);
    return out;
  }
}
