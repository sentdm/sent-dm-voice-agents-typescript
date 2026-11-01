// The session's bookkeeping, with a connection that records what it sends: counting both ways, the retained
// frames, what a resume sends again, and tool calls answered by their result.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameError, RETAINED_FRAMES, decode } from '../src/frames.ts';
import type {
  KnownFrame,
  SessionEnd,
  SessionResumed,
  SessionStart,
  ToolCall,
  ToolResult,
} from '../src/frames.ts';
import { Session, SessionEnded } from '../src/session.ts';

class Recorder {
  frames: KnownFrame[] = [];
  audio: Buffer[] = [];
  send(frame: KnownFrame) {
    this.frames.push(frame);
  }
  sendBytes(frame: Buffer) {
    this.audio.push(frame);
  }
}

const start = (extra: Record<string, unknown> = {}): SessionStart =>
  decode({
    type: 'session.start',
    session_id: 'vs_1',
    call_id: 'call_1',
    agent_id: 'agent_1',
    direction: 'inbound',
    from: { kind: 'number', value: '+14155550100' },
    to: { kind: 'agent', value: 'agent_1' },
    session_type: 'text',
    started_at: '2026-10-31T00:00:00Z',
    resume: { token: 'vsr_' + 'a'.repeat(30), window_ms: 15000 },
    ...extra,
  }) as SessionStart;

test('counts both ways and keeps the latest frames', () => {
  const recorder = new Recorder();
  const session = new Session(start(), recorder);
  assert.ok(session.resumable);
  session.read(decode({ type: 'user.said', session_id: 'vs_1', text: 'hi' }));
  session.read(decode({ type: 'session.resumed', session_id: 'vs_1', received: 0 }));
  assert.equal(session.received, 1);
  for (let i = 0; i < RETAINED_FRAMES + 5; i++) session.say(`line ${i}`);
  assert.equal(session.sent, RETAINED_FRAMES + 5);
  assert.equal(recorder.frames.length, RETAINED_FRAMES + 5);
});

test('a resume sends again what Sent did not read', () => {
  const session = new Session(start(), new Recorder());
  session.say('one');
  session.say('two');
  session.say('three');
  const resume = session.resumeFrame();
  assert.ok(resume.token.startsWith('vsr_'));
  assert.equal(resume.received, 0);
  const again = session.resumed(
    decode({
      type: 'session.resumed',
      session_id: 'vs_1',
      received: 1,
      resume: { token: 'vsr_' + 'b'.repeat(30), window_ms: 15000 },
    }) as SessionResumed,
  );
  assert.deepEqual(
    again.map((f) => (f as { text: string }).text),
    ['two', 'three'],
  );
  assert.ok(session.token?.startsWith('vsr_b'));
  assert.equal(session.sent, 3);
});

test('a resume past the retained frames hangs up', () => {
  const session = new Session(start(), new Recorder());
  for (let i = 0; i < RETAINED_FRAMES + 3; i++) session.say(String(i));
  const again = session.resumed(
    decode({
      type: 'session.resumed',
      session_id: 'vs_1',
      received: 1,
      resume: { token: 'vsr_' + 'c'.repeat(30), window_ms: 15000 },
    }) as SessionResumed,
  );
  assert.equal(again.length, 1);
  assert.equal((again[0] as ToolCall).name, 'hangup');
});

test('tool calls are answered by their result', async () => {
  const recorder = new Recorder();
  const session = new Session(start(), recorder);
  const promise = session.transfer('+14155550199');
  const call = recorder.frames.at(-1) as ToolCall;
  assert.equal(call.name, 'transfer');
  assert.deepEqual(call.arguments, { to: { kind: 'number', value: '+14155550199' } });
  session.answerTool(
    decode({ type: 'tool.result', session_id: 'vs_1', call_ref: call.call_ref, ok: true }) as ToolResult,
  );
  assert.equal((await promise).ok, true);
});

test('a session that ended refuses more', async () => {
  const session = new Session(start(), new Recorder());
  const promise = session.hangup();
  session.finish(
    decode({
      type: 'session.end',
      session_id: 'vs_1',
      reason: 'caller_hung_up',
      duration_ms: 10,
    }) as SessionEnd,
  );
  await assert.rejects(promise, SessionEnded);
  assert.throws(() => session.say('too late'), SessionEnded);
});

test('audio goes out on the session stream', () => {
  const recorder = new Recorder();
  const session = new Session(start({ session_type: 'audio', audio: { stream: 7 } }), recorder);
  session.sendAudio(Buffer.alloc(640, 1));
  assert.deepEqual([...recorder.audio[0]!.subarray(0, 2)], [0, 7]);
  assert.equal(recorder.audio[0]!.length, 642);
});

test('a frame that breaks the protocol is refused before it counts', async () => {
  const recorder = new Recorder();
  const session = new Session(start(), recorder);
  assert.throws(() => session.say(''), FrameError);
  await assert.rejects(session.sendDtmf('xyz'), FrameError);
  assert.equal(session.sent, 0);
  assert.equal(recorder.frames.length, 0);
});

test('frames sent during a resume wait for the replay', async () => {
  const recorder = new Recorder();
  const session = new Session(start(), recorder);
  session.say('before');
  session.resuming = true;
  session.say('during');
  const promise = session.hangup();
  assert.deepEqual(
    recorder.frames.map((f) => (f as { text: string }).text),
    ['before'],
  );
  assert.equal(session.sent, 3);
  const again = session.resumed(
    decode({
      type: 'session.resumed',
      session_id: 'vs_1',
      received: 1,
      resume: { token: 'vsr_' + 'd'.repeat(30), window_ms: 15000 },
    }) as SessionResumed,
  );
  assert.deepEqual(
    again.map((f) => (f as { text?: string; name?: string }).text ?? (f as { name?: string }).name),
    ['during', 'hangup'],
  );
  session.answerTool(
    decode({
      type: 'tool.result',
      session_id: 'vs_1',
      call_ref: (again[1] as ToolCall).call_ref,
      ok: true,
    }) as ToolResult,
  );
  assert.equal((await promise).ok, true);
});

test('audio during a resume is dropped, and after the end refused', () => {
  const recorder = new Recorder();
  const session = new Session(start({ session_type: 'audio', audio: { stream: 7 } }), recorder);
  session.resuming = true;
  session.sendAudio(Buffer.alloc(640, 1));
  assert.equal(recorder.audio.length, 0);
  session.resuming = false;
  session.finish(
    decode({
      type: 'session.end',
      session_id: 'vs_1',
      reason: 'caller_hung_up',
      duration_ms: 10,
    }) as SessionEnd,
  );
  assert.throws(() => session.sendAudio(Buffer.alloc(640, 1)), SessionEnded);
});

test('a lost session fails its tool calls and refuses more', async () => {
  const session = new Session(start(), new Recorder());
  const promise = session.hangup();
  session.abandon();
  await assert.rejects(promise, SessionEnded);
  assert.ok(session.ended && session.lost);
  assert.throws(() => session.say('too late'), SessionEnded);
});
