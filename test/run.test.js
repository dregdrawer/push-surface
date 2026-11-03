import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { DistingNT, encode16, decode16, CMD, formatValue } from '../src/nt.js';
import { Controller } from '../src/controller.js';
import { CC, toFrame, WIDTH, HEIGHT } from '../src/push2.js';
import { render } from '../src/render.js';
import { FakeNT, realPreset, realLibrary, realSlot } from '../src/sim.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
class FakePush extends EventEmitter {
  constructor() { super(); this.leds = new Map(); }
  button(cc, c) { this.leds.set(`b${cc}`, c); }
  pad(x, y, c) { this.leds.set(`p${x},${y}`, c); }
}
async function setup() {
  const dev = new FakeNT();
  const nt = new DistingNT(dev, { timeout: 200 });
  const push = new FakePush();
  const ctrl = new Controller(nt, push);
  await nt.load();
  await tick(100);
  return { dev, nt, push, ctrl };
}

test('16-bit encode/decode round trip incl. negatives', () => {
  for (const v of [0, 1, 127, 128, 1000, 16383, 32767, -1, -400, -32768]) assert.equal(decode16(encode16(v), 0), v);
  assert.deepEqual(encode16(375), [0, 2, 119]);
});

test('loads slots, pages, parameter info and enums', async () => {
  const { nt } = await setup();
  assert.equal(nt.presetName, 'Dub chords');
  assert.deepEqual(nt.slots.map((s) => s.name), ['Poly Wavetable', 'Reverb (Clouds)', 'Delay (Stereo)', 'LFO']);
  const pw = nt.slots[0];
  assert.equal(pw.pages[1].name, 'Envelope');
  assert.equal(pw.params[13].name, 'Release');
  assert.equal(formatValue(nt, pw.params[13]), '1500 ms');
  assert.equal(formatValue(nt, pw.params[8]), '12.0 cents');
  assert.equal(formatValue(nt, pw.params[14]), 'Lowpass');
  assert.equal(formatValue(nt, pw.params[0]), 'Organ 3');
  assert.equal(formatValue(nt, nt.slots[1].params[4]), '0.0 dB');
  assert.equal(formatValue(nt, nt.slots[3].params[2]), '5.0 V');
});

test('encoder turns send coalesced set-parameter messages', async () => {
  const { dev, push, ctrl } = await setup();
  push.emit('buttonDown', CC.lower[1]); // Envelope page
  dev.sent.length = 0;
  for (let i = 0; i < 20; i++) push.emit('encoder', 0, 1); // Attack +, range 1000 → 2.5/tick
  await tick();
  const sets = dev.sent.filter((m) => m[6] === CMD.setParameterValue);
  assert.ok(sets.length >= 1 && sets.length < 5, `coalesced (${sets.length})`);
  assert.equal(dev.preset.slots[0].params[10].value, 100); // 50 + 20*2.5
  // shift = fine
  push.emit('buttonDown', CC.shift);
  for (let i = 0; i < 8; i++) push.emit('encoder', 0, -1);
  await tick();
  assert.equal(dev.preset.slots[0].params[10].value, 98);
  push.emit('buttonUp', CC.shift);
  // enum: needs 5 ticks per step
  ctrl.go({ page: 2 });
  for (let i = 0; i < 5; i++) push.emit('encoder', 0, 1);
  await tick();
  assert.equal(dev.preset.slots[0].params[14].value, 2);
  // clamps at max
  for (let i = 0; i < 100; i++) push.emit('encoder', 0, 1);
  await tick();
  assert.equal(dev.preset.slots[0].params[14].value, 3);
});

test('delete + touch resets to default; navigation buttons', async () => {
  const { dev, push, ctrl, nt } = await setup();
  push.emit('buttonDown', CC.lower[1]);
  for (let i = 0; i < 10; i++) push.emit('encoder', 1, 4);
  await tick();
  assert.notEqual(dev.preset.slots[0].params[11].value, 800);
  push.emit('buttonDown', CC.delete);
  push.emit('touch', 1, true);
  await tick();
  assert.equal(dev.preset.slots[0].params[11].value, 800);
  push.emit('buttonUp', CC.delete);

  push.emit('buttonDown', CC.upper[2]);
  assert.equal(ctrl.curSlot.name, 'Delay (Stereo)');
  assert.equal(ctrl.page, 0);
  push.emit('buttonDown', CC.left);
  assert.equal(ctrl.curSlot.name, 'Reverb (Clouds)');
  // first page has 10 params → second press of the same page button shows params 9-10
  push.emit('buttonDown', CC.upper[0]);
  push.emit('buttonDown', CC.lower[0]);
  assert.equal(ctrl.scroll, 1);
  assert.deepEqual(ctrl.visible().map((p) => p.name), ['Spread', 'Detune']);
  // LEDs: 4 slots lit, selected one accent
  assert.equal(push.leds.get(`b${CC.upper[0]}`), 4);
  assert.equal(push.leds.get(`b${CC.upper[3]}`), 2);
  assert.equal(push.leds.get(`b${CC.upper[4]}`), 0);
  assert.ok(nt.connected);
});

