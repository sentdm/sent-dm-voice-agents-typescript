// The generated frames against the protocol's own fixtures, copied here by the lane at render time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { FrameError, decode, encode } from '../src/frames.ts';

const fixtures = (kind: string): string[] => {
  const root = path.join(import.meta.dirname, 'fixtures', kind);
  return fs
    .readdirSync(root)
    .flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((file) => path.join(root, dir, file)))
    .sort();
};

describe('valid frames', () => {
  for (const file of fixtures('valid')) {
    test(path.relative(path.join(import.meta.dirname, 'fixtures'), file), () => {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const frame = decode(data);
      assert.equal(frame.type, data['type']);
      const again = encode(frame);
      for (const [key, value] of Object.entries(data))
        assert.deepEqual(again[key], value, `${key} changed on the way back`);
      assert.deepEqual(decode(again), frame);
    });
  }
});

describe('invalid frames', () => {
  for (const file of fixtures('invalid')) {
    test(path.relative(path.join(import.meta.dirname, 'fixtures'), file), () => {
      assert.throws(() => decode(JSON.parse(fs.readFileSync(file, 'utf8'))), FrameError);
    });
  }
});

test('unknown frames and fields pass', () => {
  const frame = decode({ type: 'session.note', session_id: 'vs_1' });
  assert.equal(frame.type, 'session.note');
  const said = decode({ type: 'user.said', session_id: 'vs_1', text: 'hi', mood: 'good' });
  assert.equal(said.type, 'user.said');
});
