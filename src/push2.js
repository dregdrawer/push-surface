// Ableton Push 2 driver: MIDI (User Port) + USB display.
// Reference: Ableton "Push 2 MIDI and Display Interface Manual" (github.com/Ableton/push-interface).
import { EventEmitter } from 'node:events';

export const CC = {
  upper: [102, 103, 104, 105, 106, 107, 108, 109], // buttons above the display
  lower: [20, 21, 22, 23, 24, 25, 26, 27], // buttons below the display
  encoders: [71, 72, 73, 74, 75, 76, 77, 78],
  master: 79, tempo: 14, swing: 15,
  left: 44, right: 45, up: 46, down: 47,
  pageLeft: 62, pageRight: 63,
  octaveDown: 54, octaveUp: 55,
  shift: 49, select: 48, delete: 118, undo: 119,
  setup: 30, user: 59, device: 110, browse: 111, mix: 112,
  scale: 58, layout: 31, note: 50, session: 51, accent: 57,
  addDevice: 52, addTrack: 53, clip: 113, automate: 89, newBtn: 87, duplicate: 88, record: 86, play: 85,
  mute: 60, solo: 61, fixedLength: 90, quantize: 116, doubleLoop: 117, convert: 35, tapTempo: 3, metronome: 9,
};
// Touch notes for encoders: 0-7 track encoders, 8 master, 9 swing, 10 tempo.
export const TOUCH = { master: 8, swing: 9, tempo: 10 };

// Our own LED palette entries (indices 1-12), written at startup so colours are predictable.
export const COLOR = {
  off: 0, white: 1, dim: 2, faint: 3, accent: 4, accentDim: 5, root: 6, pad: 7, padLit: 8, warn: 9,
};
const PALETTE = {
  [COLOR.white]: [255, 255, 255, 255],
  [COLOR.dim]: [70, 70, 70, 70],
  [COLOR.faint]: [18, 18, 18, 18],
  [COLOR.accent]: [255, 110, 20, 120], // amber, matches the screen accent
  [COLOR.accentDim]: [60, 22, 4, 30],
  [COLOR.root]: [140, 140, 150, 140],
  [COLOR.pad]: [22, 22, 26, 20],
  [COLOR.padLit]: [255, 110, 20, 120],
  [COLOR.warn]: [255, 20, 20, 40],
};

const SYSEX_HEAD = [0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01];

export class Push2 extends EventEmitter {
  constructor(midiLib) {
    super();
    this.midi = midiLib;
    this.leds = new Map();
  }

  open() {
    const input = new this.midi.Input();
    const output = new this.midi.Output();
    const find = (port, re) => {
      for (let i = 0; i < port.getPortCount(); i++) if (re.test(port.getPortName(i))) return i;
      return -1;
    };
    // Prefer the User Port so Live (if open) keeps the Live Port; fall back to any Push 2 port.
    let i = find(input, /Push 2.*User|User Port.*Push|MIDIIN2 \(Ableton Push 2\)/i);
    if (i < 0) i = find(input, /Push 2/i);
    let o = find(output, /Push 2.*User|User Port.*Push|MIDIOUT2 \(Ableton Push 2\)/i);
    if (o < 0) o = find(output, /Push 2/i);
    if (i < 0 || o < 0) throw new Error('Ableton Push 2 MIDI port not found — is it plugged in and powered?');
    this.portName = input.getPortName(i);
    input.ignoreTypes(false, true, true);
    input.on('message', (_dt, m) => this._onMidi(m));
    input.openPort(i);
    output.openPort(o);
    this.in = input; this.out = output;
    this.takeOver();
  }

  // Put the Push in User mode with our colours. Also used to take it back after Ableton Live
  // has switched it to Live mode.
  takeOver() {
    if (!this.out) return;
    this.sysex([0x0a, 0x01]); // MIDI mode: User
    this.sysex([0x1e, 0x01]); // aftertouch: polyphonic
    for (const [idx, [r, g, b, w]] of Object.entries(PALETTE)) {
      this.sysex([0x03, +idx, r & 127, r >> 7, g & 127, g >> 7, b & 127, b >> 7, w & 127, w >> 7]);
    }
    this.sysex([0x05]); // reapply palette
    this.clearLeds();
  }

  close() {
    try { this.clearLeds(); this.sysex([0x0a, 0x00]); } catch { /* port may be gone */ }
    this.in?.closePort(); this.out?.closePort();
    this.display?.close();
  }

