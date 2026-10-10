# Motion in Tiles

How things move in the browser app (U3.01). Motion helps people follow what changed, such as a new page, a dialog opening or a toast arriving. It never decorates, and it never waits on anyone. `test/motion.test.js` checks the rules a test can see in `css/styles.css`.

## Durations

Use the tokens in `css/styles.css`'s `:root`; never write a time in a rule.

| Token | Time | For |
| --- | --- | --- |
| `--dur-fast` | 120 ms | Hover and press: a button's colour, a row's background |
| `--dur` | 200 ms | Something appearing over the page: a toast, a tooltip, a dialog, the command palette, an expanding section |
| `--dur-slow` | 320 ms | Something large: a new page, a sheet, an empty state's illustration rising |
| `--dur-spin` | 900 ms | One turn of a spinner (progress only) |
| `--dur-shimmer` | 1400 ms | One pass of a skeleton's shimmer (progress only) |

The 300 ms before skeletons appear (`--wait`, U2.04) is a wait, not motion: it stays the same with reduced motion.

## Easing

- **Entering:** `--ease-out`, fast then settling (`cubic-bezier(0.2, 0, 0, 1)`).
- **Leaving:** `--ease-in`, starting slowly then gone (`cubic-bezier(0.4, 0, 1, 1)`).

Spinners and shimmers turn at a steady speed (`linear`).

## What moves

- **Only opacity and transform** (translate, scale, rotate). Nothing that changes layout moves: no width, height, margin, padding, position offsets or gaps. A change of size happens at once, and what appears fades or slides in.
- **Colour and shadow** may change over `--dur-fast` on hover, press and focus. That is feedback, not motion.
- **Distances are short:** 4 to 24 px, or a scale of 0.96 to 1.

## Rules

- **One thing moves at a time in one place.** A new page comes in as a whole; its cards don't also arrive one by one. A dialog opens over a still page.
- **Nothing loops,** except progress while work runs: a spinner on a busy button, and a skeleton's shimmer while a page loads. An empty state's illustration rises once, with it.
- **Nothing blocks.** An animation never delays an action: a button works while its toast slides in, and a page can be used while it enters.
- **Leaving is quicker than entering,** or instant: what goes uses `--dur-fast` and `--ease-in`.

## Reduced motion

When the system asks for less motion (`prefers-reduced-motion: reduce`), or a person turns it on in Tiles (U6.06 sets `data-motion="reduce"` on the root element), nothing moves. Things appear and go at once, and spinners and shimmers show without turning. One rule in `css/styles.css` does this for each case, leaving out only the skeletons' wait. A new animation needs nothing extra to follow it. A scroll started from script is out of CSS's reach: pass `behavior: scrollBehavior()` (`js/lib/dom.ts`), never `'smooth'`.

## Adding motion

1. Choose the duration by size: fast, standard or slow.
2. Choose the easing by direction: in or out.
3. Animate opacity and transform only.
4. Check that it isn't a second thing moving in the same place at the same time.
5. Look at it with reduced motion on.