test('pads play notes into the NT', async () => {
  const { dev, push } = await setup();
  dev.sent.length = 0;
  push.emit('padDown', 0, 0, 100);
  push.emit('padDown', 1, 1, 90);
  push.emit('padUp', 0, 0);
  assert.deepEqual(dev.sent, [[0x90, 36, 100], [0x90, 42, 90], [0x80, 36, 0]]);
  assert.equal(push.leds.get('p1,1'), 8); // held pad lit
  assert.equal(push.leds.get('p0,0'), 6); // C root
});

test('polling picks up knob turns on the module but not mid-edit', async () => {
  const { dev, nt, push } = await setup();
  dev.preset.slots[0].params[2].value = 77; // turned on the module
  await nt.pollValues(0);
  assert.equal(nt.slots[0].params[2].value, 77);
  push.emit('encoder', 3, 10); // local edit on Coarse tune
  dev.preset.slots[0].params[3].value = -20; // stale echo
  await nt.pollValues(0);
  assert.notEqual(nt.slots[0].params[3].value, -20);
});

test('renders the screen and converts to a Push 2 frame', async () => {
  const { push, ctrl } = await setup();
  push.emit('touch', 2, true);
  push.emit('buttonDown', CC.octaveUp);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  render(ctx, ctrl.view());
  writeFileSync(new URL('./screen-wavetable.png', import.meta.url), canvas.toBuffer('image/png'));
  push.emit('touch', 2, false);
  push.emit('buttonDown', CC.upper[3]);
  render(ctx, ctrl.view());
  writeFileSync(new URL('./screen-lfo.png', import.meta.url), canvas.toBuffer('image/png'));
  render(ctx, { status: 'Looking for disting NT…' });
  writeFileSync(new URL('./screen-waiting.png', import.meta.url), canvas.toBuffer('image/png'));
  const frame = toFrame(ctx.getImageData(0, 0, WIDTH, HEIGHT).data);
  assert.equal(frame.length, 160 * 2048);
  // a black pixel encodes to the XOR pattern itself
  assert.deepEqual([...frame.subarray(0, 4)], [0xe7, 0xf3, 0xe7, 0xff]);
});

// ---------------------------------------------------------------------------
// full feature set
const press = (push, cc) => { push.emit('buttonDown', cc); push.emit('buttonUp', cc); };
const snap = (ctrl, name) => {
  const canvas = createCanvas(WIDTH, HEIGHT);
  render(canvas.getContext('2d'), ctrl.view());
  writeFileSync(new URL(`./screen-${name}.png`, import.meta.url), canvas.toBuffer('image/png'));
};
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error(`timeout waiting for ${fn}`); await tick(20); } };

test('Add Device: library list → specifications → slot added', async () => {
  const { dev, push, ctrl, nt } = await setup();
  press(push, CC.addDevice);
  await until(() => ctrl.list && !ctrl.list.loading);
  snap(ctrl, 'add');
  const idx = ctrl.list.items.findIndex((i) => i.label === 'Mixer Stereo');
  for (let i = 0; i < idx; i++) { push.emit('encoder', 0, 1); push.emit('encoder', 0, 1); }
  assert.equal(ctrl.list.items[ctrl.list.sel].label, 'Mixer Stereo');
  press(push, CC.select);
  assert.equal(ctrl.mode, 'specs');
  for (let i = 0; i < 15; i++) push.emit('encoder', 0, 1); // Channels 4 → 7
  snap(ctrl, 'specs');
  press(push, CC.lower[0]);
  await until(() => nt.slots.length === 5 && !ctrl.busyMsg);
  assert.deepEqual(dev.log.find((l) => l[0] === 'add'), ['add', 'mix2', [7]]);
  assert.equal(ctrl.curSlot.name, 'Mixer Stereo');
  assert.equal(ctrl.mode, 'device');
});

