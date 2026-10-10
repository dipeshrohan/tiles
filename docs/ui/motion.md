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

## Page transitions

Moving to another page uses the browser's View Transitions API (U3.02, `navigate` in `js/app.ts`). The old page fades out over `--dur-fast`, and the new one fades and rises in over `--dur-slow`. The page head is kept in place while its words change, and the menu and top bar stay still. A record opened from a link on the same page or in the breadcrumbs (a place on the Plant page, say) grows from that link into its page head. A page drawn again, the first page drawn and a record reached with Back don't move.

Where the browser has no view transitions, or less motion is asked for, nothing moves. Either way the new page's heading takes the focus (its `h1` has `tabindex="-1"`, from `pageHead`; a page drawing its own `h1` gives it one too), and a screen reader reads it. A page without one has its title announced instead. Scrolled down, the old page's head is above the window, so it isn't held; the page only cross-fades.

## Micro-interactions

When a page is drawn again in place (a refresh, an action on it: `js/lib/micro.ts`, U3.04), what changed moves a little, so the eye follows it. A new page and the first drawing don't.

- **Rows:** a row with a `data-key` added to a list fades and rises in over `--dur`; one removed fades out over `--dur-fast` and then goes. It can't be used while it fades (`inert`), and the morph doesn't take it for another row.
- **Numbers:** a KPI's value (`.kpi .value`, or anything with `data-tick`) counts from its old value to its new one over `--dur-slow`, written as the page writes it. Text that isn't one number, or whose unit changed, just changes.
- **Highlights:** the highlight of the selected tab, segment or row (its `::before`) slides and stretches from the one selected before over `--dur`, while the words stay where they are.
- **Sections:** a `<details>` opened shows its content fading and rising in over `--dur`, and closes at once. Its height changes in one step, since only opacity and transform move.
- **Hover, press and focus:** every control answers hover, press (a small `scale`) and focus (a ring), using the tokens. `test/motion.test.js` checks the list.

The style guide's Motion section has a sample of each.

## Reduced motion

When the system asks for less motion (`prefers-reduced-motion: reduce`), or a person turns it on in Tiles (U6.06 sets `data-motion="reduce"` on the root element), nothing moves, and no view transition or micro-interaction starts (`lessMotion()` in `js/lib/dom.ts`). Things appear and go at once, and spinners and shimmers show without turning. One rule in `css/styles.css` does this for each case, leaving out only the skeletons' wait. A new animation needs nothing extra to follow it. A scroll started from script is out of CSS's reach: pass `behavior: scrollBehavior()` (`js/lib/dom.ts`), never `'smooth'`.

## Adding motion

1. Choose the duration by size: fast, standard or slow.
2. Choose the easing by direction: in or out.
3. Animate opacity and transform only.
4. Check that it isn't a second thing moving in the same place at the same time.
5. Look at it with reduced motion on.
