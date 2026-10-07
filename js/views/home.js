import { healthCheck } from '../lib/ontology.js';
import { MODELS } from '../lib/design.js';
import { esc, fmt, timeAgo } from '../lib/dom.js';

export default {
  id: 'home',
  title: 'Home',
  icon: '⌂',
  render(ctx) {
    const { state } = ctx;
    const health = healthCheck(ctx.graph);
    const ng = state.batches.filter((b) => b.ng).length;
    const predicted = state.scored.filter((s) => s.predicted);
    const lead = predicted.reduce((a, s) => a + s.leadHours, 0) / (predicted.length || 1);

    const feed = [
      ...state.repo.history.map((c) => ({
        date: c.date,
        icon: '⎇',
        text: `<b>${esc(c.message)}</b> <span class="muted">· ${esc(c.author)}</span>`,
        href: '#/ontology',
      })),
      ...state.runs.map((r) => ({
        date: r.date,
        icon: '∿',
        text: `<b>${esc(MODELS[r.modelId].name)} v${esc(r.version)}</b> run ${r.note ? `— ${esc(r.note)}` : ''} <span class="muted">· ${esc(r.author)}</span>`,
        href: '#/design',
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6);

    return `
      <section class="hero">
        <div>
          <div class="eyebrow" style="color:#a9d6cf">Industrial intelligence</div>
          <h1>Assembling atoms with bits.</h1>
          <p>Tiles fuses physics models with live plant data — pointed at the lab for faster design cycles, and at the shopfloor for fewer stops and less scrap. Every answer is traceable to the data, model version and change that produced it.</p>
          <div class="row" style="margin-top:18px">
            <a class="btn primary" href="#/chat" style="background:#fff;color:#173f3c;border-color:#fff">Ask the copilot</a>
            <a class="btn" href="#/physics" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.4)">See live warnings</a>
          </div>
        </div>
        <div class="engine" aria-label="The engine">
          <div class="k">THE ENGINE</div>
          <div class="pill">Physics models</div>
          <div class="op">×</div>
          <div class="pill">Live data</div>
          <div class="op">↓</div>
          <div class="pill">Agentic workflows</div>
        </div>
      </section>

      <div class="grid g4" style="margin-bottom:16px">
        <a class="card kpi bad" href="#/physics" style="color:inherit;text-decoration:none">
          <div class="label">Friction warnings · DC-02</div>
          <div class="value">${state.detection.alerts.length}</div>
          <div class="note">${predicted.length}/${state.scored.length} stops predicted, ${fmt(lead, 1)} h avg lead</div>
        </a>
        <a class="card kpi" href="#/quality" style="color:inherit;text-decoration:none">
          <div class="label">Cutter NG rate</div>
          <div class="value">${fmt((100 * ng) / state.batches.length, 1)}%</div>
          <div class="note">${ng} of ${state.batches.length} batches · root cause found</div>
        </a>
        <a class="card kpi ${health.score < 100 ? '' : 'good'}" href="#/ontology" style="color:inherit;text-decoration:none">
          <div class="label">Ontology health</div>
          <div class="value">${health.score}</div>
          <div class="note">${health.counts.nodes} nodes · ${health.counts.edges} relationships · ${health.issues.length} issue(s)</div>
        </a>
        <a class="card kpi" href="#/design" style="color:inherit;text-decoration:none">
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
            ${feed.map((f) => `<a class="feed-item" href="${f.href}" style="color:inherit;text-decoration:none"><span class="muted">${f.icon}</span><span>${f.text}</span><span class="when">${timeAgo(f.date)}</span></a>`).join('') || '<div class="empty">No activity yet</div>'}
          </div>
        </div>
      </div>`;
  },
};
