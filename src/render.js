// Draws the Push 2 screen (960×160). Columns line up with the 8 buttons above and below.
import { WIDTH, HEIGHT } from './push2.js';

const FONT = '"Helvetica Neue", Helvetica, Inter, Arial, sans-serif';
const C = {
  bg: '#000000', text: '#f2f2f2', mute: '#7c7c7c', faint: '#2b2b2b', hair: '#1c1c1c',
  accent: '#ff6e14', touchBg: '#141414', warn: '#ff3b30', panel: '#0d0d0d', sub: '#555555',
};
const COL = WIDTH / 8;

function fit(ctx, s, w) {
  s = String(s ?? '');
  if (ctx.measureText(s).width <= w) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
function text(ctx, s, x, y, { size = 12, color = C.mute, bold = false, align = 'left', w = COL - 16 } = {}) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(fit(ctx, s, w), x, y);
  ctx.textAlign = 'left';
}

function topRow(ctx, view) {
  const top = view.top ?? [];
  for (let i = 0; i < 8; i++) {
    const s = top[i];
    if (!s) continue;
    const x = i * COL;
    // bypassed slots: dimmed and struck through
    const color = s.warn ? (s.selected ? '#8a4a24' : C.sub) : s.selected ? C.accent : C.mute;
    text(ctx, s.label, x + 8, 16, { color });
    if (s.warn) { ctx.font = `12px ${FONT}`; ctx.fillStyle = color; ctx.fillRect(x + 8, 12, Math.min(COL - 16, ctx.measureText(s.label).width), 1); }
    if (s.selected) { ctx.fillStyle = s.warn ? '#8a4a24' : C.accent; ctx.fillRect(x + 8, 22, COL - 16, 2); }
  }
  const right = view.title ?? (top.length < 8 ? view.preset : '');
  if (right && top.length < 8) text(ctx, right, WIDTH - 8, 16, { align: 'right', w: (8 - top.length) * COL - 16, color: view.title ? C.text : C.mute });
  ctx.fillStyle = C.hair;
  ctx.fillRect(0, 28, WIDTH, 1);
}

function bottomRow(ctx, view) {
  ctx.fillStyle = C.hair;
  ctx.fillRect(0, 131, WIDTH, 1);
  const b = view.bottom ?? [];
  for (let i = 0; i < 8; i++) {
    const pg = b[i];
    if (!pg) continue;
    const x = i * COL;
    if (pg.selected) { ctx.fillStyle = C.accent; ctx.fillRect(x + 8, 135, COL - 16, 2); }
    text(ctx, pg.label, x + 8, 153, { color: pg.selected ? C.accent : C.mute });
  }
  const used = b.reduce((n, v, i) => (v ? i + 1 : n), 0);
  const mods = [view.shift && 'SHIFT', view.del && 'DELETE'].filter(Boolean).join(' · ');
  const extra = [view.hint, mods].filter(Boolean).join('   ');
  if (extra && used < 8) text(ctx, extra, WIDTH - 8, 153, { align: 'right', w: (8 - used) * COL - 16, color: mods ? C.text : C.mute });
}

function params(ctx, view) {
  for (let i = 0; i < 8; i++) {
    const p = view.params?.[i];
    const x = i * COL;
    if (!p || p.empty) continue;
    if (p.touched) { ctx.fillStyle = C.touchBg; ctx.fillRect(x + 1, 30, COL - 2, 100); }
    const dim = p.disabled;
    if (p.sub) text(ctx, p.sub, x + 8, 42, { size: 10, color: C.sub });
    text(ctx, p.name, x + 8, 56, { color: dim ? C.faint : C.mute });
    text(ctx, p.value, x + 8, 86, { size: 20, bold: p.touched, color: dim ? C.faint : p.touched ? C.accent : C.text });
    const bx = x + 8, bw = COL - 16, by = 106;
    ctx.fillStyle = C.faint;
    ctx.fillRect(bx, by, bw, 2);
    if (p.norm != null) {
      ctx.fillStyle = dim ? C.mute : C.accent;
      const n = Math.max(0, Math.min(1, p.norm));
      if (p.bipolar) {
        const mid = bx + bw / 2, end = bx + bw * n;
        ctx.fillRect(Math.min(mid, end), by - 1, Math.max(2, Math.abs(end - mid)), 4);
      } else ctx.fillRect(bx, by - 1, Math.max(2, bw * n), 4);
    }
  }
  if (view.message) text(ctx, view.message, WIDTH / 2, 84, { size: 14, align: 'center', w: WIDTH - 40 });
}

