// Form validation (U2.07): the API's 422 details as field errors. The rest (errors on the fields,
// the summary, checking as fields are left) is in the browser tests (e2e/smoke.test.js).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { apiFieldErrors, isFieldError } from '../js/lib/forms.ts';

test("the API's 422 details name fields by their path, without where they came from", () => {
  assert.deepEqual(
    apiFieldErrors([
      { loc: ['body', 'name'], msg: 'String should match pattern' },
      { loc: ['body', 'config', 'limit'], msg: 'Value error, must be above 0' },
      { loc: ['query', 'q'], msg: 'too long' },
      { loc: ['body'], msg: 'Field required' }, // the whole body: no field
      { msg: 'no loc' },
    ]),
    [
      { name: 'name', message: 'String should match pattern' },
      { name: 'config.limit', message: 'Must be above 0' },
      { name: 'q', message: 'Too long' },
    ],
  );
  assert.deepEqual(apiFieldErrors('Engineers only'), []);
  assert.deepEqual(apiFieldErrors(undefined), []);
});

test('a field error is told apart from a change', () => {
  assert.equal(isFieldError({ name: 'rate', message: 'Above 0' }), true);
  assert.equal(isFieldError({ unit: 'm' }), false);
  assert.equal(isFieldError(null), false);
});
