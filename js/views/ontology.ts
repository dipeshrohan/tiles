import { NODE_TYPES, healthCheck, neighbors, pathTo, diffStats } from '../lib/ontology.ts';
import { historyOps, safeWorkingGraph } from '../lib/ontology-store.ts';
import { seedOntology } from '../lib/data.ts';
import { esc, field, onAll, onSubmit, timeAgo } from '../lib/dom.ts';
import type { DiffStats, Graph, HealthIssue, HealthReport, NodeType, Op } from '../lib/types.ts';
import type { Context, View } from './types.ts';

interface OntologyUi {
  tab: 'canvas' | 'history' | 'health';
  selected: string | null;
  hidden: NodeType[];
}

const uiState = (ctx: Context) => ctx.ui<OntologyUi>('ontology', { tab: 'canvas', selected: null, hidden: [] });

const COLUMNS: NodeType[][] = [
  ['Site'],
  ['Workcenter'],
  ['Line'],
  ['Machine'],
  ['Process', 'PLC'],
  ['Material', 'Signal'],
  ['Document', 'Model'],
];
const BOX = { w: 134, h: 28, colGap: 152, rowGap: 38, pad: 16 };
const RELS = ['contains', 'runs', 'consumes', 'controlledBy', 'emits', 'describes', 'reads', 'monitors', 'feeds'];

type Point = { x: number; y: number };