  sysex(body) { this.out?.sendMessage([...SYSEX_HEAD, ...body, 0xf7]); }

  _onMidi(m) {
    const [st, d1, d2] = m;
    const type = st & 0xf0;
    if (type === 0xb0) {
      const enc = CC.encoders.indexOf(d1);
      const delta = d2 < 64 ? d2 : d2 - 128; // relative, two's complement
      if (enc >= 0) return this.emit('encoder', enc, delta);
      if (d1 === CC.master) return this.emit('encoder', 'master', delta);
      if (d1 === CC.tempo) return this.emit('encoder', 'tempo', delta);
      if (d1 === CC.swing) return this.emit('encoder', 'swing', delta);
      return this.emit(d2 ? 'buttonDown' : 'buttonUp', d1);
    }
    if (type === 0x90 || type === 0x80) {
      const vel = type === 0x80 ? 0 : d2;
      if (d1 <= 10) {
        const key = d1 < 8 ? d1 : { 8: 'master', 9: 'swing', 10: 'tempo' }[d1];
        return this.emit('touch', key, vel > 0);
      }
      if (d1 >= 36 && d1 <= 99) {
        const n = d1 - 36;
        return this.emit(vel ? 'padDown' : 'padUp', n % 8, Math.floor(n / 8), vel);
      }
      return;
    }
    if (type === 0xa0 && d1 >= 36 && d1 <= 99) {
      const n = d1 - 36;
      return this.emit('padPressure', n % 8, Math.floor(n / 8), d2);
    }
    if (type === 0xe0) return this.emit('pitchbend', (d2 << 7) | d1);
  }

  // LEDs are cached so we only send changes.
  button(cc, color) { this._led(0xb0, cc, color); }
  pad(x, y, color) { this._led(0x90, 36 + y * 8 + x, color); }
  _led(st, n, v) {
    if (!this.out) return; // not connected yet
    const k = st * 256 + n;
    if (this.leds.get(k) === v) return;
    this.leds.set(k, v);
    this.out.sendMessage([st, n, v]);
  }
  clearLeds() {
    this.leds.clear();
    if (!this.out) return;
    for (let n = 36; n <= 99; n++) this.out.sendMessage([0x90, n, 0]);
    for (let c = 0; c < 128; c++) this.out.sendMessage([0xb0, c, 0]);
  }
}

// ---- display ----------------------------------------------------------
export const WIDTH = 960, HEIGHT = 160;
const LINE = 2048; // 960 px * 2 bytes + 128 filler
const FRAME_HEADER = Buffer.from([0xff, 0xcc, 0xaa, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const XOR = [0xe7, 0xf3, 0xe7, 0xff];

// RGBA (canvas) → Push 2 frame: BGR565 little-endian, each line XOR-shaped.
export function toFrame(rgba, out = Buffer.alloc(HEIGHT * LINE)) {
  for (let y = 0; y < HEIGHT; y++) {
    const lo = y * LINE;
    for (let x = 0; x < WIDTH; x++) {
      const s = (y * WIDTH + x) * 4;
      const v = (rgba[s] >> 3) | ((rgba[s + 1] >> 2) << 5) | ((rgba[s + 2] >> 3) << 11);
      const d = lo + x * 2;
      out[d] = (v & 0xff) ^ XOR[d & 3];
      out[d + 1] = (v >> 8) ^ XOR[(d + 1) & 3];
    }
    for (let d = lo + WIDTH * 2; d < lo + LINE; d++) out[d] = XOR[d & 3];
  }
  return out;
}

export class Push2Display {
  constructor(usbLib) { this.usb = usbLib.usb ?? usbLib; this.busy = false; }
  async open() {
    const dev = await this.usb.findDeviceByIds(0x2982, 0x1967);
    if (!dev) throw new Error('Push 2 USB display not found');
    await dev.open();
    if (dev.configuration == null) await dev.selectConfiguration(1);
    await dev.claimInterface(0); // fails if Ableton Live is currently driving the display
    this.dev = dev;
  }
  // Send a frame; drops it if the previous one is still on the wire.
  async send(frame) {
    if (this.busy || !this.dev) return;
    this.busy = true;
    try {
      await this.dev.transferOut(1, FRAME_HEADER);
      for (let o = 0; o < frame.length; o += 16384) await this.dev.transferOut(1, frame.subarray(o, o + 16384));
    } finally { this.busy = false; }
  }
  async close() {
    try { await this.dev?.releaseInterface(0); await this.dev?.close(); } catch { /* ignore */ }
  }
}
