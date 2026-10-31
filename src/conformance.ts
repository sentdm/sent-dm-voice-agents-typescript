// The conformance agent of sent-dm-voice-protocol's conformance/README.md, on this SDK's API. The protocol's
// harness runs it in CI before every release: `node dist/conformance.js` connects to SENT_CONFORMANCE_URL
// with any API key and does exactly what the README's table says.
import fs from 'node:fs';
import { Agent } from './agent.ts';
import type { ToolResult, UserSaid } from './frames.ts';
import { Session, SessionEnded } from './session.ts';

export const GREETING = 'Hello from the conformance agent.';

export type Action =
  | { action: 'say'; text: string; last?: boolean }
  | { action: 'tool'; name: string; arguments?: Record<string, unknown> };

/**
 * What a user.said asks for: the actions the agent performs in order. A command is the text up to the first
 * space; `stream` takes the next word as the first piece.
 */
export function decide(text: string): Action[] {
  const space = text.indexOf(' ');
  const command = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? '' : text.slice(space + 1);
  switch (command) {
    case 'echo':
      return [{ action: 'say', text: rest }];
    case 'stream': {
      const next = rest.indexOf(' ');
      const word = next < 0 ? rest : rest.slice(0, next);
      const remainder = next < 0 ? '' : rest.slice(next + 1);
      return [
        { action: 'say', text: word, last: false },
        { action: 'say', text: remainder },
      ];
    }
    case 'transfer':
      return [
        { action: 'tool', name: 'transfer', arguments: { to: { kind: 'user', value: 'conformance-desk' } } },
      ];
    case 'hangup':
      return [{ action: 'tool', name: 'hangup' }];
    case 'dtmf':
      return [{ action: 'tool', name: 'send_dtmf', arguments: { digits: rest } }];
    case 'hold':
      return [{ action: 'tool', name: 'hold', arguments: { held: true } }];
    default:
      return [];
  }
}

export class ConformanceAgent extends Agent {
  override async onSessionStart(session: Session): Promise<void> {
    if (session.sessionType === 'text') session.say(GREETING);
  }

  override async onUserSaid(session: Session, said: UserSaid): Promise<void> {
    if (said.correction) session.clear();
    for (const step of decide(said.text)) {
      try {
        if (step.action === 'say') session.say(step.text, step.last === undefined ? {} : { last: step.last });
        // The harness answers every tool call; the result also reaches onToolResult.
        else await session.tool(step.name, step.arguments);
      } catch (error) {
        if (error instanceof SessionEnded) return;
        throw error;
      }
    }
  }

  override async onToolResult(session: Session, result: ToolResult): Promise<void> {
    if (!result.ok && result.error) {
      try {
        session.say(`Tool failed: ${result.error.code}`);
      } catch (error) {
        if (!(error instanceof SessionEnded)) throw error;
      }
    }
  }

  override async onAudio(session: Session, samples: Buffer): Promise<void> {
    session.sendAudio(samples);
  }
}

// Run by the harness's --agent, which sets SENT_CONFORMANCE_URL, or by hand against a harness on localhost.
// Node runs a module by its real path, so a symlinked argv[1] has to be resolved before comparing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  const url = process.env['SENT_CONFORMANCE_URL'] || 'ws://localhost:8765/v1/agents/connect';
  await new ConformanceAgent({ apiKey: 'conformance', agentId: 'agent_conformance', url }).serve();
}