function layout(graph: Graph, hidden: Set<NodeType>): Map<string, Point> {
  const nodes = Object.values(graph.nodes).filter((n) => !hidden.has(n.type));
  const pos = new Map<string, Point>();
  COLUMNS.forEach((types, c) => {
    const col = nodes.filter((n) => types.includes(n.type));
    // Order by the average row of already-placed neighbours to reduce crossings.
    const weight = (n: { id: string }) => {
      const ys = neighbors(graph, n.id)
        .map((x) => pos.get(x.node.id)?.y)
        .filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    col
      .map((n) => ({ n, w: weight(n), t: types.indexOf(n.type) }))
      .sort((a, b) => a.t - b.t || a.w - b.w || a.n.label.localeCompare(b.n.label))
      .forEach(({ n }, i) => {
        pos.set(n.id, { x: BOX.pad + c * BOX.colGap, y: BOX.pad + i * BOX.rowGap });
      });
  });
  return pos;
}

const short = (s: string, n = 19): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeOp(op: Op, graph: Graph): string {
  const label = (id: string) => graph.nodes[id]?.label ?? id;
  switch (op.kind) {
    case 'addNode':
      return `+ ${op.node.type} “${op.node.label}”`;
    case 'removeNode':
      return `− node ${op.id}`;
    case 'addEdge':
      return `+ ${label(op.edge.from)} —${op.edge.rel}→ ${label(op.edge.to)}`;
    case 'removeEdge':
      return `− relationship ${op.id}`;
    case 'setProp':
      return op.value === undefined ? `− ${label(op.id)}.${op.key}` : `~ ${label(op.id)}.${op.key} = ${op.value}`;
  }
}

function statBadges(s: DiffStats): string {
  const b = (n: number, what: string) =>
    n
      ? `<span class="badge"><span class="${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span> ${what}</span>`
      : '';
  return b(s.nodes, 'node') + b(s.edges, 'edge') + b(s.props, 'prop');
}

function canvas(ctx: Context, graph: Graph, health: HealthReport, ui: OntologyUi): string {
  const hidden = new Set(ui.hidden);
  const pos = layout(graph, hidden);
  const issueIds = new Set(health.issues.filter((i) => i.level !== 'info').map((i) => i.ref));
  const stagedIds = new Set(ctx.state.repo.staged.flatMap(touchedIds));
  const placed = [...pos.entries()];
  const width = Math.max(...placed.map(([, p]) => p.x), 0) + BOX.w + BOX.pad;
  const height = Math.max(...placed.map(([, p]) => p.y), 0) + BOX.h + BOX.pad;
  const edges = Object.values(graph.edges)
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const fwd = b.x >= a.x;
      const x1 = fwd ? a.x + BOX.w : a.x;
      const x2 = fwd ? b.x : b.x + BOX.w;
      const y1 = a.y + BOX.h / 2;
      const y2 = b.y + BOX.h / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
      const hl = ui.selected && (e.from === ui.selected || e.to === ui.selected);
      return `<path class="edge ${hl ? 'hl' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"><title>${esc(graph.nodes[e.from]?.label)} —${esc(e.rel)}→ ${esc(graph.nodes[e.to]?.label)}</title></path>`;
    })
    .join('');
  const nodes = placed
    .map(([id, p]) => {
      const n = graph.nodes[id];
      if (!n) return '';
      const cls = ['node', ui.selected === id && 'sel', issueIds.has(id) && 'issue', stagedIds.has(id) && 'staged']
        .filter(Boolean)
        .join(' ');
      return `<g class="${cls}" data-node="${esc(id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.type)} ${esc(n.label)}">
          <rect width="${BOX.w}" height="${BOX.h}" rx="6"/>
          <rect width="5" height="${BOX.h}" rx="2" fill="${NODE_TYPES[n.type].color}" stroke="none"/>
          <text x="13" y="18">${esc(short(n.label))}</text>
          <title>${esc(n.type)}: ${esc(n.label)}</title>
        </g>`;
    })
    .join('');

  const legend = (Object.entries(NODE_TYPES) as [NodeType, { color: string }][])
    .map(
      ([t, def]) =>
        `<button class="chip" data-type="${t}" aria-pressed="${!hidden.has(t)}" style="${hidden.has(t) ? 'opacity:.4' : ''}"><span class="dot" style="background:${def.color}"></span> ${t}</button>`,
    )
    .join('');

  return `
      <div class="onto">
        <div>
          <div class="canvas-wrap"><svg style="width:100%;min-width:${Math.round(width * 0.8)}px;max-width:${width}px;height:auto" viewBox="0 0 ${width} ${Math.max(height, 200)}">${edges}${nodes}</svg></div>
          <div class="statusbar">
            <span>Nodes: ${Object.keys(graph.nodes).length}</span><span>Relationships: ${Object.keys(graph.edges).length}</span>
            <span class="spacer"></span>
          </div>
          <div class="chips" style="margin-top:8px">${legend}</div>
        </div>
        <div class="card" id="inspector">${ui.selected ? inspector(graph, ui.selected) : ctx.ontology.role === 'viewer' ? viewOnlyNote() : newNodeForm(graph)}</div>
      </div>`;
}