test('Delete + slot button asks, then removes; Shift + arrow moves; Duplicate copies values', async () => {
  const { dev, push, ctrl, nt } = await setup();
  push.emit('buttonDown', CC.delete); push.emit('buttonDown', CC.upper[2]); push.emit('buttonUp', CC.delete);
  assert.ok(ctrl.confirmDlg);
  snap(ctrl, 'confirm');
  press(push, CC.select);
  await until(() => nt.slots.length === 3 && !ctrl.busyMsg);
  assert.deepEqual(nt.slots.map((s) => s.name), ['Poly Wavetable', 'Reverb (Clouds)', 'LFO']);

  ctrl.go({ slot: 0 });
  push.emit('buttonDown', CC.shift); press(push, CC.right); push.emit('buttonUp', CC.shift);
  await until(() => nt.slots[1]?.name === 'Poly Wavetable' && !ctrl.busyMsg);
  assert.equal(ctrl.slot, 1);

  await nt.loadParam(nt.slots[1], nt.slots[1].params[15]); // range must be known before setting
  nt.setValue(nt.slots[1], nt.slots[1].params[15], 99); // cutoff
  await tick();
  press(push, CC.duplicate);
  await until(() => nt.slots.length === 4 && !ctrl.busyMsg);
  assert.equal(nt.slots[2].name, 'Poly Wavetable');
  assert.equal(nt.slots[2].params[15].value, 99);
  assert.equal(ctrl.slot, 2);
});

test('New, Browse/Load/Append, Record=save all go through confirm', async () => {
  const { dev, push, ctrl, nt } = await setup();
  press(push, CC.browse);
  await until(() => ctrl.list && !ctrl.list.loading);
  snap(ctrl, 'browse');
  const i = ctrl.list.items.findIndex((x) => x.label === 'Techno kit');
  ctrl.list.sel = i;
  press(push, CC.lower[0]); press(push, CC.select);
  await until(() => nt.presetName === 'Techno kit' && !ctrl.busyMsg);
  assert.deepEqual(nt.slots.map((s) => s.name), ['Clock', 'Euclidean Patterns', 'VCF (State Variable)', 'Delay (Stereo)']);
  // folders
  press(push, CC.browse);
  await until(() => ctrl.list && !ctrl.list.loading);
  ctrl.list.sel = ctrl.list.items.findIndex((x) => x.dir);
  press(push, CC.select);
  await until(() => ctrl.list.path === '/presets/Live sets' && !ctrl.list.loading);
  assert.deepEqual(ctrl.list.items.map((x) => x.label), ['Gig 1', 'Gig 2']);
  press(push, CC.lower[7]);
  press(push, CC.record); press(push, CC.lower[7]);
  await until(() => dev.log.some((l) => l[0] === 'save') && !ctrl.busyMsg);
  press(push, CC.newBtn); press(push, CC.lower[0]); // cancel
  assert.equal(nt.slots.length, 4);
  press(push, CC.newBtn); press(push, CC.select);
  await until(() => nt.slots.length === 0 && !ctrl.busyMsg);
  snap(ctrl, 'empty');
});

test('Mute toggles bypass, Mute + slot button bypasses that slot, Solo', async () => {
  const { push, ctrl, nt } = await setup();
  await until(() => nt.slots.every((s) => s.bypass));
  press(push, CC.mute);
  await tick();
  assert.ok(ctrl.isBypassed(nt.slots[0]));
  push.emit('buttonDown', CC.mute); press(push, CC.upper[2]); push.emit('buttonUp', CC.mute);
  await tick();
  assert.ok(ctrl.isBypassed(nt.slots[2]));
  assert.ok(ctrl.isBypassed(nt.slots[0]), 'releasing Mute after using it does not toggle current');
  ctrl.go({ slot: 1 });
  press(push, CC.solo);
  await tick(60);
  assert.deepEqual(nt.slots.map((s) => ctrl.isBypassed(s)), [true, false, true, true]);
  snap(ctrl, 'solo');
  press(push, CC.solo);
  await tick(60);
  assert.deepEqual(nt.slots.map((s) => ctrl.isBypassed(s)), [false, false, false, false]);
});

test('Undo / Shift+Undo redo a whole encoder gesture', async () => {
  const { dev, push, ctrl } = await setup();
  push.emit('buttonDown', CC.lower[1]);
  for (let i = 0; i < 10; i++) push.emit('encoder', 0, 1); // Attack 50 → 75
  await tick();
  assert.equal(dev.preset.slots[0].params[10].value, 75);
  press(push, CC.undo); await tick();
  assert.equal(dev.preset.slots[0].params[10].value, 50);
  push.emit('buttonDown', CC.shift); press(push, CC.undo); push.emit('buttonUp', CC.shift); await tick();
  assert.equal(dev.preset.slots[0].params[10].value, 75);
});

