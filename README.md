# Sent Voice Agents for TypeScript

An AI agent that takes and places phone calls through [Sent](https://sent.dm), on the
[Sent Voice Agents protocol](https://github.com/sentdm/sent-dm-voice-protocol) 0.2.0, for Node.

Status: Preview, with the protocol. Generated and rendered by `sent-dm-sdk-pipeline` from the protocol at
`v0.2.0`; every release passes the protocol's conformance scenarios in CI.

Read the [Voice Agents docs](https://docs.sent.dm) to get started.

## Install

```sh
npm install @sentdm/voice-agents
```

Node 20.19 or later. The one dependency is `ws`. The package is ES modules; `require()` works on the Node
versions it supports.

## Quickstart

```ts
import { Agent, Session, UserSaid } from '@sentdm/voice-agents';

class Support extends Agent {
  override async onSessionStart(session: Session) {
    session.say('Hi, this is Acme support. How can I help?');
  }

  override async onUserSaid(session: Session, said: UserSaid) {
    if (said.text.includes('person')) {
      session.say('Transferring you now.');
      await session.transfer('+14155550100');
    } else {
      session.say(`You said ${said.text}`);
    }
  }
}

await new Support({ apiKey: process.env.SENT_API_KEY!, agentId: 'agent_...' }).serve();
```

`serve()` connects to Sent with the account API key and serves calls until SIGINT or SIGTERM; `run()` does the
same without the signal handlers, and `stop()` ends it. Each session's handlers run in order on their own
chain, so sessions never wait for one another. The runtime answers heartbeats, opens a new connection when one
drains or is lost, and resumes the sessions that can move; the handlers only see calls.

| Handler                         | When                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `onSessionStart(session)`       | A call reached the agent. In a text session, `say()` to speak                                  |
| `onUserSaid(session, said)`     | Text sessions: the caller said something; `said.correction` means it replaces the previous one |
| `onAudio(session, samples)`     | Audio sessions: the caller's audio, 16-bit mono PCM at `session.sampleRate`                    |
| `onToolResult(session, result)` | Sent answered a tool call; the awaiting promise gets the same result                           |
| `onSessionEnd(session, end)`    | The call left the agent; `end.reason` says why                                                 |
| `onSessionLost(session)`        | The connection was lost and the session could not be resumed                                   |

On a `Session`: `say(text, { last, interruptible })`, `clear()`, `sendAudio(samples)`, and the tools
`transfer(to)`, `hangup()`, `sendDtmf(digits)`, `hold(held)`, each resolving with Sent's `ToolResult`.
`session.from`, `to`, `direction`, `sessionType`, `language`, `context`, `sampleRate` carry what
`session.start` said.

`@sentdm/voice-agents/frames` holds every frame as a type, with `decode()` and `encode()` that check the
protocol's rules; it is generated from the protocol and not edited by hand.

## Develop

```sh
npm install
npm run typecheck && npm test && npm run build    # types, the tests, dist/
npm run format                                    # prettier
```

The conformance scenarios run in CI through the protocol's action, against `node dist/conformance.js`.
Releases are cut by release-please from `main` and published to npm from GitHub Actions.