function inspector(graph: Graph, id: string): string {
  const n = graph.nodes[id];
  if (!n) return '';
  const rels = neighbors(graph, id);
  const path = pathTo(graph, id);
  const props = Object.entries(n.props ?? {});
  const required = NODE_TYPES[n.type].required.filter((r) => n.props?.[r] === undefined);
  const others = Object.values(graph.nodes)
    .filter((o) => o.id !== id)
    .sort((a, b) => a.label.localeCompare(b.label));
  return `
      <div class="card-head">
        <div><span class="badge"><span class="dot" style="background:${NODE_TYPES[n.type].color}"></span>${esc(n.type)}</span><h2 style="margin-top:6px">${esc(n.label)}</h2><div class="muted small mono">${esc(n.id)}</div></div>
        <button class="btn sm" data-deselect aria-label="Close">✕</button>
      </div>
      ${path.length > 1 ? `<p class="small soft" style="margin-bottom:12px">${path.map((p) => esc(p.label)).join(' → ')}</p>` : ''}
      <h3 style="margin-bottom:6px">Properties</h3>
      <div class="kv">
        ${props.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span><button class="btn sm" data-unset="${esc(k)}" aria-label="Remove ${esc(k)}">✕</button>`).join('') || '<span class="muted small" style="grid-column:span 3">No properties</span>'}
      </div>
      ${required.length ? `<p class="small" style="color:var(--warn);margin-top:6px">Missing required: ${required.map(esc).join(', ')}</p>` : ''}
      <form class="row" id="prop-form" style="margin:8px 0 16px">
        <input type="text" name="key" placeholder="key" style="width:90px" value="${esc(required[0] ?? '')}" required aria-label="Property key" />
        <input type="text" name="value" placeholder="value" style="flex:1;width:90px" required aria-label="Property value" />
        <button class="btn sm" type="submit">Set</button>
      </form>
      <h3 style="margin-bottom:6px">Relationships</h3>
      <div class="rel-list">
        ${rels.map((r) => `<div class="rel">${r.outgoing ? '' : '<span class="r">←</span>'}<span class="r">${esc(r.edge.rel)}</span><a href="#/ontology" data-goto="${esc(r.node.id)}">${esc(r.node.label)}</a><span class="spacer"></span><button class="btn sm" data-unlink="${esc(r.edge.id)}" aria-label="Remove relationship">✕</button></div>`).join('') || '<span class="muted small">No relationships — this node is an orphan</span>'}
      </div>
      <form class="row" id="link-form" style="margin:8px 0 16px">
        <select name="rel" aria-label="Relationship">${RELS.map((r) => `<option>${r}</option>`).join('')}</select>
        <select name="to" style="flex:1;width:100px" aria-label="Target node">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select>
        <button class="btn sm" type="submit">Link</button>
      </form>
      <button class="btn danger sm" data-delete ${rels.length ? `disabled title="Remove its ${rels.length} relationship(s) first"` : ''}>Delete node</button>`;
}

// Controls that change the ontology; removed for viewers (the API refuses
// their writes anyway, this just keeps the page honest).
const EDIT_CONTROLS =
  '#node-form, #prop-form, #link-form, [data-unset], [data-unlink], [data-delete], [data-fix-delete], [data-revert], [data-import-demo]';

function viewOnlyNote(): string {
  return `
      <div class="card-head"><h2>View only</h2></div>
      <p class="small soft">Your role on this site is viewer. Select a node on the canvas to inspect it. To make changes, ask a site admin for the engineer role.</p>`;
}

function newNodeForm(graph: Graph): string {
  const nodes = Object.values(graph.nodes).sort((a, b) => a.label.localeCompare(b.label));
  return `
      <div class="card-head"><h2>New node</h2></div>
      <p class="small soft" style="margin-bottom:12px">Select a node on the canvas to inspect it, or stage a new one here.</p>
      <form class="stack" id="node-form" style="gap:10px;max-width:520px">
        <label class="field">Type<select name="type">${Object.keys(NODE_TYPES)
          .map((t) => `<option>${t}</option>`)
          .join('')}</select></label>
        <label class="field">Label<input type="text" name="label" placeholder="e.g. Alarm stream DC-02" required /></label>
        <label class="field">Link from (optional)<select name="from"><option value="">— none —</option>${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`).join('')}</select></label>
        <label class="field">Relationship<select name="rel">${RELS.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <button class="btn primary" type="submit">+ Stage node</button>
      </form>`;
}

function history(ctx: Context, graph: Graph): string {
  const { history } = ctx.state.repo;
  return `<div class="card">${history
    .map(
      (c, i) => `
        <div class="commit">
          <span class="avatar" style="background:${i === 0 ? 'var(--accent)' : 'var(--line-strong)'}">${esc((c.author[0] ?? '?').toUpperCase())}</span>
          <div style="flex:1;min-width:0">
            <div><b>${esc(c.message)}</b></div>
            <div class="small muted">${esc(c.author)} · ${timeAgo(c.date)} · <span class="mono">${esc(c.id.slice(-7))}</span></div>
            <div class="stats">${statBadges(c.stats)}</div>
            <details style="margin-top:6px"><summary class="small soft" style="cursor:pointer">${c.ops.length} operation(s)</summary>
              <div class="diff" style="margin-top:6px">${c.ops
                .slice(0, 60)
                .map((op) => `<div>${esc(describeOp(op, graph))}</div>`)
                .join('')}${c.ops.length > 60 ? `<div>… ${c.ops.length - 60} more</div>` : ''}</div>
            </details>
          </div>
          <button class="btn sm" data-revert="${esc(c.id)}">Revert</button>
        </div>`,
    )
    .join('')}</div>`;
}

