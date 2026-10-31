// One session: a call while this agent is on it.
//
// A Session is what the handlers of an Agent receive. It carries what session.start said about the call, sends
// the agent's frames on whichever connection the session is on, keeps the latest counted frames so a resume can
// send again the ones Sent did not read, and turns a tool call into the tool.result that answers it.
import { audioFrame } from './audio.ts';
import { RETAINED_FRAMES, UNCOUNTED } from './frames.ts';
import type {
  Frame,
  KnownFrame,
  Party,
  SessionEnd,
  SessionResume,
  SessionResumed,
  SessionStart,
  ToolCall,
  ToolResult,
} from './frames.ts';

/** The session ended before the tool call was answered. */
export class SessionEnded extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session ${sessionId} has ended`);
    this.name = 'SessionEnded';
    this.sessionId = sessionId;
  }
}

/** The connection a session sends on: the agent gives each session one, and moves it on a resume. */
export interface Sender {
  send(frame: KnownFrame): void;
  sendBytes(frame: Buffer): void;
}

type Pending = { resolve: (result: ToolResult) => void; reject: (error: Error) => void };

/** The call the agent is on, and the ways to act on it. Created by the agent; its handlers run in order. */
export class Session {
  readonly id: string;
  readonly callId: string;
  readonly agentId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly from: Party;
  readonly to: Party;
  readonly sessionType: 'text' | 'audio';
  readonly language: string | undefined;
  readonly context: Record<string, unknown>;
  readonly startedAt: string;
  /** Hz of the session's 16-bit mono PCM, both ways, in an audio session. */
  readonly sampleRate: number;
  /** The number in the header of the session's binary audio frames on its current connection. */
  stream: number | undefined;
  /** The latest resume token, or undefined when the session cannot be resumed. Keep it out of logs. */
  token: string | undefined;
  readonly windowMs: number | undefined;
  /** How many of Sent's counted frames for the session the agent has read: the `received` of a resume. */
  received = 0;
  /** session.end, once it arrived. */
  end: SessionEnd | undefined;

  /** @internal */ connection: Sender;
  /** @internal A session.resume was sent on the current connection and Sent has not answered it yet. */
  resuming = false;
  /** @internal The handlers run one after another on this chain. */
  queue: Promise<void> = Promise.resolve();
  private kept: KnownFrame[] = [];
  private before = 0;
  private calls = 0;
  private readonly pending = new Map<string, Pending>();

  /** What session.start said about the call. */
  readonly start: SessionStart;

  constructor(start: SessionStart, connection: Sender) {
    this.start = start;
    this.id = start.session_id;
    this.callId = start.call_id;
    this.agentId = start.agent_id;
    this.direction = start.direction;
    this.from = start.from;
    this.to = start.to;
    this.sessionType = start.session_type;
    this.language = start.language;
    this.context = { ...(start.context ?? {}) };
    this.startedAt = start.started_at;
    this.sampleRate = start.audio?.sample_rate ?? 16000;
    this.stream = start.audio?.stream;
    this.token = start.resume?.token;
    this.windowMs = start.resume?.window_ms;
    this.connection = connection;
  }

  // ----- what the agent does on the call -----

  get ended(): boolean {
    return this.end !== undefined;
  }

  /** Whether the session survives a lost connection: it has a resume token. */
  get resumable(): boolean {
    return this.token !== undefined;
  }

  /** How many counted frames the agent has sent for the session. */
  get sent(): number {
    return this.before + this.kept.length;
  }

  /**
   * Text sessions: speak `text` to the caller. Send a reply in pieces with `last: false` and finish with
   * `last: true`; the pieces are spoken as one utterance.
   */
  say(text: string, options: { last?: boolean; interruptible?: boolean } = {}): void {
    this.send({
      type: 'agent.say',
      session_id: this.id,
      text,
      ...(options.interruptible === undefined ? {} : { interruptible: options.interruptible }),
      ...(options.last === undefined ? {} : { last: options.last }),
    });
  }

  /** Drop the speech or audio the agent sent that Sent has not played yet. */
  clear(): void {
    this.send({ type: 'agent.clear', session_id: this.id });
  }

  /**
   * Audio sessions: play `samples`, 16-bit little-endian mono PCM at the session's sample rate. Send 20 ms per
   * call, and no more than 200 ms.
   */
  sendAudio(samples: Buffer): void {
    if (this.stream === undefined) throw new Error(`session ${this.id} is a text session`);
    this.connection.sendBytes(audioFrame(this.stream, samples));
  }

  /** Move the call to `to`: a Party, or an E.164 number. On success the session then ends with `transferred`. */
  transfer(to: Party | string): Promise<ToolResult> {
    const party: Party = typeof to === 'string' ? { kind: 'number', value: to } : to;
    return this.tool('transfer', {
      to: { kind: party.kind, ...(party.value ? { value: party.value } : {}) },
    });
  }

  /** End the call, after the speech the agent queued before it. */
  hangup(): Promise<ToolResult> {
    return this.tool('hangup');
  }

  /** Play `digits` on the call: 0 to 9, *, #, A to D, and w to wait half a second. */
  sendDtmf(digits: string): Promise<ToolResult> {
    return this.tool('send_dtmf', { digits });
  }

  /** Put the caller on hold, or take them off it. */
  hold(held = true): Promise<ToolResult> {
    return this.tool('hold', { held });
  }

  /** Call a tool by name and wait for its tool.result. Rejects with SessionEnded if the session ends first. */
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResult> {
    if (this.ended) return Promise.reject(new SessionEnded(this.id));
    const callRef = `t${++this.calls}`;
    const frame: ToolCall = { type: 'tool.call', session_id: this.id, call_ref: callRef, name };
    if (args) frame.arguments = args;
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.set(callRef, { resolve, reject });
      try {
        this.send(frame);
      } catch (error) {
        this.pending.delete(callRef);
        reject(error as Error);
      }
    });
  }

  // ----- what the agent's connection does with the session -----

  /** @internal Sends a frame for the session on its connection, keeping it if it counts. */
  send(frame: KnownFrame): void {
    if (this.ended) throw new SessionEnded(this.id);
    this.keep(frame);
    this.connection.send(frame);
  }

  private keep(frame: KnownFrame): void {
    if (UNCOUNTED.has(frame.type)) return;
    if (this.kept.push(frame) > RETAINED_FRAMES) {
      this.kept.shift();
      this.before++;
    }
  }

  /** @internal Counts one of Sent's frames for the session, as Counting frames in docs/protocol.md says. */
  read(frame: Frame): void {
    if (!UNCOUNTED.has(frame.type)) this.received++;
  }

  /** @internal */
  resumeFrame(): SessionResume {
    if (!this.token) throw new Error(`session ${this.id} has no resume token`);
    return { type: 'session.resume', session_id: this.id, token: this.token, received: this.received };
  }

  /**
   * @internal Takes the answer to a session.resume. Returns the frames to send again, or a hangup when Sent
   * needs one the session no longer keeps.
   */
  resumed(frame: SessionResumed): KnownFrame[] {
    this.resuming = false;
    this.token = frame.resume?.token;
    if (frame.audio) this.stream = frame.audio.stream;
    // Without a next token the session ended while it was detached; its replay ends with session.end.
    if (!frame.resume) return [];
    const unread = frame.received < this.before ? undefined : this.kept.slice(frame.received - this.before);
    this.before = frame.received;
    this.kept = [];
    const again: KnownFrame[] = unread ?? [
      { type: 'tool.call', session_id: this.id, call_ref: `t${++this.calls}`, name: 'hangup' },
    ];
    for (const frameAgain of again) this.keep(frameAgain);
    return again;
  }

  /** @internal */
  answerTool(result: ToolResult): void {
    const pending = this.pending.get(result.call_ref);
    if (!pending) return;
    this.pending.delete(result.call_ref);
    pending.resolve(result);
  }

  /** @internal */
  finish(end: SessionEnd): void {
    this.end = end;
    for (const pending of this.pending.values()) pending.reject(new SessionEnded(this.id));
    this.pending.clear();
  }
}