test('Automate edits the MIDI mapping of the touched parameter', async () => {
  const { dev, push, ctrl } = await setup();
  push.emit('buttonDown', CC.lower[2]); // Filter page
  push.emit('touch', 1, true); push.emit('touch', 1, false); // Cutoff
  press(push, CC.automate);
  await until(() => ctrl.mapping?.m);
  push.emit('encoder', 0, 5); // enable
  for (let i = 0; i < 10; i++) push.emit('encoder', 1, 1); // channel 1 → 3 (0.2/tick)
  for (let i = 0; i < 200; i++) push.emit('encoder', 3, 1); // CC 0 → 40
  await tick(120);
  snap(ctrl, 'mapping');
  const m = dev.preset.slots[0].params[15].mapping;
  assert.equal(m.midiEnabled, true);
  assert.equal(m.midiChannel, 2);
  assert.equal(m.midiCC, 63); // 200 ticks × 0.32
  press(push, CC.lower[0]); // CV page
  push.emit('encoder', 0, 30); // CV input → 6
  await tick(120);
  assert.equal(dev.preset.slots[0].params[15].mapping.cvInput, 6);
  assert.equal(dev.preset.slots[0].params[15].mapping.midiCC, 63, 'CV edit keeps MIDI settings');
});

test('Mix shows the performance page; Shift+Mix adds; Delete+touch removes', async () => {
  const { dev, push, ctrl } = await setup();
  press(push, CC.mix);
  await until(() => ctrl.perf?.items);
  assert.deepEqual(ctrl.fields().map((f) => f.name), ['Cutoff', 'Verb mix', 'Feedback']);
  push.emit('encoder', 1, 10);
  await tick();
  assert.equal(dev.preset.slots[1].params[0].value, 38); // 35 + 10 × 0.3
  snap(ctrl, 'mix');
  press(push, CC.device);
  push.emit('buttonDown', CC.lower[1]);
  push.emit('touch', 3, true); push.emit('touch', 3, false); // Release
  push.emit('buttonDown', CC.shift); press(push, CC.mix); push.emit('buttonUp', CC.shift);
  await until(() => dev.perf[3].enabled);
  assert.equal(dev.perf[3].upper, 'Release');
  press(push, CC.mix);
  await until(() => ctrl.fields().length === 4);
  push.emit('buttonDown', CC.delete); push.emit('touch', 0, true); push.emit('buttonUp', CC.delete);
  await until(() => !dev.perf[0].enabled);
});

test('Clip mirrors the NT screen and drives its encoders and pots', async () => {
  const { dev, push, ctrl } = await setup();
  press(push, CC.clip);
  await until(() => ctrl.panel.image);
  for (let i = 0; i < 3; i++) push.emit('encoder', 3, 1); // NT left encoder → slot 2
  for (let i = 0; i < 6; i++) push.emit('encoder', 4, 1); // NT right encoder → param 2
  await tick();
  assert.deepEqual(dev.ui, { slot: 1, param: 2 });
  for (let i = 0; i < 100; i++) push.emit('encoder', 2, 1); // right pot up
  await tick();
  assert.ok(dev.preset.slots[1].params[2].value > 70);
  press(push, CC.lower[2]);
  await tick();
  assert.ok(dev.log.some((l) => l[0] === 'press' && l[1] === 2));
  await tick(150);
  snap(ctrl, 'panel');
  press(push, CC.clip); // back to device
  assert.equal(ctrl.mode, 'device');
  assert.equal(ctrl.panelTimer, null);
});

test('Session pads jump to slot/page; Scale puts pads in key', async () => {
  const { push, ctrl } = await setup();
  press(push, CC.session);
  push.emit('padDown', 1, 0, 100);
  assert.equal(ctrl.curSlot.name, 'Reverb (Clouds)');
  push.emit('padDown', 0, 2, 100);
  assert.equal(ctrl.curSlot.name, 'Poly Wavetable');
  assert.equal(ctrl.curPage.name, 'Filter');
  assert.equal(push.leds.get('p0,2'), 4);
  press(push, CC.note);
  press(push, CC.scale);
  for (let i = 0; i < 5; i++) push.emit('encoder', 1, 1); // Scale → Major
  for (let i = 0; i < 5; i++) push.emit('encoder', 2, 1); // Layout → In key
  snap(ctrl, 'scale');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((x) => ctrl.noteFor(x, 0)), [36, 38, 40, 41, 43, 45, 47, 48]);
  assert.equal(ctrl.noteFor(0, 1), 41);
});

