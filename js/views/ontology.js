import {
  NODE_TYPES,
  stage,
  commit,
  discard,
  revert,
  healthCheck,
  neighbors,
  pathTo,
  diffStats,
} from '../lib/ontology.ts';
import { esc, timeAgo } from '../lib/dom.ts';

const COLUMNS = [
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

function layout(graph, hidden) {
  const nodes = Object.values(graph.nodes).filter((n) => !hidden.has(n.type));
  const pos = {};
  COLUMNS.forEach((types, c) => {
    const col = nodes.filter((n) => types.includes(n.type));
    // Order by the average row of already-placed neighbours to reduce crossings.
    const weight = (n) => {
      const ys = neighbors(graph, n.id)
        .map((x) => pos[x.node?.id]?.y)
        .filter((y) => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    col
      .map((n) => ({ n, w: weight(n), t: types.indexOf(n.type) }))
      .sort((a, b) => a.t - b.t || a.w - b.w || a.n.label.localeCompare(b.n.label))
      .forEach(({ n }, i) => {
        pos[n.id] = { x: BOX.pad + c * BOX.colGap, y: BOX.pad + i * BOX.rowGap };
      });
  });
  return pos;
}

const short = (s, n = 19) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeOp(op, graph) {
  const label = (id) => graph.nodes[id]?.label ?? id;
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
    default:
      return op.kind;
  }
}

function statBadges(s) {
  const b = (n, what) =>
    n
      ? `<span class="badge"><span class="${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span> ${what}</span>`
      : '';
  return b(s.nodes, 'node') + b(s.edges, 'edge') + b(s.props, 'prop');
}

export default {
  id: 'ontology',
  title: 'Ontology builder',
  icon: '⬡',
  render(ctx) {
    const ui = ctx.ui('ontology', { tab: 'canvas', selected: null, hidden: [] });
    const { repo } = ctx.state;
    const graph = ctx.graph;
    const health = healthCheck(graph);
    if (ui.selected && !graph.nodes[ui.selected]) ui.selected = null;

    const stagedBar = repo.staged.length
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
    if (ui.tab === 'canvas') body = this.canvas(ctx, graph, health, ui);
    if (ui.tab === 'history') body = this.history(ctx, graph);
    if (ui.tab === 'health') body = this.health(health, graph);

    return `
      <div class="page-head">
        <div>
          <div class="eyebrow">Operations · Ontology</div>
          <h1>A map of the factory</h1>
          <p>Site → Workcenter → Line → Machine, linked to processes, materials, PLCs, signals, documents and models. Edits are staged, committed with a message, and reversible.</p>
        </div>
      </div>
      ${stagedBar}
      <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button class="tab ${ui.tab === id ? 'active' : ''}" data-tab="${id}" role="tab">${label}</button>`).join('')}</div>
      ${body}`;
  },

  canvas(ctx, graph, health, ui) {
    const hidden = new Set(ui.hidden);
    const pos = layout(graph, hidden);
    const issueIds = new Set(health.issues.filter((i) => i.level !== 'info').map((i) => i.ref));
    const stagedIds = new Set(
      ctx.state.repo.staged.flatMap((op) => [op.node?.id, op.id, op.edge?.from, op.edge?.to]).filter(Boolean),
    );
    const ids = Object.keys(pos);
    const width = Math.max(...ids.map((id) => pos[id].x), 0) + BOX.w + BOX.pad;
    const height = Math.max(...ids.map((id) => pos[id].y), 0) + BOX.h + BOX.pad;
    const edges = Object.values(graph.edges)
      .filter((e) => pos[e.from] && pos[e.to])
      .map((e) => {
        const a = pos[e.from];
        const b = pos[e.to];
        const fwd = b.x >= a.x;
        const x1 = fwd ? a.x + BOX.w : a.x;
        const x2 = fwd ? b.x : b.x + BOX.w;
        const y1 = a.y + BOX.h / 2;
        const y2 = b.y + BOX.h / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
        const hl = ui.selected && (e.from === ui.selected || e.to === ui.selected);
        return `<path class="edge ${hl ? 'hl' : ''}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"><title>${esc(graph.nodes[e.from].label)} —${esc(e.rel)}→ ${esc(graph.nodes[e.to].label)}</title></path>`;
      })
      .join('');
    const nodes = ids
      .map((id) => {
        const n = graph.nodes[id];
        const p = pos[id];
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

    const legend = Object.entries(NODE_TYPES)
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
        <div class="card" id="inspector">${ui.selected ? this.inspector(ctx, graph, ui.selected) : this.newNodeForm(graph)}</div>
      </div>`;
  },

  inspector(ctx, graph, id) {
    const n = graph.nodes[id];
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
  },

  newNodeForm(graph) {
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
  },

  history(ctx, graph) {
    const { history } = ctx.state.repo;
    return `<div class="card">${history
      .map(
        (c, i) => `
        <div class="commit">
          <span class="avatar" style="background:${i === 0 ? 'var(--accent)' : 'var(--line-strong)'}">${esc(c.author[0].toUpperCase())}</span>
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
  },

  health(health, graph) {
    const fix = (i) => {
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
  },

  bind(root, ctx) {
    const ui = ctx.ui('ontology');
    const run = (fn, ok) => {
      try {
        ctx.update(fn);
        if (ok) ctx.toast(ok);
      } catch (err) {
        ctx.toast(err.message);
      }
    };
    const stageOp = (op, ok) => run((s) => (s.repo = stage(s.repo, op)), ok);
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(e, el)));

    on('[data-tab]', 'click', (_, el) => {
      ui.tab = el.dataset.tab;
      ctx.rerender();
    });
    const select = (id) => {
      ui.selected = id;
      ctx.rerender();
      const panel = document.getElementById('inspector');
      const r = panel?.getBoundingClientRect();
      if (r && (r.top > window.innerHeight || r.bottom < 0))
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    on('[data-node]', 'click', (_, el) => select(el.dataset.node));
    on('[data-node]', 'keydown', (e, el) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(el.dataset.node);
      }
    });
    on('[data-goto]', 'click', (e, el) => {
      e.preventDefault();
      ui.selected = el.dataset.goto;
      ui.tab = 'canvas';
      ctx.rerender();
    });
    on('[data-deselect]', 'click', () => {
      ui.selected = null;
      ctx.rerender();
    });
    on('[data-type]', 'click', (_, el) => {
      const t = el.dataset.type;
      ui.hidden = ui.hidden.includes(t) ? ui.hidden.filter((x) => x !== t) : [...ui.hidden, t];
      ctx.rerender();
    });
    on('[data-unset]', 'click', (_, el) =>
      stageOp({ kind: 'setProp', id: ui.selected, key: el.dataset.unset, value: undefined }),
    );
    on('[data-unlink]', 'click', (_, el) =>
      stageOp({ kind: 'removeEdge', id: el.dataset.unlink }, 'Relationship removal staged'),
    );
    on('[data-delete]', 'click', () => {
      const id = ui.selected;
      ui.selected = null;
      stageOp({ kind: 'removeNode', id }, 'Node deletion staged');
    });
    on('[data-fix-delete]', 'click', (_, el) =>
      stageOp({ kind: 'removeNode', id: el.dataset.fixDelete }, 'Node deletion staged'),
    );
    on('[data-discard]', 'click', () => run((s) => (s.repo = discard(s.repo)), 'Changes discarded'));
    on('[data-revert]', 'click', (_, el) =>
      run((s) => (s.repo = revert(s.repo, el.dataset.revert, { author: s.user.email })), 'Commit reverted'),
    );

    root.querySelector('#commit-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = e.target.message.value;
      run((s) => (s.repo = commit(s.repo, { message, author: s.user.email })), 'Committed');
    });
    root.querySelector('#prop-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = e.target.key.value.trim();
      const raw = e.target.value.value.trim();
      const value = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
      stageOp({ kind: 'setProp', id: ui.selected, key, value });
    });
    root.querySelector('#link-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const rel = e.target.rel.value;
      const to = e.target.to.value;
      stageOp({ kind: 'addEdge', edge: { id: `${ui.selected}-${rel}-${to}`, from: ui.selected, rel, to } });
    });
    root.querySelector('#node-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const label = f.label.value.trim();
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30) || 'node';
      let id = `${f.type.value.toLowerCase()}-${slug}`;
      for (let k = 2; ctx.graph.nodes[id]; k++) id = `${f.type.value.toLowerCase()}-${slug}-${k}`;
      const from = f.from.value;
      const rel = f.rel.value;
      run((s) => {
        let repo = stage(s.repo, { kind: 'addNode', node: { id, type: f.type.value, label, props: {} } });
        if (from) repo = stage(repo, { kind: 'addEdge', edge: { id: `${from}-${rel}-${id}`, from, rel, to: id } });
        s.repo = repo;
        ui.selected = id;
      }, 'Node staged — commit to save it');
    });
  },
};