function healthTab(health: HealthReport, graph: Graph): string {
  const fix = (i: HealthIssue) => {
    if (i.kind === 'orphan') return `<button class="btn sm" data-fix-delete="${esc(i.ref)}">Stage delete</button>`;
    if (i.kind === 'duplicate') return `<button class="btn sm" data-unlink="${esc(i.ref)}">Remove duplicate</button>`;
    if (graph.nodes[i.ref]) return `<button class="btn sm" data-goto="${esc(i.ref)}">Inspect</button>`;
    return '';
  };
  return `
      <div class="grid g3" style="margin-bottom:16px">
        <div class="card kpi ${health.score === 100 ? 'good' : ''}"><div class="label">Health score</div><div class="value">${health.score}</div></div>
        <div class="card kpi"><div class="label">Nodes</div><div class="value">${health.counts.nodes}</div></div>
        <div class="card kpi"><div class="label">Relationships</div><div class="value">${health.counts.edges}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Checks</h2><p>Orphan nodes, dangling and duplicate relationships, and required properties per type.</p></div>
        ${health.issues.map((i) => `<div class="issue"><span class="badge ${i.level === 'info' ? '' : 'bad'}">${esc(i.kind)}</span><span style="flex:1">${esc(i.text)}</span>${fix(i)}</div>`).join('') || '<div class="empty">All checks pass ✓</div>'}
      </div>`;
}

// Ids of nodes an op touches, to highlight staged changes on the canvas.
function touchedIds(op: Op): string[] {
  switch (op.kind) {
    case 'addNode':
      return [op.node.id];
    case 'addEdge':
      return [op.edge.from, op.edge.to];
    default:
      return [op.id];
  }
}

function pageHead(): string {
  return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Operations · Ontology</div>
          <h1>A map of the factory</h1>
          <p>Site → Workcenter → Line → Machine, linked to processes, materials, PLCs, signals, documents and models. Edits are staged, committed with a message, and reversible.</p>
        </div>
      </div>`;
}

// Where this ontology lives, shown only in API mode.
function sourceBar(ctx: Context): string {
  const o = ctx.ontology;
  if (o.status === 'local') return '';
  if (o.status === 'loading')
    return '<div class="card source-bar" aria-live="polite">Loading the ontology from the Tiles API…</div>';
  if (o.status === 'error')
    return `<div class="card source-bar" role="alert"><b>Can't load the ontology from the Tiles API.</b> <span class="soft">${esc(o.error)}</span> <span class="row" style="gap:8px;margin-top:8px">${ctx.auth.config?.enabled && !ctx.auth.signedIn ? '<button class="btn sm primary" data-sign-in>Sign in</button>' : ''}<a class="btn sm" href="#/settings">Data source settings</a></span></div>`;
  const { head, history, staged } = ctx.state.repo;
  const empty = !Object.keys(head.nodes).length && !history.length && !staged.length;
  return `<div class="card source-bar small" aria-live="polite">
      <span>Shared through the Tiles API · <b>${esc(o.site?.name)}</b> · everyone on this site sees each commit.${o.role === 'viewer' ? ' <span class="badge">View only</span>' : ''}</span>
      <span class="row" style="gap:8px">${empty ? '<button class="btn sm primary" data-import-demo>Load demo ontology</button>' : ''}<button class="btn sm" data-refresh>Refresh</button></span>
    </div>`;
}

