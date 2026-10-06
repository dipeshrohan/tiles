import { ask, SUGGESTIONS } from '../lib/copilot.js';
import { esc } from '../lib/dom.js';

export default {
  id: 'chat',
  title: 'Copilot',
  icon: '✦',
  render(ctx) {
    const log = ctx.state.chat;
    const messages = log.length
      ? log
          .map((m) =>
            m.role === 'user'
              ? `<div class="msg user">${esc(m.text)}</div>`
              : `<div class="msg bot">${m.steps?.length ? `<div class="trace">${m.steps.map((s) => `<div>${esc(s)}</div>`).join('')}</div>` : ''}${esc(m.text)}${m.link ? `\n<a href="${esc(m.link)}">Open the evidence →</a>` : ''}</div>`,
          )
          .join('')
      : `<div class="empty"><h2 style="color:var(--ink)">Ask about your plant</h2><p style="margin-top:6px">The copilot picks a skill, runs it on the factory data and shows each step it took.</p></div>`;
    return `
      <div class="page-head">
        <div><div class="eyebrow">Copilot</div><h1>Talk to your data &amp; docs</h1></div>
        ${log.length ? '<button class="btn sm" data-clear>Clear conversation</button>' : ''}
      </div>
      <div class="chat">
        <div class="chat-log" id="chat-log">${messages}</div>
        <div>
          <div class="chips" style="margin:10px 0">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          <form class="composer" id="composer">
            <input type="text" name="q" placeholder="Ask why a line is scrapping, whether a machine is at risk, where a signal lives…" autocomplete="off" aria-label="Question" />
            <button class="btn primary" type="submit">Ask</button>
          </form>
        </div>
      </div>`;
  },
  bind(root, ctx) {
    const logEl = root.querySelector('#chat-log');
    logEl.scrollTop = logEl.scrollHeight;
    const send = (q) => {
      if (!q.trim()) return;
      const answer = ask(q, { graph: ctx.graph, batches: ctx.state.batches, weld: ctx.state.weld, shots: ctx.state.shots });
      ctx.update((s) => {
        s.chat.push({ role: 'user', text: q.trim() });
        s.chat.push({ role: 'bot', text: answer.text, steps: answer.steps, link: answer.link, skill: answer.skill });
      });
      document.querySelector('#composer input')?.focus();
    };
    root.querySelector('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      send(e.target.q.value);
    });
    root.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
    root.querySelector('[data-clear]')?.addEventListener('click', () => ctx.update((s) => (s.chat = [])));
  },
};
