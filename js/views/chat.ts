import { ask, SUGGESTIONS } from '../lib/copilot.ts';
import {
  answerHtml,
  applyEvent,
  emptyAnswer,
  evidenceLink,
  exchanges,
  groundingWarning,
  toolLabel,
  type Answer,
  type Exchange,
} from '../lib/copilot-chat.ts';
import type { CopilotConversation } from '../lib/api.ts';
import { esc, need, onAll, onSubmit, field, onNavigate, routeOf } from '../lib/dom.ts';
import type { Context, View } from './types.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { emptyState, loadingState, button, pageHead, skeleton } from '../lib/ui.ts';

// The copilot page. With the Tiles API and its copilot on (T4.01–T4.04): your conversations, each
// answer streamed in with the tools it used (expandable, each citation linked to its result and
// to where the evidence lives), a warning when an answer states what no tool returned, and a
// thumbs up or down with a comment. Otherwise the built-in skills answer on the demo data.

interface Ui {
  conversation: string | null;
}
const uiState = (ctx: Context) => ctx.ui<Ui>('chat', { conversation: null });

const API_SUGGESTIONS = [
  'Which warnings are open?',
  'How healthy is the ontology?',
  'What do the virtual sensors show?',
  'Is anything wearing on the welders?',
];

let remote: {
  site: string;
  configured: boolean | null;
  enabled: boolean;
  conversations: CopilotConversation[] | null;
} | null = null;
let thread: { key: string; exchanges: Exchange[] } | null = null;
let live: { key: string; question: string; answer: Answer } | null = null;
let busy = false;
let draft = ''; // the question being typed, kept across re-renders
let rating: { key: string; comment: string } | null = null; // a thumbs-down comment being written
// An answer that failed (the error isn't stored), shown after the conversation reloads.
let failure: { key: string; question: string; error: string } | null = null;

const siteId = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const threadKey = (ctx: Context): string => `${siteId(ctx)}|${uiState(ctx).conversation}`;

onNavigate((hash) => {
  if (routeOf(hash) !== 'chat') {
    remote = null;
    thread = null;
  }
});

async function loadRemote(ctx: Context): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  // Checking again on the same site keeps what is shown meanwhile: a re-render (a click) must not
  // drop the page to the built-in skills until the answer comes.
  if (remote?.site !== site) remote = { site, configured: null, enabled: false, conversations: null };
  try {
    const { configured, enabled } = await ctx.api.copilot.status(site);
    const conversations = configured && enabled ? await ctx.api.copilot.conversations(site) : [];
    if (remote?.site === site) remote = { site, configured, enabled, conversations };
  } catch {
    if (remote?.site === site) remote = { site, configured: false, enabled: false, conversations: [] };
  }
  ctx.rerender();
}

async function loadThread(ctx: Context, id: string): Promise<void> {
  const site = siteId(ctx);
  if (!ctx.api || !site) return;
  const key = `${site}|${id}`;
  try {
    const got = await ctx.api.copilot.get(site, id);
    if (threadKey(ctx) === key) thread = { key, exchanges: exchanges(got.history) };
  } catch {
    if (threadKey(ctx) === key) {
      uiState(ctx).conversation = null;
      thread = null;
    }
  }
  ctx.rerender();
}

