// The agent: one process that serves calls on the Sent Voice Agents protocol.
//
// Subclass Agent and override the handlers you need; start() connects to Sent with the account API key and
// serves sessions until stop(). The runtime answers heartbeats, opens a new connection when one drains or is
// lost, and resumes the sessions that can move, so the handlers only see calls. Each session's handlers run
// one after another in the order Sent's frames arrived; different sessions run at the same time.
import WebSocket from 'ws';
import { samplesOf, streamOf } from './audio.ts';
import { CONNECT_PATH, FrameError, HOST, SUBPROTOCOL, decode, encode } from './frames.ts';
import type {
  ConnectionReady,
  ErrorFrame,
  Frame,
  KnownFrame,
  SessionEnd,
  SessionResumed,
  SessionStart,
  ToolResult,
  UnknownFrame,
  UserSaid,
} from './frames.ts';
import { Session } from './session.ts';
import type { Sender } from './session.ts';

export const DEFAULT_URL = `wss://${HOST}${CONNECT_PATH}`;
/** The longest wait before another attempt to connect. */
const MAX_BACKOFF_MS = 30_000;
/** How long a handshake may take before the attempt counts as failed, and how long an open socket may wait for connection.ready. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How many heartbeat intervals without a frame make a connection dead, as Heartbeats in docs/protocol.md says. */
const SILENT_INTERVALS = 3;
/** Why Sent refuses a handshake with each status, from Connecting in docs/protocol.md. Each needs a person. */
const REFUSALS: Record<number, string> = {
  400: 'agent_id or the subprotocol is missing',
  401: 'the API key is not valid',
  403: 'voice is not enabled for the account, or the key does not own the agent',
  404: 'the agent does not exist',
};

/** Sent refused the connection for a reason that needs a person: the status and why. */
export class Refused extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`${status}: ${reason}`);
    this.name = 'Refused';
    this.status = status;
    this.reason = reason;
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AgentOptions {
  /** The account API key. Keep it on the server the agent runs on. */
  apiKey: string;
  /** The agent, as `POST /v3/voice/agents` created it. */
  agentId: string;
  /** Where to connect. The default is Sent. */
  url?: string;
  /** Where the runtime's log lines go. The default is the console; tokens never appear in them. */
  logger?: Logger;
}

/** One WebSocket to Sent, and the sessions it reads and writes. */
class Connection implements Sender {
  socket: WebSocket | undefined;
  ready = false;
  draining = false;
  readonly sessions = new Map<string, Session>();
  pending: Session[];
  timer: NodeJS.Timeout | undefined;
  heartbeatMs = 0;
  private readonly log: Logger;

  constructor(pending: Session[], log: Logger) {
    this.pending = pending;
    this.log = log;
  }

  send(frame: KnownFrame): void {
    const data = encode(frame);
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket.send(JSON.stringify(data));
    // A session frame is still counted as sent. Sent's received on the next resume says to send it again.
    this.log.info(`not sent: ${frame.type}, the connection is not open`);
  }

  sendBytes(frame: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }
}

const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** Serves calls. Override the handlers; they run on the session's own chain, in order. */
export class Agent {
  readonly apiKey: string;
  readonly agentId: string;
  readonly url: string;
  protected readonly log: Logger;
  private readonly connections = new Set<Connection>();
  private readonly live = new Map<string, Session>();
  private attempt = 0;
  private stopped = false;
  private done: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(options: AgentOptions) {
    this.apiKey = options.apiKey;
    this.agentId = options.agentId;
    this.url = options.url ?? DEFAULT_URL;
    this.log = options.logger ?? consoleLogger;
  }

  // ----- handlers to override -----

  /** A connection to Sent is ready for sessions. */
  async onConnected(_ready: ConnectionReady): Promise<void> {}

  /** A call reached the agent. In a text session, say() to speak; an audio session waits for audio. */
  async onSessionStart(_session: Session): Promise<void> {}

  /** Text sessions: the caller said something. With correction true it replaces the previous one. */
  async onUserSaid(_session: Session, _said: UserSaid): Promise<void> {}

  /** Audio sessions: the caller's audio, 16-bit little-endian mono PCM at session.sampleRate. */
  async onAudio(_session: Session, _samples: Buffer): Promise<void> {}

  /** Sent answered a tool call. The call's awaiting promise gets the same result. */
  async onToolResult(_session: Session, _result: ToolResult): Promise<void> {}

  /** A session frame this SDK version does not know. It was counted; nothing else is needed. */
  async onFrame(_session: Session, _frame: UnknownFrame): Promise<void> {}

  /** The call left the agent. end.reason says why. */
  async onSessionEnd(_session: Session, _end: SessionEnd): Promise<void> {}

  /** The session's connection was lost and it could not be resumed: Sent ends the call with agent_unreachable. */
  async onSessionLost(_session: Session): Promise<void> {}