function list(ctx, view) {
  const rows = 4, rowH = 24, y0 = 36;
  const items = view.items ?? [];
  const start = Math.max(0, Math.min(view.sel - 1, items.length - rows));
  for (let r = 0; r < rows; r++) {
    const i = start + r, it = items[i];
    if (!it) break;
    const y = y0 + r * rowH;
    if (i === view.sel) { ctx.fillStyle = C.touchBg; ctx.fillRect(0, y, WIDTH, rowH); ctx.fillStyle = C.accent; ctx.fillRect(0, y, 3, rowH); }
    text(ctx, it.label, 16, y + 17, { size: 16, color: i === view.sel ? C.text : C.mute, w: WIDTH * 0.7 });
    if (it.detail) text(ctx, it.detail, WIDTH - 16, y + 17, { align: 'right', w: 200, color: C.sub });
  }
  if (items.length > rows) {
    const h = 96, th = Math.max(8, (h * rows) / items.length), ty = 36 + ((h - th) * start) / Math.max(1, items.length - rows);
    ctx.fillStyle = C.faint; ctx.fillRect(WIDTH - 4, 36, 2, h);
    ctx.fillStyle = C.mute; ctx.fillRect(WIDTH - 4, ty, 2, th);
  }
  if (view.note) text(ctx, view.note, WIDTH / 2, items.length ? 128 : 84, { size: items.length ? 11 : 14, align: 'center', w: WIDTH - 40 });
}

// 256×64 4-bit grey screenshot, drawn 2× in the middle of the screen
function panel(ctx, view) {
  const img = view.image, ox = (WIDTH - 512) / 2, oy = 30;
  ctx.fillStyle = C.panel;
  ctx.fillRect(ox - 4, oy - 1, 520, 130);
  if (img && img.length >= 256 * 64) {
    const data = ctx.createImageData(512, 128);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) {
      const v = Math.round(255 * Math.pow(Math.min(15, img[y * 256 + x]) / 15, 0.6));
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const o = ((y * 2 + dy) * 512 + x * 2 + dx) * 4;
        data.data[o] = v; data.data[o + 1] = Math.round(v * 0.93); data.data[o + 2] = Math.round(v * 0.85); data.data[o + 3] = 255;
      }
    }
    ctx.putImageData(data, ox, oy);
  } else text(ctx, 'Waiting for the disting NT screen…', WIDTH / 2, 94, { size: 14, align: 'center', w: 500 });
  // control hints in the side margins
  const hints = [...(view.encoders ?? []).map((l, i) => `Enc ${i + 1} → ${l}`), ...(view.buttons ?? [])];
  hints.forEach((l, i) => {
    const left = i < 4;
    text(ctx, l, left ? 8 : WIDTH - 8, 48 + (left ? i : i - 4) * 20, { size: 11, align: left ? 'left' : 'right', w: ox - 20 });
  });
}

function overlays(ctx, view) {
  if (view.confirm) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 29, WIDTH, 102);
    text(ctx, view.confirm.text, WIDTH / 2, 76, { size: 16, align: 'center', color: C.text, w: WIDTH - 60 });
    text(ctx, 'Select or the last button to confirm · any other button cancels', WIDTH / 2, 102, { size: 11, align: 'center', w: WIDTH - 60 });
    ctx.fillStyle = C.bg; ctx.fillRect(0, 132, WIDTH, 28);
    text(ctx, 'Cancel', 8, 153);
    ctx.fillStyle = C.accent; ctx.fillRect(7 * COL + 8, 135, COL - 16, 2);
    text(ctx, view.confirm.yes, 7 * COL + 8, 153, { color: C.accent });
  }
  if (view.toast) {
    ctx.font = `13px ${FONT}`;
    const w = Math.min(WIDTH - 40, ctx.measureText(view.toast).width + 32);
    const x = (WIDTH - w) / 2;
    ctx.fillStyle = '#1e1e1e'; ctx.fillRect(x, 112, w, 22);
    ctx.fillStyle = C.accent; ctx.fillRect(x, 112, 2, 22);
    text(ctx, view.toast, WIDTH / 2, 127, { size: 13, align: 'center', color: C.text, w: w - 16 });
  }
}

export function render(ctx, view) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.textBaseline = 'alphabetic';
  if (view.kind === 'status' || view.status) {
    text(ctx, view.status, WIDTH / 2, HEIGHT / 2 + 5, { size: 15, align: 'center', w: WIDTH - 40 });
    return overlays(ctx, view);
  }
  topRow(ctx, view);
  if (view.kind === 'list') {
    list(ctx, view);
  } else if (view.kind === 'panel') panel(ctx, view);
  else params(ctx, view);
  if (view.kind !== 'panel') bottomRow(ctx, view);
  overlays(ctx, view);
}