// `cited`: every tool result of the conversation so far, which an answer may cite.
function answerBody(a: Answer, cited: Answer['tools'], conversation: string | null): string {
  const tools = a.tools.length
    ? `<details class="trace" data-trace><summary>Used ${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}</summary><ol class="stack gap-1_5 mt-1_5 m-0 pl-5">${a.tools
        .map((t) => {
          const link = evidenceLink(t);
          const state = t.isError === null ? '…' : t.isError ? '✗' : '✓';
          return `<li ${t.n !== null ? `id="cite-${t.n}"` : ''} data-tool="${esc(t.name)}"><b>${t.n !== null ? `[${t.n}]` : ''}</b> <code>${esc(toolLabel(t))}</code> <span class="${t.isError ? 'bad' : 'soft'}">${state}</span>${
            t.preview ? `<pre class="small soft pre-wrap mt-1 m-0">${esc(t.preview)}</pre>` : ''
          }${link ? ` <a href="${esc(link.href)}">${esc(link.text)} →</a>` : ''}</li>`;
        })
        .join('')}</ol></details>`
    : '';
  const withdrawn = a.retracted
    .map((r) => `<p class="small soft" data-retracted>A first draft was withdrawn: ${esc(r.reason)}.</p>`)
    .join('');
  const warning = groundingWarning(a.grounding);
  const vote = (r: 'up' | 'down', label: string) =>
    `<button class="btn sm ${a.feedback?.rating === r ? 'primary' : ''}" type="button" data-rate="${r}" data-seq="${a.seq}" aria-pressed="${a.feedback?.rating === r}" title="${r === 'up' ? 'Helpful' : 'Not helpful'}">${label}</button>`;
  const rateKey = `${conversation}|${a.seq}`;
  const feedback =
    a.done && a.seq !== null && conversation
      ? `<div class="row gap-1_5 mt-2 items-center" data-feedback>${vote('up', '👍')}${vote('down', '👎')}${
          a.feedback?.comment ? `<span class="small soft">“${esc(a.feedback.comment)}”</span>` : ''
        }</div>${
          rating?.key === rateKey
            ? `<form class="row gap-1_5 mt-1_5" data-rate-form="${a.seq}"><input type="text" name="comment" maxlength="2000" placeholder="What was wrong? (goes to your site's admins with this answer)" value="${esc(rating.comment)}" class="grow"><button class="btn sm" type="submit">Send</button></form>`
            : ''
        }`
      : '';
  return `${withdrawn}${tools}<div data-answer-text>${answerHtml(a.text, cited)}${a.done ? '' : '<span class="soft"> …</span>'}</div>${
    warning ? `<p class="small text-warn" role="note" data-grounding-warning>⚠ ${esc(warning)}</p>` : ''
  }${a.error ? `<p class="small text-bad" role="alert">${esc(a.error)}</p>` : ''}${feedback}`;
}

