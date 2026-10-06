// Rule-based copilot: routes a question to the right skill, runs it over
// the factory data and answers with the steps it took, so every answer is
// traceable to a tool and its inputs. Runs fully offline.

import { correlationFinder, explain, wearCheck } from './analysis.js';
import { CUTTER_VARIABLES } from './data.js';
import { detectFrictionAlerts, scoreAlerts } from './physics.js';
import { healthCheck, findNodes, neighbors, pathTo } from './ontology.js';

const materialsOf = (graph, processId) =>
  neighbors(graph, processId)
    .filter((n) => n.outgoing && n.edge.rel === 'consumes')
    .map((n) => n.node.label);

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

const SKILLS = [
  {
    id: 'lookup',
    match: /^(where|what is|show|find|list)\b/i,
    run(ctx, q) {
      const words = q.replace(/[?.,]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
      const stop = new Set(['where', 'what', 'show', 'find', 'which', 'list', 'the', 'and', 'for', 'does', 'are', 'is']);
      const hits = new Map();
      for (const w of words) {
        if (stop.has(w.toLowerCase())) continue;
        for (const n of findNodes(ctx.graph, w)) hits.set(n.id, { node: n, score: (hits.get(n.id)?.score ?? 0) + 1 });
      }
      if (!hits.size) return null;
      const ranked = [...hits.values()].sort((a, b) => b.score - a.score).map((h) => h.node);
      const lines = ranked.slice(0, 6).map((n) => {
        const path = pathTo(ctx.graph, n.id).map((p) => p.label).join(' → ');
        const rel = neighbors(ctx.graph, n.id).slice(0, 4).map((x) => `${x.outgoing ? '' : '←'}${x.edge.rel} ${x.node.label}`).join('; ');
        return `• ${n.type} ${n.label}${path.includes('→') ? ` — ${path}` : ''}${rel ? ` (${rel})` : ''}`;
      });
      return { steps: [`Graph query → ${hits.size} matching node(s)`], text: lines.join('\n'), link: '#/ontology' };
    },
  },
  {
    id: 'root-cause',
    match: /(tab width|scrap|\bng\b|reject|cutter|tension|why.*fail|root.?cause|quality)/i,
    run(ctx) {
      const pooled = correlationFinder(ctx.batches, CUTTER_VARIABLES);
      const split = correlationFinder(ctx.batches, CUTTER_VARIABLES, { splitBy: 'material' });
      const found = explain(split);
      const ng = ctx.batches.filter((r) => r.ng).length;
      return {
        steps: [
          `Graph query → Electrode notching consumes ${materialsOf(ctx.graph, 'p-notch').join(' + ') || 'no registered materials'}`,
          `Correlation analysis (pooled, ${ctx.batches.length} batches) → strongest effect |d| = ${Math.abs(pooled[0].effect).toFixed(2)}, nothing conclusive`,
          'Correlation analysis split by material → effects appear',
        ],
        text: [
          `${ng} of ${ctx.batches.length} cutter batches were NG for tab width. Pooled, no variable explains it — the effect cancels out across materials.`,
          'Split by material, one setting explains both:',
          ...found.map((f) => `• ${f.text}`),
          'Proposed actions: set material-specific tension limits, track tension per material as a live SPC signal, and re-calibrate on every material change.',
        ].join('\n'),
        link: '#/correlation',
      };
    },
  },
  {
    id: 'friction',
    match: /(plunger|friction|seiz|die.?cast|dc-?02|shot|downtime|predict)/i,
    run(ctx) {
      const { alerts } = detectFrictionAlerts(ctx.shots.history);
      const scored = scoreAlerts(alerts, ctx.shots.downtime, ctx.shots.cycleSeconds);
      const hit = scored.filter((s) => s.predicted);
      const avg = hit.reduce((a, s) => a + s.leadHours, 0) / (hit.length || 1);
      const latest = ctx.shots.history[ctx.shots.history.length - 1];
      return {
        steps: [
          'Virtual sensor → plunger friction from equation of motion (m·a = Ph·Ah − Pm·Am − F)',
          `Anomaly detection → rolling 200-shot baseline, ${alerts.length} warning window(s)`,
          `Event join → ${ctx.shots.downtime.length} downtime events on Die-caster DC-02`,
        ],
        text: [
          `Die-caster DC-02: ${hit.length} of ${scored.length} seizure-related stops were preceded by a friction warning, with ${avg.toFixed(1)} h average lead time.`,
          ...scored.map((s) => `• ${s.id} (${s.code}, ${s.durationMin} min): ${s.predicted ? `warned ${s.leadHours.toFixed(1)} h ahead` : 'not predicted'}`),
          `Latest shot friction: ${Math.round(latest.friction)} N.`,
        ].join('\n'),
        link: '#/physics',
      };
    },
  },
  {
    id: 'wear',
    match: /(weld|tip|wear|power|maintenance)/i,
    run(ctx) {
      const cat = wearCheck(ctx.weld.series, 'cathode', { until: ctx.weld.swapAt });
      const an = wearCheck(ctx.weld.series, 'anode', { until: ctx.weld.swapAt });
      return {
        steps: ['Timeseries query → median welding power, Tab Welder W-03', 'Change detection → last 24 h vs baseline'],
        text: [
          `Cathode tip: median welding power ${pct(cat.change)} in the final 24 h before the scheduled swap; anode stayed flat (${pct(an.change)}).`,
          'Power rise is a second wear signal next to the cycle counter. Recommend swapping the tip when power crosses the wear threshold, even if the counter has not reached its swap point.',
        ].join('\n'),
        link: '#/correlation',
      };
    },
  },
  {
    id: 'health',
    match: /(health|orphan|ontology|duplicate|missing|check)/i,
    run(ctx) {
      const h = healthCheck(ctx.graph);
      return {
        steps: [`Ontology health check → ${h.counts.nodes} nodes, ${h.counts.edges} relationships`],
        text: [`Ontology health score ${h.score}/100.`, ...(h.issues.length ? h.issues.map((i) => `• ${i.text}`) : ['No issues found.'])].join('\n'),
        link: '#/ontology',
      };
    },
  },
];

export function ask(question, ctx) {
  const q = question.trim();
  if (!q) return null;
  for (const skill of SKILLS) {
    if (!skill.match.test(q)) continue;
    const out = skill.run(ctx, q);
    if (out) return { skill: skill.id, ...out };
  }
  return {
    skill: 'help',
    steps: [],
    text: [
      "I couldn't map that to a skill yet. Try:",
      '• Why are cutter batches failing on tab width?',
      '• Is the DC-02 plunger at risk of seizing?',
      '• Is the welder tip wearing?',
      '• Run an ontology health check',
      '• Where is Tab Welder W-03?',
    ].join('\n'),
  };
}

export const SUGGESTIONS = [
  'Why are cutter batches failing on tab width?',
  'Is the DC-02 plunger at risk of seizing?',
  'Is the welder tip wearing?',
  'Run an ontology health check',
  'Where is Tab Welder W-03?',
];