test('Setup shows CPU per slot', async () => {
  const { push, ctrl } = await setup();
  press(push, CC.setup);
  await until(() => ctrl.info);
  snap(ctrl, 'setup');
  assert.match(ctrl.view().title, /^CPU/);
  press(push, CC.setup);
  assert.equal(ctrl.infoTimer, null);
});

// ---------------------------------------------------------------------------
// demo mode: algorithms rebuilt from the disting NT manual
async function setupReal(name = 'Grain cloud') {
  const dev = new FakeNT(realPreset(name), 0, { real: true });
  const nt = new DistingNT(dev, { timeout: 200 });
  const push = new FakePush();
  const ctrl = new Controller(nt, push);
  await nt.load();
  await tick(100);
  return { dev, nt, push, ctrl };
}

test('demo: Granulator matches the manual — stereo routing, pages, spec', async () => {
  const { push, ctrl, nt } = await setupReal();
  const g = nt.slots[0];
  assert.equal(g.name, 'Granulator');
  assert.deepEqual(g.pages.map((p) => p.name), ['Mix', 'Record', 'Grains', 'Modulation', 'Drone 1', 'Drone 2', 'Drone 3', 'Setup', 'Routing']);
  push.emit('buttonDown', CC.lower[8 - 8 + 7]); // 8th page button → Setup
  push.emit('buttonDown', CC.pageRight); // → Routing
  assert.equal(ctrl.curPage.name, 'Routing');
  await tick(150);
  const v = ctrl.view().params;
  assert.deepEqual(v.slice(0, 5).map((p) => [p.name, p.value]), [
    ['Left input', 'Input 1'], ['Right input', 'Input 2'], ['Left output', 'Output 1'], ['Right output', 'Output 2'], ['Output mode', 'Add'],
  ]);
  snap(ctrl, 'demo-granulator-routing');
  // turn Right input to Input 3
  for (let i = 0; i < 5; i++) push.emit('encoder', 1, 1);
  await tick();
  assert.equal(ctrl.view().params[1].value, 'Input 3');
  ctrl.go({ slot: 0, page: 2 });
  await tick(150);
  snap(ctrl, 'demo-granulator-grains');
});

test('demo: library has every algorithm from the manual; each one loads over SysEx', async () => {
  const lib = realLibrary().algorithms;
  assert.equal(lib.length, 88);
  for (const alg of lib) {
    const dev = new FakeNT({ name: alg.name, slots: [realSlot(alg.guid)] }, 0, { real: true });
    const nt = new DistingNT(dev, { timeout: 100, retries: 0 });
    await nt.load();
    const s = nt.slots[0];
    assert.equal(s.name.replace(/[^\x20-\x7e]/g, '?'), s.name, alg.name);
    for (const p of s.params) await nt.loadParam(s, p, 0);
    assert.ok(s.params.every((p) => p.loaded && p.min <= p.max), `${alg.name} params`);
    assert.ok(s.params.some((p) => p.name === 'Bypass'));
  }
});

test('demo: Add Device lists the real library; LFO with 2 channels gets per-channel pages', async () => {
  const { push, ctrl, nt } = await setupReal();
  press(push, CC.addDevice);
  await until(() => ctrl.list && !ctrl.list.loading, 8000);
  assert.equal(ctrl.list.items.length, 88);
  snap(ctrl, 'demo-add');
  ctrl.list.sel = ctrl.list.items.findIndex((i) => i.label === 'LFO');
  press(push, CC.select);
  assert.equal(ctrl.mode, 'specs');
  assert.equal(ctrl.fields()[0].name, 'Channels');
  for (let i = 0; i < 5; i++) push.emit('encoder', 0, 1);
  press(push, CC.lower[0]);
  await until(() => nt.slots.length === 4 && !ctrl.busyMsg);
  assert.deepEqual(ctrl.curSlot.pages.map((p) => p.name), ['Globals', 'Channel 1', 'Channel 2', 'Channel 1 routing', 'Channel 2 routing', 'Channel 1 sync', 'Channel 2 sync']);
  for (const p of ctrl.curSlot.params) await nt.loadParam(ctrl.curSlot, p);
  const two = ctrl.curSlot.params.find((p) => p.name.startsWith('2:'));
  assert.ok(two, `no channel 2 params; slot=${ctrl.curSlot.name} pages=${ctrl.curSlot.pages.map((p) => p.name)} specs=${ctrl.curSlot.specs}`);
  assert.equal(two.name, '2:Enable');
});
