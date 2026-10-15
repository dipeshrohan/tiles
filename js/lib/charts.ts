// Charts v2 (U5.03): reading a chart point by point, and saving it. One set of listeners for every
// chart on any page (installed once by app.ts), finding each chart's data by its `data-chart` id
// (js/lib/chart-data.ts):
// - pointing at a chart (a mouse, or a finger's tap) shows a crosshair at the nearest reading, with
//   its time and value;
// - focused, ← and → step through the readings (Page Up and Down ten at a time, Home and End to
//   the ends), each read out by a live region; Escape hides it;
// - its legend shows and hides each part; PNG saves it as an image, CSV its data.
// The chart stays plain SVG: the crosshair is drawn into it, and goes when the page draws it again.
import { chartCsv, chartData, fileName, nearest, readout, step, togglePart, type ChartData } from './chart-data.ts';
import { download } from './dom.ts';

const NS = 'http://www.w3.org/2000/svg';
// The reading shown, per chart, and the data it is a reading of: a chart drawn again with other data
// (the same element, patched) starts again.
const shownAt = new WeakMap<SVGSVGElement, { id: string; i: number }>();
const at = {
  get: (svg: SVGSVGElement): number | undefined => {
    const s = shownAt.get(svg);
    return s && s.id === svg.dataset.chart && svg.querySelector(':scope > g.crosshair') ? s.i : undefined;
  },
  set: (svg: SVGSVGElement, i: number) => shownAt.set(svg, { id: svg.dataset.chart ?? '', i }),
  delete: (svg: SVGSVGElement) => shownAt.delete(svg),
};

const chartOf = (el: EventTarget | null): SVGSVGElement | null =>
  el instanceof Element ? el.closest<SVGSVGElement>('svg[data-chart]') : null;

const dataOf = (svg: SVGSVGElement): ChartData | undefined => chartData(svg.dataset.chart ?? '');

// Whether a series is shown (its part not hidden by the legend): "s0"… for line charts; a time
// chart's one series is its "line".
function shownSeries(svg: SVGSVGElement): (k: number) => boolean {
  const off = new Set((svg.dataset.hidden ?? '').split(' ').filter(Boolean));
  return (k) => !off.has(`s${k}`) && !(k === 0 && off.has('line'));
}

// Whether any shown series has a reading to read.
const anyShown = (svg: SVGSVGElement, d: ChartData): boolean => {
  const shown = shownSeries(svg);
  return d.series.some((s, k) => shown(k) && s.ys.some((y) => y !== null));
};

// The chart's own units (its viewBox) under a point on the screen.
function unitsAt(svg: SVGSVGElement, clientX: number): number {
  const rect = svg.getBoundingClientRect();
  const box = svg.viewBox.baseVal;
  return ((clientX - rect.left) / rect.width) * box.width;
}

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

export function clearCrosshair(svg: SVGSVGElement): void {
  svg.querySelector(':scope > g.crosshair')?.remove();
}

// Draws the crosshair at reading `i`: a line across the plot, a dot on each shown series, and the
// time and values in a box beside it.
export function drawCrosshair(svg: SVGSVGElement, i: number): void {
  const d = dataOf(svg);
  if (!d) return;
  at.set(svg, i);
  clearCrosshair(svg);
  const x = d.xs[i];
  if (x === undefined) return;
  const shown = shownSeries(svg);
  const g = el('g', { class: 'crosshair', 'aria-hidden': 'true' });
  g.append(el('line', { x1: x, x2: x, y1: d.top, y2: d.bottom }));
  const lines = [d.labels[i] ?? ''];
  d.series.forEach((s, k) => {
    const y = s.ys[i];
    if (!shown(k) || y === null || y === undefined) return;
    g.append(el('circle', { cx: x, cy: y, r: 3.5 }));
    lines.push(d.series.length > 1 ? `${s.name}: ${s.text[i] ?? ''}` : (s.text[i] ?? ''));
  });
  const box = svg.viewBox.baseVal;
  const lineH = 15;
  const w = Math.min(box.width - 8, 12 + 6.4 * Math.max(...lines.map((l) => l.length)));
  const h = 8 + lineH * lines.length;
  const left = x + 10 + w > box.width - 4 ? x - 10 - w : x + 10; // beside it, on the side with room
  const top = Math.max(2, d.top);
  g.append(el('rect', { class: 'crosshair-box', x: left, y: top, width: w, height: h, rx: 4 }));
  lines.forEach((l, n) => {
    const t = el('text', {
      x: left + 6,
      y: top + 4 + lineH * (n + 1) - 3,
      class: n ? 'crosshair-value' : 'crosshair-time',
    });
    t.textContent = l;
    g.append(t);
  });
  svg.append(g);
}

let live: HTMLElement | null = null;
const say = (text: string): void => {
  if (!live) return;
  live.textContent = '';
  // A new node each time, so the same words twice are read twice.
  requestAnimationFrame(() => {
    if (live) live.textContent = text;
  });
};

