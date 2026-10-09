// The copilot page's logic (T4.04), apart from the page: a conversation's stored messages as
// questions and answers with the tools behind each, an answer as it streams in, its text with
// citations linked to the tool results, and where each tool's evidence lives in Tiles.

import type { CopilotGrounding, CopilotMessage } from './api.ts';
import { esc } from './dom.ts';

export interface ToolTrace {
  n: number | null; // the number the answer cites it by
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean | null; // null while it runs
  preview: string; // the start of what it gave
}

export interface Answer {
  seq: number | null; // stored as this message; null while streaming
  text: string;
  tools: ToolTrace[];
  retracted: { text: string; reason: string }[]; // drafts withdrawn for stating what no tool returned
  grounding: CopilotGrounding | null;
  error: string | null;
  done: boolean;
  feedback: { rating: 'up' | 'down'; comment: string } | null;
}

export interface Exchange {
  question: string;
  answer: Answer | null;
}

export const emptyAnswer = (): Answer => ({
  seq: null,
  text: '',
  tools: [],
  retracted: [],
  grounding: null,
  error: null,
  done: false,
  feedback: null,
});

type Block = Record<string, unknown>;
const blocks = (m: CopilotMessage): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : []);
const textOf = (m: CopilotMessage): string =>
  blocks(m)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n');

// A labelled tool result: "[3] name {input}\n<what it gave>".
function parseResult(content: unknown): { n: number | null; body: string } {
  const text = typeof content === 'string' ? content : '';
  const m = text.match(/^\[(\d+)\] [^\n]*\n?([\s\S]*)$/);
  return m ? { n: Number(m[1]), body: m[2] ?? '' } : { n: null, body: text };
}

const preview = (body: string): string => (body.length > 300 ? `${body.slice(0, 300)}…` : body);

// A conversation's stored messages as its questions and their final answers, each answer with the
// tools that ran for it. Text the model wrote before calling tools ("Let me look.") isn't the answer.
export function exchanges(history: CopilotMessage[]): Exchange[] {
  const out: Exchange[] = [];
  let current: Exchange | null = null;
  const traces = new Map<string, ToolTrace>();
  for (const m of history) {
    const content = blocks(m);
    if (m.role === 'user' && content.some((b) => b.type === 'text')) {
      current = { question: textOf(m), answer: null };
      out.push(current);
      continue;
    }
    if (!current) continue;
    current.answer ??= emptyAnswer();
    const answer = current.answer;
    if (m.role === 'user') {
      for (const b of content.filter((x) => x.type === 'tool_result')) {
        const t = traces.get(String(b.tool_use_id));
        const { n, body } = parseResult(b.content);
        if (t) Object.assign(t, { n, isError: Boolean(b.is_error), preview: preview(body) });
      }
      continue;
    }
    const calls = content.filter((b) => b.type === 'tool_use');
    for (const c of calls) {
      const t: ToolTrace = {
        n: null,
        id: String(c.id),
        name: String(c.name),
        input: (c.input as Record<string, unknown>) ?? {},
        isError: null,
        preview: '',
      };
      traces.set(t.id, t);
      answer.tools.push(t);
    }
    if (!calls.length) {
      Object.assign(answer, {
        seq: m.seq,
        text: textOf(m),
        grounding: (m.meta?.grounding as CopilotGrounding | undefined) ?? null,
        retracted: (m.meta?.withdrawn ?? []).map((reason) => ({ text: '', reason })),
        feedback: m.feedback ?? null,
        done: true,
      });
    }
  }
  for (const e of out) if (e.answer && !e.answer.done) e.answer.done = true; // broke off: nothing more comes
  return out;
}

// An answer as its events stream in (api_copilot's server-sent events).
export function applyEvent(a: Answer, event: string, data: Record<string, unknown>): Answer {
  switch (event) {
    case 'text':
      return { ...a, text: a.text + String(data.text ?? '') };
    case 'tool_use':
      // What the model wrote before calling tools was a note to itself, not the answer.
      return {
        ...a,
        text: '',
        tools: [
          ...a.tools,
          {
            n: typeof data.n === 'number' ? data.n : null,
            id: String(data.id),
            name: String(data.name),
            input: (data.input as Record<string, unknown>) ?? {},
            isError: null,
            preview: '',
          },
        ],
      };
    case 'tool_result':
      return {
        ...a,
        tools: a.tools.map((t) => (t.id === data.id ? { ...t, isError: Boolean(data.is_error) } : t)),
      };
    case 'retract':
      return { ...a, text: '', retracted: [...a.retracted, { text: a.text, reason: String(data.reason ?? '') }] };
    case 'grounding':
      return { ...a, grounding: data as unknown as CopilotGrounding };
    case 'error':
      return { ...a, error: String(data.detail ?? 'The copilot could not answer'), done: true };
    case 'done':
      return { ...a, done: true };
    default:
      return a;
  }
}

// An answer's text as HTML: escaped; `code`, **bold** and line breaks; [n] linked to its tool.
export function answerHtml(text: string, tools: ToolTrace[], key: string): string {
  const known = new Set(tools.map((t) => t.n).filter((n) => n !== null));
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[(\d+)\]/g, (whole, n: string) =>
      known.has(Number(n))
        ? `<a class="cite" href="#" data-cite="${esc(key)}-${n}" title="The tool result this rests on">[${n}]</a>`
        : whole,
    )
    .replace(/\n/g, '<br>');
}

// Where a tool's evidence can be seen in Tiles, from what it was asked.
export function evidenceLink(t: Pick<ToolTrace, 'name' | 'input'>): { href: string; text: string } | null {
  const tag = typeof t.input.tag === 'string' ? t.input.tag : '';
  switch (t.name) {
    case 'time_series':
    case 'wear_check':
      return tag ? { href: `#/explorer?tag=${encodeURIComponent(tag)}`, text: `Plot ${tag}` } : null;
    case 'find_signals':
      return { href: '#/signals', text: 'Open the signals' };
    case 'graph_query':
    case 'ontology_health':
      return { href: '#/ontology', text: 'Open the ontology' };
    case 'events':
      return t.input.kind === 'events'
        ? { href: '#/performance', text: 'Open warning performance' }
        : { href: '#/warnings', text: 'Open the warnings' };
    case 'correlate':
      return { href: '#/correlate', text: 'Open the correlation finder' };
    case 'virtual_sensors':
      return { href: '#/physics', text: 'Open factory physics' };
    default:
      return null;
  }
}

// What a grounding report means for the reader, if anything is wrong.
export function groundingWarning(g: CopilotGrounding | null): string | null {
  if (!g || g.grounded) return null;
  const parts: string[] = [];
  if (g.uncited) parts.push('it cites no tool result');
  if (g.unsupported_numbers.length) parts.push(`no tool returned ${g.unsupported_numbers.join(', ')}`);
  if (g.unsupported_names.length) parts.push(`no tool named ${g.unsupported_names.join(', ')}`);
  if (g.unknown_citations.length) parts.push(`it cites results that don't exist`);
  return `Check this answer: ${parts.join('; ')}.`;
}

export const toolLabel = (t: Pick<ToolTrace, 'name' | 'input'>): string => {
  const args = Object.entries(t.input)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return `${t.name}(${args})`;
};
