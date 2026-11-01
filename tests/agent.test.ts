// The agent's bookkeeping around a connection, without a socket: which errors refuse a resume, when the
// backoff starts over, what a handler that throws synchronously does, and what a lost session's chain sees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.ts';
import { decode } from '../src/frames.ts';
import type { ConnectionReady, ErrorFrame, Ping, SessionStart } from '../src/frames.ts';
import { Session, SessionEnded } from '../src/session.ts';

// The private parts the tests reach into: the agent's state and the frame handlers.
type Internals = {
  connections: Set<Connection>;
  live: Map<string, Session>;
  attempt: number;
  handle(connection: Connection, frame: unknown): void;
  ready(connection: Connection, frame: ConnectionReady): void;
  start(connection: Connection, frame: SessionStart): void;
  lost(session: Session): void;
};
type Connection = {
  ready: boolean;
  pending: Session[];
  sessions: Map<string, Session>;
  send(frame: unknown): void;
  sendBytes(frame: Buffer): void;
};

const quiet = { info() {}, warn() {}, error() {} };
const connection = (): Connection => ({
  ready: true,
  pending: [],
  sessions: new Map(),
  send() {},
  sendBytes() {},
});
const start = (): SessionStart =>
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
  }) as SessionStart;
const error = (fields: Record<string, unknown> = {}): ErrorFrame =>
  decode({
    type: 'error',
    session_id: 'vs_1',
    error: { code: 'frame_not_allowed', message: 'no' },
    ...fields,
  }) as ErrorFrame;

const agentWith = (connection: Connection, resuming = true): [Agent, Internals, Session] => {
  const agent = new Agent({ apiKey: 'k', agentId: 'agent_1', logger: quiet });
  const internals = agent as unknown as Internals;
  const session = new Session(start(), connection);
  session.resuming = resuming;
  internals.live.set(session.id, session);
  connection.sessions.set(session.id, session);
  internals.connections.add(connection);
  return [agent, internals, session];
};

test('only an error about the resume refuses it', async () => {
  const c = connection();
  const [agent, internals, session] = agentWith(c);
  internals.handle(c, error({ frame_type: 'agent.say' }));
  assert.ok(session.resuming && c.sessions.has(session.id) && !session.lost);
  internals.handle(
    c,
    error({ frame_type: 'session.resume', error: { code: 'resume_failed', message: 'gone' } }),
  );
  assert.ok(session.lost && !c.sessions.has(session.id) && !internals.live.has(session.id));
  await session.queue;
  agent.stop();
});

test('the backoff starts over after a heartbeat, not on ready', () => {
  const c = connection();
  c.ready = false;
  const [agent, internals] = agentWith(c, false);
  internals.attempt = 3;
  internals.ready(
    c,
    decode({
      type: 'connection.ready',
      protocol_version: '0.2.0',
      heartbeat_interval_ms: 15000,
      max_sessions: 10,
    }) as ConnectionReady,
  );
  assert.equal(internals.attempt, 3);
  internals.handle(c, decode({ type: 'ping', ts: 1 }) as Ping);
  assert.equal(internals.attempt, 0);
  agent.stop();
});

test('a lost session reaches its handler after its tool call fails, and a throwing handler is contained', async () => {
  const seen: string[] = [];
  class Noticing extends Agent {
    override async onSessionStart(session: Session): Promise<void> {
      try {
        await session.hangup();
      } catch (e) {
        if (e instanceof SessionEnded) seen.push('tool failed');
      }
    }
    override onSessionLost(session: Session): Promise<void> {
      seen.push('lost');
      throw new Error(`thrown before any await for ${session.id}`);
    }
  }
  const c = connection();
  const agent = new Noticing({ apiKey: 'k', agentId: 'agent_1', logger: quiet });
  const internals = agent as unknown as Internals;
  internals.connections.add(c);
  internals.start(c, start());
  const session = agent.sessions[0]!;
  await new Promise((r) => setTimeout(r, 0));
  internals.lost(session);
  await session.queue;
  assert.deepEqual(seen, ['tool failed', 'lost']);
  assert.deepEqual(agent.sessions, []);
  agent.stop();
});
