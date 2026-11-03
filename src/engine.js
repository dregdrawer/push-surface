// The Push Surface engine: connects Push 2 and the disting NT, keeps them in sync, and reports status.
// Used by the command line (main.js) and by the Mac app window (app/main.mjs).
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import midi from '@julusian/midi';
import * as usb from 'usb';
import { createCanvas } from '@napi-rs/canvas';
import { DistingNT } from './nt.js';
import { Push2, Push2Display, toFrame, WIDTH, HEIGHT } from './push2.js';
import { Controller } from './controller.js';
import { render } from './render.js';
import { FakeNT, realPreset } from './sim.js';

export const DEFAULTS = { ntPort: 'disting NT', sysExId: 0, noteChannel: 1, pollMs: 250, display: true };
export function loadConfig(path) {
  return { ...DEFAULTS, ...(path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) };
}

// A USB MIDI device found by port name
class MidiTransport extends EventEmitter {
  constructor(portMatch, { sysexOnly = false, avoid = null } = {}) {
    super();
    this.re = new RegExp(portMatch, 'i');
    this.avoid = avoid;
    this.in = new midi.Input(); this.out = new midi.Output();
    this.in.ignoreTypes(false, true, true);
    this.in.on('message', (_dt, m) => { if (!sysexOnly || m[0] === 0xf0) this.emit('message', m); });
    this.open = false;
  }
  find(port) {
    let fallback = -1;
    for (let i = 0; i < port.getPortCount(); i++) {
      const name = port.getPortName(i);
      if (!this.re.test(name)) continue;
      if (this.avoid && this.avoid.test(name)) { if (fallback < 0) fallback = i; continue; }
      return i;
    }
    return fallback;
  }
  tryOpen() {
    const i = this.find(this.in), o = this.find(this.out);
    if (i < 0 || o < 0) return false;
    this.in.openPort(i); this.out.openPort(o);
    this.name = this.in.getPortName(i);
    this.open = true;
    return true;
  }
  stillThere() { return this.find(this.out) >= 0; }
  close() { if (this.open) { this.in.closePort(); this.out.closePort(); } this.open = false; }
  send(bytes) { if (this.open) this.out.sendMessage(bytes); }
}

// A simulated disting NT whose algorithms are rebuilt from the manual
class DemoTransport extends FakeNT {
  constructor(log) {
    super(realPreset('Grain cloud'), 0, { real: true });
    this.logFn = log; this.open = false; this.name = 'simulated disting NT';
  }
  tryOpen() { this.open = true; return true; }
  stillThere() { return true; }
  close() { this.open = false; }
  send(bytes) {
    const t = bytes[0] & 0xf0;
    if (t === 0x90) this.logFn(`note on  ${bytes[1]} vel ${bytes[2]}`);
    else if (t === 0x80) this.logFn(`note off ${bytes[1]}`);
    super.send(bytes);
  }
}