const view: View = {
  id: 'ontology',
  title: 'Ontology builder',
  icon: '⬡',
  render(ctx) {
    const ui = uiState(ctx);
    const { repo } = ctx.state;
    const graph = ctx.graph;
    const source = sourceBar(ctx);
    if (ctx.ontology.status === 'loading' || ctx.ontology.status === 'error') return pageHead() + source;
    const health = healthCheck(graph);
    if (ui.selected && !graph.nodes[ui.selected]) ui.selected = null;

    const { conflict } = safeWorkingGraph(repo);
    const stagedBar = conflict
      ? `<div class="staged-bar" role="alert">
          <span class="badge bad">${repo.staged.length} uncommitted</span>
          <span style="flex:1">Your staged changes no longer fit the latest commits (${esc(conflict)}). Discard them, then redo what you still need.</span>
          <button class="btn" type="button" data-discard>Discard</button>
        </div>`
      : repo.staged.length && ctx.ontology.role === 'viewer'
        ? // Staged before an admin made them a viewer: they can still throw it away.
          `<div class="staged-bar" id="viewer-staged">
          <span class="badge warn">${repo.staged.length} uncommitted</span>
          <span style="flex:1">You staged these changes before your role became viewer, so they can't be committed. Discard them to see the latest commit.</span>
          <button class="btn" type="button" data-discard>Discard</button>
        </div>`
        : repo.staged.length
          ? `<form class="staged-bar" id="commit-form">
          <span class="badge warn">${repo.staged.length} uncommitted</span>
          <span class="small soft">${statBadges(diffStats(repo.staged))}</span>
          <input type="text" name="message" placeholder="Describe this change, e.g. “add alarms node to ontology”" aria-label="Commit message" required />
          <button class="btn primary" type="submit">Commit</button>
          <button class="btn" type="button" data-discard>Discard</button>
        </form>`
          : '';

    const tabs = [
      ['canvas', 'Canvas'],
      ['history', `History <span class="badge">${repo.history.length}</span>`],
      [
        'health',
        `Health <span class="badge ${health.issues.some((i) => i.level !== 'info') ? 'bad' : 'good'}">${health.score}</span>`,
      ],
    ];

    let body = '';
    if (ui.tab === 'canvas') body = canvas(ctx, graph, health, ui);
    if (ui.tab === 'history') body = history(ctx, graph);
    if (ui.tab === 'health') body = healthTab(health, graph);

    return `
      ${pageHead()}
      ${source}
      ${stagedBar}
      <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button class="tab ${ui.tab === id ? 'active' : ''}" data-tab="${id}" role="tab">${label}</button>`).join('')}</div>
      ${body}`;
  },

  bind(root, ctx) {
    const ui = uiState(ctx);
    if (ctx.ontology.role === 'viewer') root.querySelectorAll(EDIT_CONTROLS).forEach((el) => el.remove());
    const author = ctx.state.user.email;
    const stageOps = (ops: Op[], ok?: string) => ctx.ontology.act((store, repo) => store.stage(repo, ops), ok);
    const stageOp = (op: Op, ok?: string) => stageOps([op], ok);
    onAll(root, '[data-refresh]', 'click', () => void ctx.ontology.reload());
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onAll(root, '[data-import-demo]', 'click', async (el) => {
      el.setAttribute('disabled', '');
      const ops = historyOps(seedOntology());
      if (await stageOps(ops))
        await ctx.ontology.act(
          (store, repo) => store.commit(repo, 'Import demo ontology', author),
          'Demo ontology imported',
        );
    });
    const selected = (): string | null => ui.selected;

    onAll(root, '[data-tab]', 'click', (el) => {
      const tab = el.dataset.tab;
      if (tab === 'canvas' || tab === 'history' || tab === 'health') ui.tab = tab;
      ctx.rerender();
    });
    const select = (id: string | undefined) => {
      if (!id) return;
      ui.selected = id;
      ctx.rerender();
      const panel = document.getElementById('inspector');
      const r = panel?.getBoundingClientRect();
      if (panel && r && (r.top > window.innerHeight || r.bottom < 0))
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    onAll(root, '[data-node]', 'click', (el) => select(el.dataset.node));
    onAll(root, '[data-node]', 'keydown', (el, e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(el.dataset.node);
      }
    });
    onAll(root, '[data-goto]', 'click', (el, e) => {
      e.preventDefault();
      ui.selected = el.dataset.goto ?? null;
      ui.tab = 'canvas';
      ctx.rerender();
    });
    onAll(root, '[data-deselect]', 'click', () => {
      ui.selected = null;
      ctx.rerender();
    });
    onAll(root, '[data-type]', 'click', (el) => {
      const t = el.dataset.type as NodeType | undefined;
      if (!t) return;
      ui.hidden = ui.hidden.includes(t) ? ui.hidden.filter((x) => x !== t) : [...ui.hidden, t];
      ctx.rerender();
    });
    onAll(root, '[data-unset]', 'click', (el) => {
      const id = selected();
      if (id && el.dataset.unset) stageOp({ kind: 'setProp', id, key: el.dataset.unset });
    });
    onAll(root, '[data-unlink]', 'click', (el) => {
      if (el.dataset.unlink) stageOp({ kind: 'removeEdge', id: el.dataset.unlink }, 'Relationship removal staged');
    });
    onAll(root, '[data-delete]', 'click', () => {
      const id = selected();
      if (!id) return;
      ui.selected = null;
      stageOp({ kind: 'removeNode', id }, 'Node deletion staged');
    });
    onAll(root, '[data-fix-delete]', 'click', (el) => {
      if (el.dataset.fixDelete) stageOp({ kind: 'removeNode', id: el.dataset.fixDelete }, 'Node deletion staged');
    });
    onAll(root, '[data-discard]', 'click', () =>
      ctx.ontology.act((store, repo) => store.discard(repo), 'Changes discarded'),
    );
    onAll(root, '[data-revert]', 'click', (el) => {
      const id = el.dataset.revert;
      if (id) void ctx.ontology.act((store, repo) => store.revert(repo, id, author), 'Commit reverted');
    });

    onSubmit(root, '#commit-form', (form) => {
      const message = field(form, 'message');
      void ctx.ontology.act((store, repo) => store.commit(repo, message, author), 'Committed');
    });
    onSubmit(root, '#prop-form', (form) => {
      const id = selected();
      if (!id) return;
      const key = field(form, 'key').trim();
      const raw = field(form, 'value').trim();
      const value = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
      stageOp({ kind: 'setProp', id, key, value });
    });
    onSubmit(root, '#link-form', (form) => {
      const from = selected();
      if (!from) return;
      const rel = field(form, 'rel');
      const to = field(form, 'to');
      stageOp({ kind: 'addEdge', edge: { id: `${from}-${rel}-${to}`, from, rel, to } });
    });
    onSubmit(root, '#node-form', (form) => {
      const type = field(form, 'type') as NodeType;
      const label = field(form, 'label').trim();
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30) || 'node';
      let id = `${type.toLowerCase()}-${slug}`;
      for (let k = 2; ctx.graph.nodes[id]; k++) id = `${type.toLowerCase()}-${slug}-${k}`;
      const from = field(form, 'from');
      const rel = field(form, 'rel');
      const ops: Op[] = [{ kind: 'addNode', node: { id, type, label, props: {} } }];
      if (from) ops.push({ kind: 'addEdge', edge: { id: `${from}-${rel}-${id}`, from, rel, to: id } });
      void stageOps(ops, 'Node staged — commit to save it').then((ok) => {
        if (ok) {
          ui.selected = id;
          ctx.rerender();
        }
      });
    });
  },
};

export default view;
