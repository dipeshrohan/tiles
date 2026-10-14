import { test } from 'vitest';
import assert from 'node:assert/strict';
import { feedbackBody, feedbackListHtml, formHtml, MOODS, pageId, previewHtml } from '../js/lib/feedback.ts';
import { dataUrlBytes, stylesText } from '../js/lib/screenshot.ts';
import { takeSaved, SAVED_KEY } from '../js/lib/undo.ts';

test('what is sent: the page by its id, never its address; the words trimmed; a mood from the three', () => {
  assert.equal(pageId('warnings'), 'warnings');
  assert.equal(pageId('UX analytics'), 'ux-analytics');
  assert.equal(pageId('#/warnings?q=eng@example.com'), 'warnings-q-eng-example-com');
  assert.equal(pageId(''), 'unknown');
  const body = feedbackBody({
    mood: 'happy',
    text: '  Good tours  ',
    named: false,
    screenshot: null,
    page: 'help',
    version: '0.2.0',
    userAgent: 'x'.repeat(400),
  });
  assert.deepEqual(
    { ...body, browser: body.browser.length },
    {
      mood: 'happy',
      text: 'Good tours',
      page: 'help',
      version: '0.2.0',
      browser: 300,
      named: false,
      screenshot: null,
    },
  );
  assert.equal(feedbackBody({ ...body, mood: 'angry', userAgent: '' }).mood, 'neutral');
  assert.deepEqual(
    MOODS.map((m) => m.id),
    ['unhappy', 'neutral', 'happy'],
  );
});

test('the form says what goes with it, escapes what it shows, and offers a screenshot only where one can be made', () => {
  const html = formHtml({ page: 'Data <explorer>', version: '0.2.0', name: 'Ana <b>', canShoot: true });
  assert.match(html, /Include my name \(Ana &lt;b&gt;\)/);
  assert.match(html, /the page \(Data &lt;explorer&gt;\), version 0\.2\.0 and your browser/);
  assert.match(html, /data-feedback-shot/);
  assert.equal((html.match(/type="radio" name="mood"/g) ?? []).length, 3);
  assert.match(html, /<legend>How is Tiles working for you\?<\/legend>/);
  const local = formHtml({ page: 'Home', version: '0.2.0', name: 'Ana', canShoot: false });
  assert.doesNotMatch(local, /data-feedback-shot/);
  assert.match(local, /Screenshots can’t be made here/);
  assert.match(previewHtml('data:image/jpeg;base64,AA"'), /src="data:image\/jpeg;base64,AA&quot;"/);
});

test('admins read each with its mood, who (or Anonymous), page and words, escaped', () => {
  const row = {
    id: 7,
    created_at: '2026-10-14T09:00:00Z',
    mood: 'unhappy',
    text: '<script>x</script>',
    page: 'warnings',
    version: '0.2.0',
    browser: 'Firefox',
    user: null,
    screenshot: true,
  };
  const html = feedbackListHtml([row, { ...row, id: 8, user: 'Ana', screenshot: false }], () => 'today');
  assert.match(html, /Not well<\/strong><span class="small soft">Anonymous · warnings · today/);
  assert.match(html, /Ana · warnings/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.equal((html.match(/data-feedback-view=/g) ?? []).length, 1);
  assert.equal((html.match(/data-feedback-delete=/g) ?? []).length, 2);
  assert.match(html, /data-key="feedback-7"/);
});

test('the screenshot: the stylesheet with :root kept as heavy, none when a sheet is closed to the page; its size', () => {
  const sheet = (rules) => ({ cssRules: rules.map((cssText) => ({ cssText })) });
  assert.equal(
    stylesText([sheet([':root { --a: 1; }', ':root:not([data-theme="light"]) .x { color: red; }'])]),
    '[data-shot-root] { --a: 1; }\n[data-shot-root]:not([data-theme="light"]) .x { color: red; }\n',
  );
  const closed = {
    get cssRules() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(stylesText([sheet(['a {}']), closed]), null);
  assert.equal(dataUrlBytes(`data:image/png;base64,${btoa('abcd')}`), 4);
  assert.equal(dataUrlBytes(`data:image/png;base64,${btoa('abcde')}`), 5);
  assert.equal(dataUrlBytes(`data:image/png;base64,${btoa('abcdef')}`), 6);
});

test('a feedback deletion left waiting is sent by the next load', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  storage.setItem(SAVED_KEY, JSON.stringify([{ kind: 'feedback', api: 'http://api', site: 's', id: '7' }]));
  assert.deepEqual(takeSaved(storage, 'http://api'), [{ kind: 'feedback', api: 'http://api', site: 's', id: '7' }]);
});
