import { healthCheck } from '../lib/ontology.ts';
import { MODELS } from '../lib/design.ts';
import { esc, fmt, timeAgo } from '../lib/dom.ts';
import { icon } from '../lib/icons.ts';
import type { View } from './types.ts';

const view: View = {
  id: 'home',
  title: 'Home',
  icon: 'house',
  render(ctx) {
    const { state } = ctx;
    const health = healthCheck(ctx.graph);
    const ng = state.batches.filter((b) => b.ng).length;
    const predicted = state.scored.filter((s) => s.predicted);
    const lead = predicted.reduce((a, s) => a + s.leadHours, 0) / (predicted.length || 1);

    const feed = [
      ...state.repo.history.map((c) => ({
        date: c.date,
        icon: 'git-commit-horizontal' as const,
        text: `<b>${esc(c.message)}</b> <span class="muted">· ${esc(c.author)}</span>`,
        href: '#/ontology',
      })),
      ...state.runs.map((r) => ({
        date: r.date,
        icon: 'drafting-compass' as const,
        text: `<b>${esc(MODELS[r.modelId]?.name ?? r.modelId)} v${esc(r.version)}</b> run ${r.note ? `— ${esc(r.note)}` : ''} <span class="muted">· ${esc(r.author)}</span>`,
        href: '#/design',
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6);

    return `
      <section class="hero">
        <div>
          <div class="eyebrow">Tiles</div>
          <h1>Physics and plant data, in one place.</h1>
          <p>Tiles combines physics models with machine data to help design teams iterate faster and help production teams cut downtime and scrap. Every answer shows the data, model version and change behind it.</p>
          <div class="row mt-4">
            <a class="btn primary" href="#/chat">Ask the copilot</a>
            <a class="btn" href="#/physics">See live warnings</a>
          </div>
        </div>
        <div class="engine" aria-label="How it works">
          <div class="k">HOW IT WORKS</div>
          <div class="pill">Physics models</div>
          <div class="op">+</div>
          <div class="pill">Live data</div>
          <div class="op">↓</div>
          <div class="pill">Answers and warnings</div>
        </div>
      </section>

      <div class="grid g4 mb-4">
        <a class="card kpi bad text-inherit no-underline" href="#/physics">
          <div class="label">Friction warnings · DC-02</div>
          <div class="value">${state.detection.alerts.length}</div>
          <div class="note">${predicted.length}/${state.scored.length} stops predicted, ${fmt(lead, 1)} h avg lead</div>
        </a>
        <a class="card kpi text-inherit no-underline" href="#/quality">
          <div class="label">Cutter NG rate</div>
          <div class="value">${fmt((100 * ng) / state.batches.length, 1)}%</div>
          <div class="note">${ng} of ${state.batches.length} batches · root cause found</div>
        </a>
        <a class="card kpi text-inherit no-underline ${health.score < 100 ? '' : 'good'}" href="#/ontology">
          <div class="label">Ontology health</div>
          <div class="value">${health.score}</div>
          <div class="note">${health.counts.nodes} nodes · ${health.counts.edges} relationships · ${health.issues.length} issue(s)</div>
        </a>
        <a class="card kpi text-inherit no-underline" href="#/design">
          <div class="label">Design runs logged</div>
          <div class="value">${state.runs.length}</div>
          <div class="note">${Object.keys(MODELS).length} physics models in library</div>
        </a>
      </div>

      <div class="grid g3">
        <div class="card product">
          <span class="badge accent tag">for Design</span>
          <h2>Tiles Design</h2>
          <p class="soft">Design, simulate and optimise physical systems from first principles, with every run versioned and auditable.</p>
          <ul>
            <li>Versioned physics model library</li>
            <li>Parameter sweeps &amp; sensitivity</li>
            <li>Run lineage and one-click audit export</li>
          </ul>
          <a href="#/design">Open design studio →</a>
        </div>
        <div class="card product">
          <span class="badge accent tag">for Operations</span>
          <h2>Tiles Operations</h2>
          <p class="soft">Real-time troubleshooting and process control on live machines, grounded in a factory ontology.</p>
          <ul>
            <li>Virtual sensors that warn before downtime</li>
            <li>Correlation finder for quality root cause</li>
            <li>Versioned ontology with health checks</li>
          </ul>
          <a href="#/quality">Open process &amp; quality →</a>
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent activity</h2></div>
          <div class="feed">
            ${feed.map((f) => `<a class="feed-item text-inherit no-underline" href="${f.href}"><span class="muted">${icon(f.icon)}</span><span>${f.text}</span><span class="when">${timeAgo(f.date)}</span></a>`).join('') || '<div class="empty">No activity yet</div>'}
          </div>
        </div>
      </div>`;
  },
};

export default view;
