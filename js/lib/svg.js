// Minimal SVG charts. Colors come from CSS variables so charts follow the theme.

import { esc, fmt } from './dom.js';

const PAD = { l: 52, r: 16, t: 24, b: 30 };

function scale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

function ticks(lo, hi, n = 5) {
  const step = niceStep((hi - lo) / n);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

// series: [{ values: number[] (null = gap), color, label, width }]
// bands: [{ from, to, color }] in x index units; markers: [{ x, label, color }]
export function lineChart({ series, width = 760, height = 260, bands = [], markers = [], xLabel = '', yLabel = '', xFormat = (i) => i, yMin, yMax }) {
  const n = Math.max(...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && Number.isFinite(v)));
  const lo = yMin ?? Math.min(...all);
  const hi = yMax ?? Math.max(...all);
  const x = scale(0, n - 1, PAD.l, width - PAD.r);
  const y = scale(lo, hi, height - PAD.b, PAD.t);
  const yt = ticks(lo, hi, 4);
  const xt = ticks(0, n - 1, 6);
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.5}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(yLabel)}">
    ${bands.map((b) => `<rect x="${x(b.from)}" y="${PAD.t}" width="${Math.max(2, x(b.to) - x(b.from))}" height="${height - PAD.t - PAD.b}" fill="${b.color}"/>`).join('')}
    ${yt.map((t) => `<line class="grid" x1="${PAD.l}" x2="${width - PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
    ${xt.map((t) => `<text class="tick" x="${x(t)}" y="${height - PAD.b + 16}" text-anchor="middle">${esc(xFormat(t))}</text>`).join('')}
    ${paths.join('')}
    ${markers.map((m) => `<line x1="${x(m.x)}" x2="${x(m.x)}" y1="${PAD.t}" y2="${height - PAD.b}" stroke="${m.color}" stroke-width="${m.width ?? 2}"/><text class="tick strong" x="${x(m.x) + 4}" y="${m.bottom ? height - PAD.b - 6 : PAD.t + 10}" fill="${m.color}">${esc(m.label)}</text>`).join('')}
    ${xLabel ? `<text class="axis" x="${width - PAD.r}" y="${height - 2}" text-anchor="end">${esc(xLabel)}</text>` : ''}
    ${yLabel ? `<text class="axis" x="4" y="${PAD.t - 10}">${esc(yLabel)}</text>` : ''}
  </svg>`;
}

// rows: [{ label, sub, a, b, aLabel, bLabel }] — dot "a" (failed) vs "b" (target).
export function dumbbell({ rows, width = 620, rowH = 64, domain, xLabel = '', left = 240 }) {
  const height = rows.length * rowH + 44;
  const x = scale(domain[0], domain[1], left, width - 20);
  const xt = ticks(domain[0], domain[1], 6);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(xLabel)}">
    ${xt.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="8" y2="${height - 30}"/><text class="tick" x="${x(t)}" y="${height - 16}" text-anchor="middle">${fmt(t)}</text>`).join('')}
    ${rows
      .map((r, i) => {
        const cy = 30 + i * rowH;
        return `<text class="label" x="${left - 14}" y="${cy + 4}" text-anchor="end">${esc(r.label)}</text>
        <text class="tick" x="${left - 14}" y="${cy + 20}" text-anchor="end">${esc(r.sub ?? '')}</text>
        <line x1="${x(r.a)}" x2="${x(r.b)}" y1="${cy}" y2="${cy}" stroke="var(--line-strong)" stroke-width="5" stroke-linecap="round"/>
        <circle cx="${x(r.b)}" cy="${cy}" r="8" fill="var(--muted)"/>
        <circle cx="${x(r.a)}" cy="${cy}" r="8" fill="var(--bad)"/>
        <text class="tick strong" x="${x(r.a)}" y="${cy - 14}" text-anchor="middle" fill="var(--bad)">${fmt(r.a)}</text>
        <text class="tick" x="${x(r.b)}" y="${cy - 14}" text-anchor="middle">${fmt(r.b)}</text>`;
      })
      .join('')}
    <text class="axis" x="${(left + width) / 2}" y="${height - 2}" text-anchor="middle">${esc(xLabel)}</text>
  </svg>`;
}

// items: [{ label, value, color }] — horizontal bars from zero (supports negatives).
export function hbars({ items, width = 520, rowH = 28, format = (v) => fmt(v, 2), left = 190 }) {
  const height = items.length * rowH + 10;
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const hasNeg = items.some((i) => i.value < 0);
  const x = scale(hasNeg ? -maxAbs : 0, maxAbs, left, width - 60);
  const zero = x(0);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">
    <line class="grid" x1="${zero}" x2="${zero}" y1="0" y2="${height}"/>
    ${items
      .map((it, i) => {
        const cy = 6 + i * rowH;
        const x1 = Math.min(zero, x(it.value));
        const w = Math.abs(x(it.value) - zero);
        return `<text class="label" x="${left - 10}" y="${cy + 15}" text-anchor="end">${esc(it.label)}</text>
        <rect x="${x1}" y="${cy + 3}" width="${Math.max(1, w)}" height="${rowH - 10}" rx="3" fill="${it.color ?? 'var(--accent)'}"/>
        <text class="tick" x="${Math.max(x(it.value), zero) + 6}" y="${cy + 15}">${esc(format(it.value))}</text>`;
      })
      .join('')}
  </svg>`;
}

// Sequential heatmap for a 2D sweep; low = light, high = accent.
export function heatmap({ xs, ys, grid, min, max, xLabel, yLabel, width = 480, height = 360, format = (v) => fmt(v, 2) }) {
  const left = 56;
  const bottom = 40;
  const cw = (width - left - 10) / xs.length;
  const ch = (height - bottom - 10) / ys.length;
  const t = (v) => (v - min) / (max - min || 1);
  const cells = [];
  ys.forEach((yv, j) => {
    xs.forEach((xv, i) => {
      const v = grid[j][i];
      cells.push(
        `<rect x="${left + i * cw}" y="${10 + (ys.length - 1 - j) * ch}" width="${cw + 0.5}" height="${ch + 0.5}" fill="var(--accent)" fill-opacity="${(0.08 + 0.92 * t(v)).toFixed(3)}"><title>${esc(xLabel)} ${fmt(xv, 1)}, ${esc(yLabel)} ${fmt(yv, 1)} → ${format(v)}</title></rect>`,
      );
    });
  });
  const xi = [0, Math.floor(xs.length / 2), xs.length - 1];
  const yi = [0, Math.floor(ys.length / 2), ys.length - 1];
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Parameter sweep">
    ${cells.join('')}
    ${xi.map((i) => `<text class="tick" x="${left + (i + 0.5) * cw}" y="${height - bottom + 16}" text-anchor="middle">${fmt(xs[i], 1)}</text>`).join('')}
    ${yi.map((j) => `<text class="tick" x="${left - 6}" y="${10 + (ys.length - 1 - j + 0.5) * ch + 4}" text-anchor="end">${fmt(ys[j], 1)}</text>`).join('')}
    <text class="axis" x="${left + (width - left) / 2}" y="${height - 6}" text-anchor="middle">${esc(xLabel)}</text>
    <text class="axis" x="12" y="${10 + (height - bottom) / 2}" transform="rotate(-90 12 ${10 + (height - bottom) / 2})" text-anchor="middle">${esc(yLabel)}</text>
  </svg>`;
}
