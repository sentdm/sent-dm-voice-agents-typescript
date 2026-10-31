// Sent Voice Agents for TypeScript: an AI agent that takes and places phone calls through Sent.
//
//   import { Agent } from '@sentdm/voice-agents';
//
//   class Support extends Agent {
//     async onSessionStart(session) { session.say('Hi, this is Acme support. How can I help?'); }
//     async onUserSaid(session, said) {
//       if (said.text.includes('person')) { session.say('Transferring you now.'); await session.transfer('+14155550100'); }
//       else session.say(`You said ${said.text}`);
//     }
//   }
//
//   await new Support({ apiKey: process.env.SENT_API_KEY!, agentId: 'agent_...' }).serve();
//
// The agent connects to Sent with the account API key and serves calls until stopped. `frames` holds the
// protocol's frames as types, generated from sent-dm-voice-protocol.
export { Agent, DEFAULT_URL, Refused } from './agent.ts';
export type { AgentOptions, Logger } from './agent.ts';
export { audioFrame, bytesPerFrame, samplesOf, streamOf } from './audio.ts';
export * as frames from './frames.ts';
export { FrameError, PROTOCOL_VERSION } from './frames.ts';
export type { Party, SessionEnd, ToolResult, UserSaid } from './frames.ts';
export { Session, SessionEnded } from './session.ts';
export { VERSION } from './version.ts';
