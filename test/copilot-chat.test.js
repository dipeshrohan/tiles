// The copilot page's logic (T4.04): server-sent events, stored messages as exchanges, a streaming
// answer, citations, evidence links and grounding warnings.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sseParser } from '../js/lib/sse.ts';
import {
  answerHtml,
  applyEvent,
  emptyAnswer,
  evidenceLink,
  exchanges,
  groundingWarning,
  toolLabel,
} from '../js/lib/copilot-chat.ts';

test('events are read in whatever pieces they arrive', () => {
  const got = [];
  const p = sseParser((e) => got.push(e));
  p.feed('event: text\r\nda');
  p.feed('ta: {"text":"a"}\r\n\r\n: a comment\n\nevent: done\ndata: {"x":');
  assert.equal(got.length, 1);
  p.feed('1}\n\ndata: plain\ndata: two\n\n');
  p.feed('event: crlf\r');
  p.feed('\ndata: {"split":true}\r\n\r');
  p.feed('\nevent: last\ndata: {}');
  p.end();
  assert.deepEqual(got, [
    { event: 'text', data: { text: 'a' } },
    { event: 'done', data: { x: 1 } },
    { event: 'message', data: 'plain\ntwo' },
    { event: 'crlf', data: { split: true } }, // "\r" and "\n" in two pieces are one line end
    { event: 'last', data: {} },
  ]);
});

const grounding = {
  grounded: true,
  declined: false,
  cited: [1],
  unknown_citations: [],
  unsupported_numbers: [],
  unsupported_names: [],
  uncited: false,
};

test('stored messages become questions and answers with the tools behind them', () => {
  const history = [
    { seq: 0, role: 'user', content: [{ type: 'text', text: 'How hot?' }], meta: {} },
    {
      seq: 1,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 't1', name: 'time_series', input: { tag: 'p9.oil' } },
      ],
      meta: {},
    },
    {
      seq: 2,
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: '[1] time_series {"tag":"p9.oil"}\n{"last":42}',
          is_error: false,
        },
      ],
      meta: {},
    },
    {
      seq: 3,
      role: 'assistant',
      content: [{ type: 'text', text: '42 °C [1].' }],
      meta: { grounding, withdrawn: ['it cites no tool result'] },
      feedback: { rating: 'up', comment: '' },
    },
    { seq: 4, role: 'user', content: [{ type: 'text', text: 'And now?' }], meta: {} }, // broke off
  ];
  const [first, second] = exchanges(history);
  assert.equal(first.question, 'How hot?');
  assert.equal(first.answer.text, '42 °C [1].'); // not "Let me look."
  assert.equal(first.answer.seq, 3);
  assert.deepEqual(first.answer.tools, [
    { n: 1, id: 't1', name: 'time_series', input: { tag: 'p9.oil' }, isError: false, preview: '{"last":42}' },
  ]);
  assert.deepEqual(first.answer.retracted, [{ text: '', reason: 'it cites no tool result' }]);
  assert.deepEqual(first.answer.feedback, { rating: 'up', comment: '' });
  assert.deepEqual(second, { question: 'And now?', answer: null });
});

test('an answer builds up from its events', () => {
  let a = emptyAnswer();
  for (const [event, data] of [
    ['text', { text: 'Looking.' }],
    ['tool_use', { id: 't1', name: 'events', input: { kind: 'warnings' }, n: 4 }],
    ['tool_result', { id: 't1', is_error: false }],
    ['text', { text: 'It is 99.' }],
    ['retract', { reason: 'no cited result holds 99' }],
    ['text', { text: 'Two are open [4].' }],
    ['grounding', grounding],
    ['done', {}],
  ])
    a = applyEvent(a, event, data);
  assert.equal(a.text, 'Two are open [4].');
  assert.deepEqual(a.retracted, [{ text: 'It is 99.', reason: 'no cited result holds 99' }]);
  assert.deepEqual(
    a.tools.map((t) => [t.n, t.name, t.isError]),
    [[4, 'events', false]],
  );
  assert.equal(a.done, true);
  const failed = applyEvent(emptyAnswer(), 'error', { detail: 'The copilot could not answer' });
  assert.deepEqual([failed.error, failed.done], ['The copilot could not answer', true]);
});

test('an answer is shown escaped, with its names, emphasis and citations linked to known tools', () => {
  const tools = [{ n: 1, name: 'x', input: {}, id: 't', isError: false, preview: '' }];
  assert.equal(
    answerHtml('`p<9>` is **hot** [1], see [2].\nok', tools),
    '<code>p&lt;9&gt;</code> is <b>hot</b> <a class="cite" href="#" data-cite="1" title="The tool result this rests on">[1]</a>, see [2].<br>ok',
  );
});

test('each tool links to where its evidence is, and its call reads plainly', () => {
  assert.deepEqual(evidenceLink({ name: 'wear_check', input: { tag: 'w03.power' } }), {
    href: '#/explorer?tag=w03.power',
    text: 'Plot w03.power',
  });
  assert.equal(evidenceLink({ name: 'events', input: { kind: 'events' } }).href, '#/performance');
  assert.equal(evidenceLink({ name: 'events', input: {} }).href, '#/warnings');
  assert.equal(evidenceLink({ name: 'site_overview', input: {} }), null);
  // A proposal links to the change request it opened, once its result is stored (T4.09).
  const proposal = { name: 'propose_ontology_change', input: { message: 'm', ops: [] } };
  assert.deepEqual(evidenceLink({ ...proposal, preview: '{"change_request": 12, "status": "open"}' }), {
    href: '#/reviews/12',
    text: 'Review change request #12',
  });
  assert.equal(evidenceLink({ ...proposal, preview: 'Relationship e1 points at a missing node' }), null);
  assert.equal(evidenceLink(proposal), null); // still running
  assert.equal(
    toolLabel({ name: 'events', input: { kind: 'warnings', tag: '', limit: 5 } }),
    'events(kind=warnings, limit=5)',
  );
});

test('an answer the tools do not back is flagged with what is missing', () => {
  assert.equal(groundingWarning(grounding), null);
  assert.equal(groundingWarning(null), null);
  assert.equal(
    groundingWarning({
      ...grounding,
      grounded: false,
      uncited: true,
      unsupported_numbers: ['1,900'],
      unsupported_names: ['x.y'],
    }),
    'Check this answer: it cites no tool result; no tool returned 1,900; no tool named x.y.',
  );
});