function remoteRender(ctx: Context): string {
  const ui = uiState(ctx);
  const list = remote?.conversations;
  const items =
    list === null || list === undefined
      ? skeleton.list()
      : list
          .map(
            (c) =>
              `<button class="review-row ${ui.conversation === c.id ? 'sel' : ''}" data-conversation="${esc(c.id)}"><b>${esc(c.title || 'New conversation')}</b><span class="small muted">${new Date(c.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span></button>`,
          )
          .join('') ||
        emptyState({ compact: true, title: 'No conversations yet', body: 'Ask a question to start one.' });
  const key = threadKey(ctx);
  const shown = ui.conversation && thread?.key === key ? thread.exchanges : [];
  const last = shown.at(-1);
  if (failure?.key === key && last && last.question === failure.question && !last.answer?.text) {
    last.answer = { ...(last.answer ?? emptyAnswer()), error: failure.error, done: true };
  }
  const cited: Answer['tools'] = [];
  const log = [
    ...shown.map((e) => {
      cited.push(...(e.answer?.tools ?? []));
      const body = e.answer
        ? answerBody(e.answer, [...cited], ui.conversation)
        : '<p class="small soft">No answer was kept for this question.</p>';
      return `<div class="msg user">${esc(e.question)}</div><div class="msg bot copilot-answer">${body}</div>`;
    }),
    ...(live && live.key === key
      ? [
          `<div class="msg user">${esc(live.question)}</div><div class="msg bot copilot-answer" data-live>${answerBody(live.answer, [...cited, ...live.answer.tools], null)}</div>`,
        ]
      : []),
  ].join('');
  const loading = ui.conversation && thread?.key !== key && !live;
  return `<div class="copilot">
      <div class="card stack gap-2">
        <button class="btn primary" type="button" data-new-conversation>New conversation</button>
        <div class="review-list" data-conversations>${items}</div>
      </div>
      <div class="chat">
        <div class="chat-log" id="chat-log">${
          loading
            ? loadingState()
            : log ||
              emptyState({
                illustration: 'chat',
                title: 'Ask about your plant',
                body: "The copilot answers from your site's own data, cites the tool result behind each fact, and says when the data doesn't answer.",
              })
        }</div>
        <div>
          <div class="chips mt-2_5 mb-2_5 m-0">${API_SUGGESTIONS.map((s) => `<button class="chip" type="button" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          <form class="composer" id="composer">
            <input type="text" name="q" value="${esc(draft)}" placeholder="Ask about signals, warnings, wear, the ontology…" autocomplete="off" aria-label="Question" ${busy ? 'disabled' : ''} />
            <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Ask</button>
            ${ui.conversation ? `<button class="btn" type="button" data-delete-conversation ${busy ? 'disabled' : ''}>Delete</button>` : ''}
          </form>
          <p class="small soft mt-1_5">Your conversations are yours. Rating an answer shares it, with its question, with your site's admins, to improve the copilot.</p>
        </div>
      </div>
    </div>`;
}

function drawLive(): void {
  const el = document.querySelector<HTMLElement>('[data-live]');
  if (!el || !live) return;
  const before = thread?.key === live.key ? thread.exchanges.flatMap((e) => e.answer?.tools ?? []) : [];
  el.innerHTML = answerBody(live.answer, [...before, ...live.answer.tools], null);
  const log = document.querySelector<HTMLElement>('#chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

async function send(ctx: Context, question: string): Promise<void> {
  const site = siteId(ctx);
  const api = ctx.api;
  const text = question.trim();
  if (!api || !site || !text || busy) return;
  busy = true;
  draft = '';
  failure = null;
  const ui = uiState(ctx);
  let sent = false; // the question reached the API (it is stored, so it isn't asked again)
  try {
    if (!ui.conversation) {
      const created = await api.copilot.create(site);
      ui.conversation = created.id;
      thread = { key: threadKey(ctx), exchanges: [] };
    }
    const id = ui.conversation;
    live = { key: threadKey(ctx), question: text, answer: emptyAnswer() };
    ctx.rerender();
    await api.copilot.ask(site, id, text, (e) => {
      sent = true;
      if (!live) return;
      live.answer = applyEvent(live.answer, e.event, (e.data ?? {}) as Record<string, unknown>);
      drawLive();
    });
  } catch (e) {
    // The client showed why. Not sent: the question can be asked again; cut off: say so.
    if (!sent) draft = text;
    else if (live) live.answer = { ...live.answer, error: e instanceof Error ? e.message : 'The answer was cut off' };
  } finally {
    busy = false;
    if (live?.answer.error) failure = { key: live.key, question: text, error: live.answer.error };
    live = null;
    if (ui.conversation) await loadThread(ctx, ui.conversation);
    void loadRemote(ctx);
  }
}

async function rate(ctx: Context, seq: number, value: 'up' | 'down', comment: string): Promise<void> {
  const site = siteId(ctx);
  const id = uiState(ctx).conversation;
  if (!ctx.api || !site || !id) return;
  const answer = thread?.exchanges.find((e) => e.answer?.seq === seq)?.answer;
  try {
    const current = answer?.feedback;
    let saved: Answer['feedback'] = null;
    if (current?.rating === value && !comment) await ctx.api.copilot.unrate(site, id, seq);
    else saved = await ctx.api.copilot.rate(site, id, seq, value, comment);
    if (answer) answer.feedback = saved; // as stored; no need to fetch the conversation again
    rating = value === 'down' && !comment && current?.rating !== 'down' ? { key: `${id}|${seq}`, comment: '' } : null;
    if (comment) ctx.toast('Thanks: your site’s admins will see it');
  } catch {
    // the client showed why
  }
  ctx.rerender();
}

function remoteBind(root: HTMLElement, ctx: Context): void {
  const ui = uiState(ctx);
  const site = siteId(ctx);
  if (ui.conversation && thread?.key !== threadKey(ctx) && !live) void loadThread(ctx, ui.conversation);
  const logEl = root.querySelector<HTMLElement>('#chat-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
  root.querySelector<HTMLInputElement>('#composer [name=q]')?.addEventListener('input', (e) => {
    draft = (e.target as HTMLInputElement).value;
  });
  onSubmit(root, '#composer', (form) => void send(ctx, field(form, 'q')));
  onAll(root, '[data-q]', 'click', (b) => void send(ctx, b.dataset.q ?? ''));
  onAll(root, '[data-new-conversation]', 'click', () => {
    ui.conversation = null;
    thread = null;
    ctx.rerender();
    root.querySelector<HTMLInputElement>('#composer [name=q]')?.focus();
  });
  onAll(root, '[data-conversation]', 'click', (el) => {
    ui.conversation = el.dataset.conversation ?? null;
    rating = null;
    ctx.rerender();
  });
  onAll(root, '[data-delete-conversation]', 'click', async () => {
    const id = ui.conversation;
    if (!ctx.api || !site || !id) return;
    const yes = await confirmDialog({
      title: 'Delete this conversation?',
      body: 'Its questions and answers are deleted for good.',
      confirm: 'Delete',
      tone: 'danger',
    });
    if (!yes) return;
    ctx.api.copilot.remove(site, id).then(
      () => {
        ui.conversation = null;
        thread = null;
        void loadRemote(ctx);
      },
      () => undefined, // the client showed why
    );
  });
  onAll(root, '[data-cite]', 'click', (el, e) => {
    e.preventDefault();
    const target = [...document.querySelectorAll<HTMLElement>(`[id="cite-${el.dataset.cite ?? ''}"]`)].at(-1);
    const details = target?.closest('details');
    if (details) details.open = true;
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    target?.classList.add('flash');
    setTimeout(() => target?.classList.remove('flash'), 1200);
  });
  onAll(root, '[data-rate]', 'click', (el) => {
    const seq = Number(el.dataset.seq);
    void rate(ctx, seq, el.dataset.rate === 'up' ? 'up' : 'down', '');
  });
  root.querySelectorAll<HTMLFormElement>('[data-rate-form]').forEach((form) => {
    form.querySelector<HTMLInputElement>('[name=comment]')?.addEventListener('input', (e) => {
      if (rating) rating.comment = (e.target as HTMLInputElement).value;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const comment = field(form, 'comment').trim();
      if (!comment) return void ctx.toast('Say what was wrong, or leave the thumbs down as it is');
      void rate(ctx, Number(form.dataset.rateForm), 'down', comment);
    });
  });
}

// ---- the built-in skills on the demo data (no API, or its copilot is off) ----------------

function localRender(ctx: Context, note = ''): string {
  const log = ctx.state.chat;
  const messages = log.length
    ? log
        .map((m) =>
          m.role === 'user'
            ? `<div class="msg user">${esc(m.text)}</div>`
            : `<div class="msg bot">${m.steps?.length ? `<div class="trace">${m.steps.map((s) => `<div>${esc(s)}</div>`).join('')}</div>` : ''}${esc(m.text)}${m.link ? `\n<a href="${esc(m.link)}">Open the evidence →</a>` : ''}</div>`,
        )
        .join('')
    : emptyState({
        illustration: 'chat',
        title: 'Ask about your plant',
        body: 'The copilot picks a skill, runs it on the factory data and shows each step it took.',
      });
  return `${note}
      <div class="chat">
        <div class="chat-log" id="chat-log">${messages}</div>
        <div>
          <div class="chips mt-2_5 mb-2_5 m-0">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          <form class="composer" id="composer">
            <input type="text" name="q" placeholder="Ask why a line is scrapping, whether a machine is at risk, where a signal lives…" autocomplete="off" aria-label="Question" />
            <button class="btn primary" type="submit">Ask</button>
          </form>
        </div>
      </div>`;
}

function localBind(root: HTMLElement, ctx: Context): void {
  const logEl = need(root, '#chat-log');
  logEl.scrollTop = logEl.scrollHeight;
  const sendLocal = (q: string) => {
    if (!q.trim()) return;
    const answer = ask(q, {
      graph: ctx.graph,
      batches: ctx.state.batches,
      weld: ctx.state.weld,
      shots: ctx.state.shots,
    });
    if (!answer) return;
    ctx.update((s) => {
      s.chat.push({ role: 'user', text: q.trim() });
      s.chat.push({ role: 'bot', text: answer.text, steps: answer.steps, link: answer.link, skill: answer.skill });
    });
    document.querySelector<HTMLInputElement>('#composer input')?.focus();
  };
  onSubmit(root, '#composer', (form) => sendLocal(field(form, 'q')));
  onAll(root, '[data-q]', 'click', (b) => sendLocal(b.dataset.q ?? ''));
  onAll(root, '[data-clear]', 'click', () => ctx.update((s) => (s.chat = [])));
}

const remoteOn = (ctx: Context): boolean =>
  Boolean(
    ctx.api && ctx.ontology.status === 'ready' && remote?.site === siteId(ctx) && remote?.configured && remote.enabled,
  );

const view: View = {
  id: 'chat',
  title: 'Copilot',
  icon: 'sparkles',
  render(ctx) {
    const on = remoteOn(ctx);
    const head = `
      ${pageHead({
        eyebrow: 'Copilot',
        title: 'Talk to your data & docs',
        actionsHtml:
          !on && ctx.state.chat.length
            ? button('Clear conversation', { size: 'sm', attrs: { 'data-clear': true } })
            : '',
      })}`;
    if (on) return head + remoteRender(ctx);
    const checking = ctx.api && remote?.configured === null;
    const note =
      ctx.api && remote?.configured === false
        ? `<p class="small soft mb-2" data-copilot-off>The copilot service is off on this Tiles API (it needs TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL): the built-in skills answer on the demo data.</p>`
        : ctx.api && remote?.configured && !remote.enabled
          ? `<p class="small soft mb-2" data-copilot-site-off>The copilot is off on this site: an admin turns it on in <a href="#/settings">Settings</a>. Until then the built-in skills answer on the demo data.</p>`
          : checking
            ? '<p class="small soft">Checking the copilot service…</p>'
            : '';
    return head + localRender(ctx, note);
  },
  bind(root, ctx) {
    const site = siteId(ctx);
    if (ctx.api && ctx.ontology.status === 'ready' && site && remote?.site !== site) void loadRemote(ctx);
    if (remoteOn(ctx)) remoteBind(root, ctx);
    else localBind(root, ctx);
  },
};

export default view;
