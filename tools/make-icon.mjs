#!/usr/bin/env node
// Writes the app icon:  node tools/make-icon.mjs AppIcon.icns [preview.png] [AppIcon.ico]
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

// ---- icon: an 8×8 pad grid, mostly dark, a few lit in the accent colour ----
function iconPng(size) {
  const c = createCanvas(size, size), g = c.getContext('2d');
  const s = size / 1024, inset = 100 * s, w = size - 2 * inset, r = 185 * s;
  g.beginPath();
  g.moveTo(inset + r, inset); g.arcTo(inset + w, inset, inset + w, inset + w, r); g.arcTo(inset + w, inset + w, inset, inset + w, r);
  g.arcTo(inset, inset + w, inset, inset, r); g.arcTo(inset, inset, inset + w, inset, r); g.closePath();
  const grad = g.createLinearGradient(0, inset, 0, inset + w);
  grad.addColorStop(0, '#1d1d1f'); grad.addColorStop(1, '#0b0b0c');
  g.fillStyle = grad; g.fill();
  g.lineWidth = 3 * s; g.strokeStyle = '#2c2c2e'; g.stroke();
  const lit = new Set(['1,6', '2,5', '3,4', '4,3', '5,4', '6,5', '3,6', '4,6', '5,6', '6,2']);
  const pad = 70 * s, gap = 12 * s, ox = inset + (w - (8 * pad + 7 * gap)) / 2;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const px = ox + x * (pad + gap), py = ox + y * (pad + gap), pr = 10 * s;
    g.beginPath();
    g.moveTo(px + pr, py); g.arcTo(px + pad, py, px + pad, py + pad, pr); g.arcTo(px + pad, py + pad, px, py + pad, pr);
    g.arcTo(px, py + pad, px, py, pr); g.arcTo(px, py, px + pad, py, pr); g.closePath();
    g.fillStyle = lit.has(`${x},${y}`) ? '#ff6e14' : '#2a2a2d';
    g.fill();
  }
  return c.toBuffer('image/png');
}
// .icns = 'icns' + length, then PNG entries (ic07 128 … ic10 1024)
const entries = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
  .map(([type, px]) => { const png = iconPng(px); const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(png.length + 8, 4); return Buffer.concat([h, png]); });
const body = Buffer.concat(entries), head = Buffer.alloc(8);
head.write('icns', 0, 'ascii'); head.writeUInt32BE(body.length + 8, 4);
writeFileSync(process.argv[2], Buffer.concat([head, body]));
if (process.argv[3]) writeFileSync(process.argv[3], iconPng(512));

// .ico for Windows: PNG entries 16 … 256
if (process.argv[4]) {
  const sizes = [16, 24, 32, 48, 64, 128, 256], pngs = sizes.map(iconPng);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((px, i) => {
    const e = 6 + 16 * i;
    head[e] = px % 256; head[e + 1] = px % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += pngs[i].length;
  });
  writeFileSync(process.argv[4], Buffer.concat([head, ...pngs]));
}