// The styles a chart is drawn with, written onto a copy of it, so the copy looks the same alone
// (an image has no stylesheet). Each element's own computed look, without reading the stylesheet.
const KEEP = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'display',
];
export function standalone(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.querySelector(':scope > g.crosshair')?.remove();
  const from = [svg, ...svg.querySelectorAll('*')];
  const to = [copy, ...copy.querySelectorAll('*')];
  to.forEach((node, n) => {
    const src = from[n];
    if (!(src instanceof Element) || !(node instanceof SVGElement)) return;
    const cs = getComputedStyle(src);
    node.setAttribute('style', KEEP.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  const box = svg.viewBox.baseVal;
  copy.setAttribute('xmlns', NS);
  copy.setAttribute('width', String(box.width));
  copy.setAttribute('height', String(box.height));
  copy.removeAttribute('tabindex');
  return new XMLSerializer().serializeToString(copy);
}

async function savePng(svg: SVGSVGElement, title: string): Promise<void> {
  const box = svg.viewBox.baseVal;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone(svg))}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = box.width * 2; // sharp on a high-density screen or in a report
  canvas.height = box.height * 2;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = getComputedStyle(svg.closest('.card') ?? document.body).backgroundColor || '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the image could not be made');
  download(fileName(title, 'png'), blob);
}

// The chart a tool belongs to: the one after its tools, in its box.
const svgFor = (tool: Element): SVGSVGElement | null =>
  tool.closest('.chart-box')?.querySelector<SVGSVGElement>('svg[data-chart]') ?? null;

// `failed`: says a chart couldn't be saved (the app's toast).
export function installCharts(region: HTMLElement, failed: (what: string) => void = () => {}): void {
  live = region;
  document.addEventListener('pointermove', (e) => {
    const svg = chartOf(e.target);
    if (!svg || e.pointerType === 'touch') return; // a finger reads on a tap: it scrolls when it moves
    const d = dataOf(svg);
    const i = d ? nearest(d, unitsAt(svg, e.clientX), shownSeries(svg)) : null;
    if (i !== null && i !== at.get(svg)) drawCrosshair(svg, i); // at.get: none after a redraw
  });
  // A tap (or a click) shows the nearest reading, and keeps it until the next.
  document.addEventListener('pointerdown', (e) => {
    const svg = chartOf(e.target);
    if (!svg || e.pointerType === 'mouse') return;
    const d = dataOf(svg);
    const i = d ? nearest(d, unitsAt(svg, e.clientX), shownSeries(svg)) : null;
    if (i !== null && d) {
      drawCrosshair(svg, i);
      say(readout(d, i, shownSeries(svg)));
    }
  });
  document.addEventListener(
    'pointerleave',
    (e) => {
      const svg = e.target instanceof SVGSVGElement && e.target.matches('svg[data-chart]') ? e.target : null;
      if (svg && e.pointerType === 'mouse' && document.activeElement !== svg) {
        clearCrosshair(svg);
        at.delete(svg);
      }
    },
    true,
  );
  document.addEventListener('focusin', (e) => {
    const svg = chartOf(e.target);
    const d = svg ? dataOf(svg) : undefined;
    if (!svg || !d || !d.xs.length) return;
    if (!anyShown(svg, d)) return say('Every part of this chart is hidden: show one with its legend to read it.');
    const i = at.get(svg) ?? step(d, d.xs.length, -1, shownSeries(svg)); // the latest reading
    drawCrosshair(svg, i);
    say(readout(d, i, shownSeries(svg)));
  });
  document.addEventListener('focusout', (e) => {
    const svg = chartOf(e.target);
    if (svg) {
      clearCrosshair(svg);
      at.delete(svg);
    }
  });
  document.addEventListener('keydown', (e) => {
    const svg = e.target instanceof SVGSVGElement && e.target.matches('svg[data-chart]') ? e.target : null;
    const d = svg ? dataOf(svg) : undefined;
    if (!svg || !d || !d.xs.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const shown = shownSeries(svg);
    if (!anyShown(svg, d)) return;
    const now = at.get(svg) ?? step(d, d.xs.length, -1, shown);
    const moves: Record<string, () => number> = {
      ArrowRight: () => step(d, now, 1, shown),
      ArrowLeft: () => step(d, now, -1, shown),
      PageDown: () => step(d, now, 10, shown),
      PageUp: () => step(d, now, -10, shown),
      Home: () => step(d, -1, 1, shown),
      End: () => step(d, d.xs.length, -1, shown),
    };
    if (e.key === 'Escape') {
      clearCrosshair(svg);
      at.delete(svg);
      return;
    }
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const i = move();
    drawCrosshair(svg, i);
    say(readout(d, i, shown));
  });
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const toggle = t?.closest<HTMLButtonElement>('[data-chart-toggle]');
    const png = t?.closest('[data-chart-png]');
    const csv = t?.closest('[data-chart-csv]');
    const tool = toggle ?? png ?? csv;
    const svg = tool ? svgFor(tool) : null;
    const id = svg?.dataset.chart;
    const d = id ? chartData(id) : undefined;
    if (!svg || !id || !d) return;
    if (toggle) {
      const part = toggle.dataset.chartToggle ?? '';
      const off = togglePart(svg.dataset.chartKey ?? id, part);
      svg.querySelectorAll(`[data-part="${CSS.escape(part)}"]`).forEach((p) => {
        if (off) p.setAttribute('display', 'none');
        else p.removeAttribute('display');
      });
      toggle.setAttribute('aria-pressed', String(!off));
      const parts = new Set((svg.dataset.hidden ?? '').split(' ').filter(Boolean));
      if (off) parts.add(part);
      else parts.delete(part);
      svg.dataset.hidden = [...parts].join(' ');
      clearCrosshair(svg);
      at.delete(svg);
    } else if (png) savePng(svg, d.title).catch(() => failed('The chart couldn’t be saved as an image'));
    else download(fileName(d.title, 'csv'), chartCsv(d), 'text/csv;charset=utf-8');
  });
}
