// Scores a usability study round (U1.01, U6.07; docs/ui/research/README.md) against the UI plan's
// measures: `npm run study -- <round folder> [--baseline <round folder>]` reads the round's
// tasks.csv and sus.csv and prints the measures as Markdown for the round's report.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The study's tasks, in the script's order. `timed` tasks have the plan's −30% time target; `limit`
// is a time target in seconds of its own (U4.06: a new user's first useful page in under 2 minutes).
export const TASKS = [
  { key: 'triage', name: 'Triage a warning', timed: true },
  { key: 'plot', name: 'Find a signal and plot it', timed: true },
  { key: 'commit', name: 'Commit an ontology change through review', timed: true },
  { key: 'correlate', name: 'Run a correlation on a batch table' },
  { key: 'copilot', name: 'Ask the copilot about a machine' },
  { key: 'site', name: 'Set up a new site' },
  { key: 'first-page', name: 'Reach a first useful page as a new user', limit: 120, extra: true },
  { key: 'home-now', name: 'Say from Home what needs you now', extra: true },
];

export const TARGETS = { sus: 75, susGain: 10, success: 0.9, timeCut: 0.3 };
const OUTCOMES = new Set(['success', 'assisted', 'fail']);

// A CSV file as objects keyed by its header: quoted fields may hold commas, quotes ("") and new lines.
export function readCsv(raw) {
  const text = raw.replace(/^\uFEFF/, ''); // a spreadsheet's byte-order mark
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      (row.push(cell), rows.push(row), (row = []), (cell = ''));
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// One person's System Usability Scale score (0–100) from their ten answers, each 1–5.
export function sus(answers) {
  if (answers.length !== 10 || answers.some((a) => !Number.isInteger(a) || a < 1 || a > 5))
    throw new Error(`SUS needs ten answers from 1 to 5, got ${answers.join(', ')}`);
  const sum = answers.reduce((s, a, i) => s + (i % 2 === 0 ? a - 1 : 5 - a), 0);
  return sum * 2.5;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A round's numbers: SUS per person and its mean, and per task the people who tried it, the share
// who succeeded without help and the median time of those successes.
export function score({ tasks, susRows }) {
  const known = new Map(TASKS.map((t) => [t.key, t]));
  for (const [i, r] of tasks.entries()) {
    if (!known.has(r.task)) throw new Error(`tasks.csv row ${i + 2}: unknown task "${r.task}"`);
    if (!OUTCOMES.has(r.outcome)) throw new Error(`tasks.csv row ${i + 2}: outcome must be success, assisted or fail`);
    if (r.outcome === 'success' && !(Number(r.seconds) > 0))
      throw new Error(`tasks.csv row ${i + 2}: a success needs its time in seconds`);
  }
  const people = susRows.map((r) => ({
    participant: r.participant,
    score: sus(Array.from({ length: 10 }, (_, i) => Number(r[`q${i + 1}`]))),
  }));
  const susMean = people.length ? people.reduce((s, p) => s + p.score, 0) / people.length : null;
  const perTask = TASKS.map((t) => {
    const rows = tasks.filter((r) => r.task === t.key);
    const wins = rows.filter((r) => r.outcome === 'success');
    return {
      ...t,
      tried: rows.length,
      success: rows.length ? wins.length / rows.length : null,
      seconds: median(wins.map((r) => Number(r.seconds))),
    };
  });
  const participants = new Set([...tasks.map((r) => r.participant), ...people.map((p) => p.participant)]);
  return { participants: participants.size, people, sus: susMean, tasks: perTask };
}

const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const secs = (v) => (v == null ? '–' : `${Math.round(v)} s`);
const met = (ok) => (ok == null ? 'not measured' : ok ? 'met' : 'not met');

// The measures as Markdown: SUS, success and time per task, each against its target (and the
// baseline round's numbers when given).
export function report(round, baseline = null) {
  const lines = [];
  const susTarget = baseline?.sus != null ? Math.max(TARGETS.sus, baseline.sus + TARGETS.susGain) : TARGETS.sus;
  lines.push(`Participants: ${round.participants}.`, '');
  lines.push('| Measure | Baseline | This round | Target | Result |', '| --- | --- | --- | --- | --- |');
  const susNow = round.sus == null ? '–' : round.sus.toFixed(1);
  const susThen = baseline?.sus == null ? '–' : baseline.sus.toFixed(1);
  const susTargetText = baseline?.sus != null ? `≥ ${susTarget.toFixed(1)}` : `≥ ${TARGETS.sus}`;
  lines.push(
    `| SUS (mean of ${round.people.length}) | ${susThen} | ${susNow} | ${susTargetText} | ${met(round.sus == null ? null : round.sus >= susTarget)} |`,
  );
  for (const t of round.tasks) {
    const before = baseline?.tasks.find((b) => b.key === t.key);
    if (!t.extra) {
      const ok = t.success == null ? null : t.success >= TARGETS.success;
      lines.push(
        `| ${t.name}: success without help (${t.tried}) | ${pct(before?.success)} | ${pct(t.success)} | ≥ ${pct(TARGETS.success)} | ${met(ok)} |`,
      );
    }
    if (t.timed) {
      const goal = before?.seconds == null ? null : before.seconds * (1 - TARGETS.timeCut);
      const ok = goal == null || t.seconds == null ? null : t.seconds <= goal;
      lines.push(
        `| ${t.name}: median time | ${secs(before?.seconds)} | ${secs(t.seconds)} | ${goal == null ? '−30% on the baseline' : `≤ ${secs(goal)}`} | ${met(ok)} |`,
      );
    }
    if (t.limit) {
      const ok = t.seconds == null ? null : t.seconds <= t.limit;
      lines.push(
        `| ${t.name}: median time (${t.tried}) | ${secs(before?.seconds)} | ${secs(t.seconds)} | ≤ ${secs(t.limit)} | ${met(ok)} |`,
      );
    }
    if (t.extra && !t.limit) {
      const ok = t.success == null ? null : t.success >= TARGETS.success;
      lines.push(
        `| ${t.name} (${t.tried}) | ${pct(before?.success)} | ${pct(t.success)} | ≥ ${pct(TARGETS.success)} | ${met(ok)} |`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

export function readRound(dir) {
  return score({
    tasks: readCsv(readFileSync(join(dir, 'tasks.csv'), 'utf8')),
    susRows: readCsv(readFileSync(join(dir, 'sus.csv'), 'utf8')),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--baseline');
  const base = at >= 0 ? args.splice(at, 2)[1] : null;
  if (!args[0]) {
    console.error('Usage: npm run study -- <round folder> [--baseline <round folder>]');
    process.exit(2);
  }
  process.stdout.write(report(readRound(args[0]), base ? readRound(base) : null));
}