export class Engine extends EventEmitter {
  constructor(cfg, { demo = false } = {}) {
    super();
    this.cfg = cfg; this.demo = demo;
    this.timers = [];
    this.state = { push: 'waiting', screen: cfg.display ? 'waiting' : 'off', nt: demo ? 'demo' : 'searching', ntPort: '', preset: '', slots: 0, slot: '', mode: demo ? 'demo' : 'live' };
  }
  log(...a) { const line = `${new Date().toLocaleTimeString()} ${a.join(' ')}`; console.log(line); this.emit('log', line); }
  set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) if (this.state[k] !== v) { this.state[k] = v; changed = true; }
    if (changed) this.emit('status', { ...this.state });
  }
  every(ms, fn) { this.timers.push(setInterval(fn, ms)); }

  async start() {
    const cfg = this.cfg;
    this.push = new Push2(midi);
    this.transport = this.demo ? new DemoTransport((m) => this.log(m)) : new MidiTransport(cfg.ntPort, { sysexOnly: true });
    if (this.demo) this.log('Demo mode — simulated disting NT');
    this.nt = new DistingNT(this.transport, { sysExId: cfg.sysExId });
    this.canvas = createCanvas(WIDTH, HEIGHT);
    this.ctx = this.canvas.getContext('2d');
    this.dirty = true;
    this.ctrl = new Controller(this.nt, this.push, {
      noteChannel: Math.max(0, cfg.noteChannel - 1),
      onChange: () => { this.dirty = true; this.reportPreset(); },
      onReload: () => this.reload('Setup pressed'),
    });

    // Push: wait for it rather than giving up
    if (!this.openPush()) this.every(2000, () => { if (this.state.push !== 'connected') this.openPush(); });
    // Push screen: the link can hiccup (macOS kIOReturnNotReady) or be held by Ableton Live; keep retrying
    this.display = null; this.displayErrors = 0;
    await this.openDisplay(true);
    this.every(3000, () => { if (!this.display && cfg.display) this.openDisplay(); });
    // redraw at most 30 fps; resend at least every 500 ms (the screen blanks after ~2 s without frames)
    this.frame = Buffer.alloc(HEIGHT * 2048); this.lastSent = 0;
    this.every(33, () => this.drawFrame());
    // disting NT connect / disconnect
    this.loading = false;
    this.every(1500, () => this.checkNt());
    this.checkNt();
    // follow knob turns and preset changes made on the module itself
    this.every(cfg.pollMs, () => { const nt = this.nt; if (nt.connected && !this.loading && !nt.loadingNow) nt.pollValues(this.ctrl.slot).catch(() => {}); });
    this.every(2000, async () => {
      const nt = this.nt;
      if (!nt.connected || this.loading || nt.loadingNow || Date.now() - nt.lastCommand < 3000) return;
      try { if (await nt.presetChanged()) this.reload('preset changed on module'); } catch { /* busy */ }
    });
    if (!this.demo) {
      try {
        const names = (p) => Array.from({ length: p.getPortCount() }, (_, i) => p.getPortName(i));
        this.log(`MIDI inputs: ${names(new midi.Input()).join(', ') || 'none'} · outputs: ${names(new midi.Output()).join(', ') || 'none'}`);
      } catch { /* no MIDI */ }
    }
    this.log('Running');
    this.emit('status', { ...this.state });
  }

  openPush() {
    try {
      this.push.open();
      this.set({ push: 'connected' });
      this.log(`Push 2 connected on "${this.push.portName}" (User mode)`);
      this.ctrl.changed();
      return true;
    } catch {
      this.set({ push: 'waiting' });
      return false;
    }
  }
  async openDisplay(first = false) {
    if (!this.cfg.display || this.reopening) return;
    this.reopening = true;
    try {
      await this.display?.close();
      this.display = new Push2Display(usb);
      await this.display.open();
      this.displayErrors = 0; this.dirty = true;
      this.set({ screen: 'connected' });
      this.log(first ? 'Push 2 screen connected' : 'Push 2 screen reconnected');
    } catch (e) {
      this.display = null;
      // "not found" = no Push on USB; anything else usually means Ableton Live holds the screen
      this.set({ screen: /not found/i.test(e.message) ? 'waiting' : 'busy' });
      if (first) this.log(`Push 2 screen unavailable (${e.message}) — retrying`);
    } finally { this.reopening = false; }
  }
  drawFrame() {
    if (!this.display) return;
    const now = Date.now();
    if (!this.dirty && now - this.lastSent < 500) return;
    if (this.dirty) { render(this.ctx, this.ctrl.view()); toFrame(this.ctx.getImageData(0, 0, WIDTH, HEIGHT).data, this.frame); this.dirty = false; }
    this.lastSent = now;
    this.display.send(this.frame).then(() => { this.displayErrors = 0; }).catch((e) => {
      this.dirty = true;
      if (++this.displayErrors >= 5) { this.log(`screen error (${e.message}) — reconnecting`); this.display = null; this.set({ screen: 'waiting' }); this.openDisplay(); }
    });
  }
  checkNt() {
    const t = this.transport;
    if (!t.open) {
      if (t.tryOpen()) {
        this.set({ nt: this.demo ? 'demo' : 'connected', ntPort: t.name });
        this.log(this.demo ? 'Simulated disting NT ready' : `disting NT connected on "${t.name}"`);
        this.ctrl.status = 'Reading preset…'; this.dirty = true;
        this.reload();
      }
      return;
    }
    if (!t.stillThere()) {
      t.close(); this.nt.connected = false;
      this.ctrl.status = 'Looking for disting NT…'; this.dirty = true;
      this.set({ nt: 'searching', ntPort: '', preset: '', slots: 0, slot: '' });
      this.log('disting NT disconnected');
    }
  }
  async reload(why) {
    // take the Push (and its screen) back in case Ableton Live grabbed them
    if (this.state.push === 'connected') { this.push.takeOver(); this.ctrl.changed(); this.dirty = true; }
    if (this.cfg.display && this.state.screen !== 'connected') { this.display = null; this.openDisplay(); }
    if (this.loading || !this.transport.open) return;
    this.loading = true;
    this.log(`Loading preset${why ? ` (${why})` : ''}…`);
    try {
      const keep = { slot: this.ctrl.slot, page: this.ctrl.page };
      await this.nt.load();
      Object.assign(this.ctrl, keep); this.ctrl.clamp(); this.ctrl.prefetch();
      this.set({ nt: this.demo ? 'demo' : 'connected' });
      this.log(`"${this.nt.presetName}" — ${this.nt.slots.map((s) => s.name).join(', ') || 'empty'}`);
    } catch (e) {
      this.ctrl.status = 'disting NT not answering — check the SysEx ID setting';
      this.set({ nt: 'silent' });
      this.log(e.message);
    } finally { this.loading = false; this.dirty = true; this.reportPreset(); }
  }
  reportPreset() {
    const nt = this.nt;
    if (!nt) return;
    this.set({ preset: nt.connected ? nt.presetName : '', slots: nt.slots.length, slot: this.ctrl.curSlot?.name ?? '' });
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ctrl?.stopTimers();
    try { this.push?.close(); } catch { /* already gone */ }
    try { await this.display?.close(); } catch { /* already gone */ }
    try { this.transport?.close(); } catch { /* already gone */ }
    this.log('Stopped');
  }
}
