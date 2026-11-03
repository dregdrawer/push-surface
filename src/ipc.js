#!/usr/bin/env node
// Engine host for the native Mac app, Push Surface (mac/main.c).
// stdout: one JSON message per line  {type:'status', data} | {type:'log', data}
// stdin:  one JSON command per line  {cmd:'mode', arg:'demo'|'live'} | {cmd:'reload'} | {cmd:'quit'}
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine, loadConfig } from './engine.js';

// stdout is the message channel; anything else printed goes to stderr (the app's log file)
const out = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
const emit = (type, data) => out(JSON.stringify({ type, data }) + '\n');

const dir = process.env.NTPUSH_DIR || join(homedir(), 'Library', 'Application Support', 'Push Surface');
const oldDir = join(homedir(), 'Library', 'Application Support', 'NT Push'); // before the rename
mkdirSync(dir, { recursive: true });
for (const f of ['config.json', 'state.json']) {
  if (!process.env.NTPUSH_DIR && !existsSync(join(dir, f)) && existsSync(join(oldDir, f))) copyFileSync(join(oldDir, f), join(dir, f));
}
const configPath = join(dir, 'config.json');
if (!existsSync(configPath)) copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), configPath);
const statePath = join(dir, 'state.json');
let demo = existsSync(statePath) ? !!JSON.parse(readFileSync(statePath, 'utf8')).demo : false;

let engine = null, switching = Promise.resolve();
async function start() {
  engine = new Engine(loadConfig(configPath), { demo });
  engine.on('status', (s) => emit('status', s));
  engine.on('log', (l) => emit('log', l));
  await engine.start();
}
function setMode(m) {
  switching = switching.then(async () => {
    const want = m === 'demo';
    if (want === demo) return;
    demo = want;
    writeFileSync(statePath, JSON.stringify({ demo }));
    await engine?.stop();
    await start();
  });
  return switching;
}
let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  await switching;
  await engine?.stop();
  process.exit(0);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.cmd === 'mode') setMode(msg.arg);
  else if (msg.cmd === 'reload') engine?.reload('reload from window');
  else if (msg.cmd === 'quit') quit();
}).on('close', quit); // the app went away: release the Push
process.on('SIGTERM', quit);
process.on('SIGINT', quit);

emit('config', configPath);
await start();
