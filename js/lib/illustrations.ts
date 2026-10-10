// Illustrations (U2.05) for empty, waiting and error states: small line-art scenes drawn for Tiles,
// coloured by the theme (CSS classes .il-*, so they follow light and dark), with one part that floats
// gently (stopped by reduced motion). Decorative: the words beside them carry the meaning.

export type IllustrationName =
  'connect' | 'inbox' | 'search' | 'chart' | 'documents' | 'chat' | 'select' | 'error' | 'done' | 'launch';

// Shared pieces: a soft backdrop, and a card with lines of "text".
const backdrop = '<ellipse class="il-bg" cx="80" cy="66" rx="70" ry="46"/>';
const lines = (x: number, y: number, widths: number[]): string =>
  widths.map((w, i) => `<rect class="il-text" x="${x}" y="${y + i * 9}" width="${w}" height="4" rx="2"/>`).join('');

const SCENES: Record<IllustrationName, string> = {
  connect: `${backdrop}
    <rect class="il-card" x="18" y="40" width="44" height="50" rx="8"/>
    <rect class="il-accent-soft" x="26" y="50" width="28" height="6" rx="3"/>${lines(26, 62, [28, 20, 24])}
    <rect class="il-card" x="98" y="40" width="44" height="50" rx="8"/>
    <circle class="il-accent" cx="120" cy="58" r="7"/>${lines(106, 72, [28, 18])}
    <path class="il-dash" d="M62 65 H98"/>
    <g class="il-float"><circle class="il-card" cx="80" cy="65" r="11"/><path class="il-stroke" d="M76 61v-4M84 61v-4M74 61h12v4a6 6 0 0 1-12 0z"/></g>`,
  inbox: `${backdrop}
    <g class="il-float"><rect class="il-card" x="50" y="18" width="60" height="40" rx="6"/>${lines(58, 28, [44, 34, 40])}</g>
    <path class="il-card" d="M32 66 L46 46 H114 L128 66 V96 a6 6 0 0 1-6 6 H38 a6 6 0 0 1-6-6z"/>
    <path class="il-stroke" d="M32 66 H60 a20 10 0 0 0 40 0 H128"/>`,
  search: `${backdrop}
    <rect class="il-card" x="34" y="24" width="64" height="80" rx="8"/>${lines(44, 38, [44, 36, 40, 28, 38, 24])}
    <g class="il-float"><circle class="il-lens" cx="104" cy="70" r="20"/><path class="il-handle" d="M118 84 L134 100"/></g>`,
  chart: `${backdrop}
    <rect class="il-card" x="24" y="26" width="112" height="76" rx="8"/>
    <path class="il-grid" d="M36 88 H124 M36 70 H124 M36 52 H124"/>
    <path class="il-line" d="M36 82 L56 66 L74 72 L94 46 L112 54 L124 40"/>
    <g class="il-float"><circle class="il-accent" cx="94" cy="46" r="5"/><circle class="il-warm" cx="124" cy="40" r="5"/></g>`,
  documents: `${backdrop}
    <rect class="il-card il-tilt-l" x="34" y="30" width="56" height="70" rx="6"/>
    <rect class="il-card" x="52" y="22" width="56" height="74" rx="6"/>${lines(60, 36, [40, 32, 38, 26, 36])}
    <g class="il-float"><rect class="il-accent-soft" x="92" y="70" width="38" height="24" rx="6"/><path class="il-stroke" d="M100 82 h22"/></g>`,
  chat: `${backdrop}
    <path class="il-card" d="M26 34 h70 a8 8 0 0 1 8 8 v26 a8 8 0 0 1-8 8 H48 l-12 10 v-10 h-10 a8 8 0 0 1-8-8 V42 a8 8 0 0 1 8-8z"/>${lines(30, 46, [56, 44])}
    <g class="il-float"><path class="il-accent-card" d="M70 64 h58 a8 8 0 0 1 8 8 v18 a8 8 0 0 1-8 8 h-8 v9 l-11-9 H70 a8 8 0 0 1-8-8 V72 a8 8 0 0 1 8-8z"/>
    <path class="il-spark" d="M86 74 l3 7 7 3 -7 3 -3 7 -3-7 -7-3 7-3z"/></g>`,
  select: `${backdrop}
    <rect class="il-card" x="26" y="24" width="80" height="22" rx="6"/>${lines(34, 33, [52])}
    <rect class="il-card il-picked" x="26" y="52" width="80" height="22" rx="6"/>${lines(34, 61, [44])}
    <rect class="il-card" x="26" y="80" width="80" height="22" rx="6"/>${lines(34, 89, [56])}
    <g class="il-float"><path class="il-cursor" d="M104 58 l22 9 -10 3 -3 10z"/></g>`,
  error: `${backdrop}
    <path class="il-card" d="M48 90 a20 20 0 0 1 2-40 a26 26 0 0 1 50-4 a18 18 0 0 1 10 44z"/>
    <g class="il-float"><circle class="il-bad" cx="80" cy="74" r="13"/><path class="il-x" d="M75 69 l10 10 M85 69 l-10 10"/></g>`,
  done: `${backdrop}
    <g class="il-float"><circle class="il-accent" cx="80" cy="62" r="26"/><path class="il-check" d="M68 62 l8 8 16-16"/></g>
    <circle class="il-warm" cx="40" cy="40" r="4"/><circle class="il-accent-soft-dot" cx="124" cy="38" r="5"/>
    <rect class="il-warm" x="118" y="86" width="8" height="8" rx="2" transform="rotate(20 122 90)"/><circle class="il-accent" cx="36" cy="88" r="3"/>`,
  launch: `${backdrop}
    <g class="il-float"><path class="il-card" d="M80 18 c14 10 20 28 18 48 l-36 0 c-2-20 4-38 18-48z"/>
    <circle class="il-accent" cx="80" cy="44" r="7"/>
    <path class="il-warm-fill" d="M62 66 l-10 14 14-4z M98 66 l10 14 -14-4z"/>
    <path class="il-flame" d="M72 68 h16 l-8 20z"/></g>
    <path class="il-dash" d="M30 100 H130"/>`,
};

export function illustration(name: IllustrationName, size = 160): string {
  return `<svg class="illustration" viewBox="0 0 160 120" width="${size}" height="${Math.round((size * 3) / 4)}" aria-hidden="true" focusable="false">${SCENES[name]}</svg>`;
}

export const ILLUSTRATIONS = Object.keys(SCENES) as IllustrationName[];
