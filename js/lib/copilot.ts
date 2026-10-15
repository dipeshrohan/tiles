// Rule-based copilot: routes a question to the right skill, runs it over
// the factory data and answers with the steps it took, so every answer is
// traceable to a tool and its inputs. Runs fully offline.

import { correlationFinder, explain, wearCheck } from './analysis.ts';
import { CUTTER_VARIABLES } from './data.ts';
import { detectFrictionAlerts, scoreAlerts } from './physics.ts';
import { healthCheck, findNodes, neighbors, pathTo } from './ontology.ts';
import type { CutterBatch, Graph, OntologyNode, ShotHistory, WeldData } from './types.ts';
import { t, type MessageKey } from './i18n.ts';
import { percent } from './format.ts';

export interface CopilotContext {
  graph: Graph;
  batches: CutterBatch[];
  weld: WeldData;
  shots: ShotHistory;
}

export interface SkillResult {
  steps: string[];
  text: string;
  link?: string;
}

export interface Answer extends SkillResult {
  skill: string;
}

interface Skill {
  id: string;
  match: RegExp;
  run(ctx: CopilotContext, question: string): SkillResult | null;
}

const materialsOf = (graph: Graph, processId: string): string[] =>
  neighbors(graph, processId)
    .filter((n) => n.outgoing && n.edge.rel === 'consumes')
    .map((n) => n.node.label);

const pct = (x: number): string => `${x >= 0 ? '+' : '−'}${percent(Math.abs(x), 1)}`;

const SKILLS: Skill[] = [
  {
    id: 'lookup',
    match: /^(where|what is|show|find|list)\b/i,
    run(ctx, q) {
      const words = q
        .replace(/[?.,]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const stop = new Set([
        'where',
        'what',
        'show',
        'find',
        'which',
        'list',
        'the',
        'and',
        'for',
        'does',
        'are',
        'is',
      ]);
      const hits = new Map<string, { node: OntologyNode; score: number }>();
      for (const w of words) {
        if (stop.has(w.toLowerCase())) continue;
        for (const n of findNodes(ctx.graph, w)) hits.set(n.id, { node: n, score: (hits.get(n.id)?.score ?? 0) + 1 });
      }
      if (!hits.size) return null;
      const ranked = [...hits.values()].sort((a, b) => b.score - a.score).map((h) => h.node);
      const lines = ranked.slice(0, 6).map((n) => {
        const path = pathTo(ctx.graph, n.id)
          .map((p) => p.label)
          .join(' → ');
        const rel = neighbors(ctx.graph, n.id)
          .slice(0, 4)
          .map((x) => `${x.outgoing ? '' : '←'}${x.edge.rel} ${x.node.label}`)
          .join('; ');
        return `• ${n.type} ${n.label}${path.includes('→') ? ` — ${path}` : ''}${rel ? ` (${rel})` : ''}`;
      });
      return { steps: [t('copilot.lookup.step', { count: hits.size })], text: lines.join('\n'), link: '#/ontology' };
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
          t('copilot.rootCause.step.graph', {
            materials: materialsOf(ctx.graph, 'p-notch').join(' + ') || t('copilot.rootCause.noMaterials'),
          }),
          t('copilot.rootCause.step.pooled', {
            batches: ctx.batches.length,
            d: Math.abs(pooled[0]?.effect ?? 0).toFixed(2),
          }),
          t('copilot.rootCause.step.split'),
        ],
        text: [
          t('copilot.rootCause.summary', { ng, total: ctx.batches.length }),
          t('copilot.rootCause.split'),
          ...found.map((f) => `• ${f.text}`),
          t('copilot.rootCause.actions'),
        ].join('\n'),
        link: '#/quality',
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
      const latest = ctx.shots.history.at(-1);
      return {
        steps: [
          t('copilot.friction.step.sensor'),
          t('copilot.friction.step.detect', { count: alerts.length }),
          t('copilot.friction.step.events', { count: ctx.shots.downtime.length }),
        ],
        text: [
          t('copilot.friction.summary', { hit: hit.length, total: scored.length, lead: avg.toFixed(1) }),
          ...scored.map(
            (s) =>
              `• ${s.id} (${s.code}, ${s.durationMin} min): ${s.predicted ? t('copilot.friction.warned', { hours: s.leadHours.toFixed(1) }) : t('copilot.friction.notPredicted')}`,
          ),
          latest ? t('copilot.friction.latest', { n: Math.round(latest.friction) }) : t('copilot.friction.noShots'),
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
        steps: [t('copilot.wear.step.query'), t('copilot.wear.step.change')],
        text: [
          t('copilot.wear.summary', { cathode: pct(cat.change), anode: pct(an.change) }),
          t('copilot.wear.advice'),
        ].join('\n'),
        link: '#/quality',
      };
    },
  },
  {
    id: 'health',
    match: /(health|orphan|ontology|duplicate|missing|check)/i,
    run(ctx) {
      const h = healthCheck(ctx.graph);
      return {
        steps: [t('copilot.health.step', { nodes: h.counts.nodes, edges: h.counts.edges })],
        text: [
          t('copilot.health.score', { score: h.score }),
          ...(h.issues.length ? h.issues.map((i) => `• ${i.text}`) : [t('copilot.health.none')]),
        ].join('\n'),
        link: '#/ontology',
      };
    },
  },
];

export function ask(question: string, ctx: CopilotContext): Answer | null {
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
    text: [t('copilot.help.intro'), ...suggestions().map((s) => `• ${s}`)].join('\n'),
  };
}

// Questions to start from, in the reader's language (the skills still match English words).
const SUGGESTIONS: readonly MessageKey[] = [
  'copilot.suggestion.rootCause',
  'copilot.suggestion.friction',
  'copilot.suggestion.wear',
  'copilot.suggestion.health',
  'copilot.suggestion.lookup',
];
export const suggestions = (): string[] => SUGGESTIONS.map((key) => t(key));