  /** Sent refused a frame; the connection stays open. */
  async onError(_error: ErrorFrame): Promise<void> {}

  // ----- running -----

  /**
   * Serves calls until stop(). Resolves after stop(); rejects with Refused when Sent refuses the connection for
   * a reason that needs a person.
   */
  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.done = { resolve, reject };
      this.open([], 0);
    });
  }

  /** Runs the agent until SIGINT or SIGTERM. For a program whose main is the agent. */
  serve(): Promise<void> {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => this.stop());
    return this.run();
  }

  /** Stops serving: every connection closes with 1000, so the calls on them follow the agent's fallback at once. */
  stop(): void {
    this.stopped = true;
    for (const connection of this.connections) {
      clearTimeout(connection.timer);
      connection.socket?.close(1000);
    }
    this.done?.resolve();
    this.done = undefined;
  }

  /** Every live session. */
  get sessions(): Session[] {
    return [...this.live.values()];
  }

  // ----- connections -----

  private open(pending: Session[], delay: number): void {
    const connection = new Connection(pending, this.log);
    this.connections.add(connection);
    connection.timer = setTimeout(() => this.dial(connection), delay);
  }

  private dial(connection: Connection): void {
    const url = new URL(this.url);
    url.searchParams.set('agent_id', this.agentId);
    const socket = new WebSocket(url, SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    connection.socket = socket;
    socket.on('open', () => {
      this.log.info(`connected to ${url.host}`);
      // Until connection.ready arrives the socket has the handshake's deadline; ready() hands it to heard().
      clearTimeout(connection.timer);
      connection.timer = setTimeout(() => {
        this.log.warn(`no connection.ready for ${HANDSHAKE_TIMEOUT_MS} ms, closing`);
        socket.terminate();
      }, HANDSHAKE_TIMEOUT_MS);
    });
    socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0;
      request.destroy();
      this.log.error(`refused with ${status}: ${REFUSALS[status] ?? 'trying again'}`);
      if (status in REFUSALS) {
        this.stopped = true;
        this.done?.reject(new Refused(status, REFUSALS[status]!));
        this.done = undefined;
      }
      this.closed(connection);
    });
    socket.on('error', (error) => this.log.warn(`socket error: ${error.message}`));
    socket.on('close', (code, reason) => {
      this.log.info(`closed with ${code} ${reason.toString()}`.trim());
      this.closed(connection);
    });
    socket.on('message', (data, isBinary) => {
      this.heard(connection);
      if (isBinary) return this.audio(connection, data as Buffer);
      let frame: Frame;
      try {
        frame = decode(JSON.parse(data.toString()));
      } catch (error) {
        if (error instanceof FrameError || error instanceof SyntaxError)
          return this.log.warn(`ignored a frame: ${error.message}`);
        throw error;
      }
      this.handle(connection, frame);
    });
  }

  /** Resets the watchdog: no frame for three heartbeat intervals means the connection is dead. */
  private heard(connection: Connection): void {
    if (!connection.ready) return;
    clearTimeout(connection.timer);
    connection.timer = setTimeout(() => {
      this.log.warn(`no frame for ${SILENT_INTERVALS * connection.heartbeatMs} ms, closing`);
      connection.socket?.terminate();
    }, SILENT_INTERVALS * connection.heartbeatMs);
  }

  private handle(connection: Connection, frame: Frame): void {
    switch (frame.type) {
      case 'connection.ready':
        return this.ready(connection, frame as ConnectionReady);
      case 'ping':
        connection.send({ type: 'pong', ts: (frame as { ts: number }).ts });
        // A connection that lived through a heartbeat interval is a good one: the next loss starts the backoff
        // over. A connection that dies before its first ping keeps it growing.
        if (connection.ready) this.attempt = 0;
        return;
      case 'connection.draining':
        return this.drain(connection);
      case 'session.start':
        return this.start(connection, frame as SessionStart);
      case 'session.resumed':
        return this.resumed(connection, frame as SessionResumed);
      case 'error':
        this.failed(connection, frame as ErrorFrame);
        void this.safely(() => this.onError(frame as ErrorFrame));
        return;
      default:
        if (typeof (frame as { session_id?: unknown }).session_id !== 'string')
          return this.log.info(`ignored a ${frame.type} frame`);
        return this.sessionFrame(connection, frame);
    }
  }

  private ready(connection: Connection, frame: ConnectionReady): void {
    connection.ready = true;
    connection.heartbeatMs = frame.heartbeat_interval_ms;
    this.heard(connection);
    const pending = connection.pending.filter((session) => this.live.get(session.id) === session);
    connection.pending = [];
    this.log.info(
      `ready: protocol ${frame.protocol_version}, up to ${frame.max_sessions} sessions, resuming ${pending.length}`,
    );
    for (const session of pending) this.resume(connection, session);
    void this.safely(() => this.onConnected(frame));
  }

  private resume(connection: Connection, session: Session): void {
    for (const other of this.connections) other.sessions.delete(session.id);
    connection.sessions.set(session.id, session);
    session.connection = connection;
    session.resuming = true;
    connection.send(session.resumeFrame());
  }

  private drain(connection: Connection): void {
    connection.draining = true;
    const moving = [...connection.sessions.values()].filter((session) => session.token && !session.resuming);
    this.log.info(`draining, moving ${moving.length} session(s)`);
    this.open(moving, 0);
  }

  private start(connection: Connection, frame: SessionStart): void {
    const session = new Session(frame, connection);
    this.live.set(session.id, session);
    connection.sessions.set(session.id, session);
    this.log.info(`session ${session.id} started: ${frame.session_type}, ${frame.direction}`);
    this.enqueue(session, () => this.onSessionStart(session));
  }

  private sessionFrame(connection: Connection, frame: Frame): void {
    const session = connection.sessions.get((frame as { session_id: string }).session_id);
    // A session that moved to another connection is read there: Sent replays what this one did not deliver.
    if (!session || session.resuming) return;
    session.read(frame);
    switch (frame.type) {
      case 'user.said':
        return this.enqueue(session, () => this.onUserSaid(session, frame as UserSaid));
      case 'tool.result':
        session.answerTool(frame as ToolResult);
        return this.enqueue(session, () => this.onToolResult(session, frame as ToolResult));
      case 'session.end':
        session.finish(frame as SessionEnd);
        this.forget(session);
        return this.enqueue(session, () => this.onSessionEnd(session, frame as SessionEnd));
      default:
        return this.enqueue(session, () => this.onFrame(session, frame as UnknownFrame));
    }
  }

  private audio(connection: Connection, message: Buffer): void {
    if (message.length < 2) return;
    const stream = streamOf(message);
    for (const session of connection.sessions.values()) {
      if (session.stream === stream && !session.resuming) {
        return this.enqueue(session, () => this.onAudio(session, samplesOf(message)));
      }
    }
  }

  private resumed(connection: Connection, frame: SessionResumed): void {
    const session = connection.sessions.get(frame.session_id);
    if (!session || !session.resuming) return;
    const again = session.resumed(frame);
    this.log.info(`session ${session.id} resumed, sending ${again.length} frame(s) again`);
    for (const frameAgain of again) connection.send(frameAgain);
  }

  /**
   * An error is uncounted, as Counting frames in docs/protocol.md says. Only one that refuses a session.resume
   * changes the session's fate; any other is the handler's to read.
   */
  private failed(connection: Connection, frame: ErrorFrame): void {
    this.log.warn(`error ${frame.error.code}: ${frame.error.message}`);
    const session = frame.session_id ? connection.sessions.get(frame.session_id) : undefined;
    if (!session || !session.resuming) return;
    if (
      frame.frame_type !== 'session.resume' &&
      !['resume_failed', 'connection_full'].includes(frame.error.code)
    )
      return;
    session.resuming = false;
    connection.sessions.delete(session.id);
    // This connection already carries max_sessions. The token is still good on another one.
    if (frame.error.code === 'connection_full') return this.open([session], 0);
    this.lost(session);
  }

  private forget(session: Session): void {
    this.live.delete(session.id);
    for (const connection of this.connections) connection.sessions.delete(session.id);
  }

  private lost(session: Session): void {
    this.forget(session);
    session.abandon();
    this.enqueue(session, () => this.onSessionLost(session));
  }

  private closed(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    clearTimeout(connection.timer);
    if (this.stopped) return;
    const queued = (session: Session) =>
      [...this.connections].some((other) => other.pending.includes(session));
    const lost = [...connection.sessions.values()];
    const movable = lost.filter((session) => session.token && !session.resuming && !queued(session));
    for (const session of lost) {
      if (movable.includes(session) || queued(session)) continue;
      this.log.warn(
        `session ${session.id} lost: ${session.token ? 'its resume was not answered' : 'it has no resume token'}`,
      );
      this.lost(session);
    }
    const pending = [
      ...connection.pending.filter((session) => this.live.get(session.id) === session),
      ...movable,
    ];
    if (connection.draining && !pending.length) return;
    const delay = this.backoff();
    this.log.info(`reconnecting in ${delay} ms to resume ${pending.length} session(s)`);
    this.open(pending, delay);
  }

  private backoff(): number {
    const delay = this.attempt === 0 ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1));
    this.attempt++;
    return delay;
  }

  // ----- the session's chain -----

  private enqueue(session: Session, handler: () => Promise<void>): void {
    session.queue = session.queue.then(() => this.safely(handler));
  }

  /**
   * Runs a handler; an exception in it, thrown or rejected, is logged and does not take the session or the agent
   * down.
   */
  private async safely(handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch (error) {
      this.log.error(
        `a handler failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
