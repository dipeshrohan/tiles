// What a failed request means to the person who made it (U2.06): what happened, why, what to do.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { describeApiError, errorDetails } from '../js/lib/errors.ts';
import { STREAM_CUT } from '../js/lib/api.ts';

test('each kind of failure says what happened, why and the way out', () => {
  const offline = describeApiError({ status: 0, message: "You're offline: nothing was changed. Try again later" });
  assert.equal(offline.message, "You're offline: nothing was changed. Try again later");
  const down = describeApiError({ status: 0, message: "Can't reach the Tiles API at http://h:8000" });
  assert.equal(down.message, "Can't reach the Tiles API");
  assert.match(down.description, /at http:\/\/h:8000\. Check your connection/);
  // A stream cut off mid-answer: the API was reached, so not "can't reach".
  const cut = describeApiError({ status: 0, message: STREAM_CUT });
  assert.deepEqual(cut, { message: STREAM_CUT, action: null });
  assert.deepEqual(describeApiError({ status: 401, message: 'Token expired' }), {
    message: 'Your session has ended',
    description: 'Token expired. Sign in again to carry on.',
    action: 'sign-in',
  });
  const denied = describeApiError({ status: 403, message: 'Engineers and admins of the site only' });
  assert.equal(denied.message, "You don't have access to this");
  assert.match(denied.description, /^Engineers and admins of the site only\. A site admin can give you the role/);
  assert.equal(describeApiError({ status: 404, message: 'No such insight' }).action, 'back');
  const conflict = describeApiError({ status: 409, message: 'The change request was already approved' });
  assert.equal(conflict.message, 'This changed while you were working');
  assert.equal(conflict.action, 'refresh');
  assert.match(conflict.description, /already approved\. Refresh to see the latest/);
  assert.match(describeApiError({ status: 503, message: 'Busy' }).description, /request ID/);
  assert.equal(describeApiError({ status: 429, message: 'Slow down' }).message, 'Too many requests');
  // 422 with no form to show it on: what was refused, and to correct it.
  assert.deepEqual(describeApiError({ status: 422, message: 'unit: too long' }), {
    message: "This wasn't accepted",
    description: 'unit: too long. Correct it, then try again.',
    action: null,
  });
  // Anything else is said as the API said it.
  assert.deepEqual(describeApiError({ status: 418, message: 'Short and stout' }), {
    message: 'Short and stout',
    action: null,
  });
});

test('copied details hold what support needs, and nothing empty', () => {
  const at = new Date('2026-10-01T09:00:00Z');
  assert.equal(
    errorDetails({ what: 'Busy', requestId: 'req-1', page: '#/warnings', at, version: '0.1.0' }),
    'What: Busy\nRequest ID: req-1\nPage: #/warnings\nTime: 2026-10-01T09:00:00.000Z\nTiles: 0.1.0',
  );
  assert.doesNotMatch(errorDetails({ what: 'x', page: '#/', at, version: '0.1.0' }), /Request ID/);
});
