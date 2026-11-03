#!/usr/bin/env node
// Push Surface from the command line:  node src/main.js [--demo]
// (The Mac app, Push Surface.app, runs the same engine with a status window.)
import { Engine, loadConfig } from './engine.js';

const cfg = loadConfig(process.env.NTPUSH_CONFIG || new URL('../config.json', import.meta.url));
const engine = new Engine(cfg, { demo: process.argv.includes('--demo') || cfg.demo });
await engine.start();
console.log('Ctrl-C to quit.');

async function quit() { await engine.stop(); process.exit(0); }
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
