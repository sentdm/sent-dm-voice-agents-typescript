import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../src/conformance.ts';

test('commands', () => {
  assert.deepEqual(decide('echo hello there'), [{ action: 'say', text: 'hello there' }]);
  assert.deepEqual(decide('stream Let me think'), [
    { action: 'say', text: 'Let', last: false },
    { action: 'say', text: 'me think' },
  ]);
  assert.deepEqual(decide('transfer'), [
    { action: 'tool', name: 'transfer', arguments: { to: { kind: 'user', value: 'conformance-desk' } } },
  ]);
  assert.deepEqual(decide('hangup'), [{ action: 'tool', name: 'hangup' }]);
  assert.deepEqual(decide('dtmf 12#'), [{ action: 'tool', name: 'send_dtmf', arguments: { digits: '12#' } }]);
  assert.deepEqual(decide('hold'), [{ action: 'tool', name: 'hold', arguments: { held: true } }]);
  assert.deepEqual(decide('something else'), []);
});
