# react-native-realtime-voice

Voice-to-voice agents for **React Native / Expo**, on the OpenAI Realtime API over WebRTC.

Headless core, optional UI kit, tools that carry their own handlers, and ephemeral-token auth so your OpenAI key never ships inside your app.

```tsx
const voice = useRealtimeVoice({
  auth: { getToken: () => fetch("/api/realtime-token").then((r) => r.json()) },
  instructions: () =>
    `You are a friendly coach. The user's name is ${user.name}.`,
  tools: [logWaterTool],
});

<VoiceAgentView voice={voice} title="Talk to your coach" />;
```

---

## Install

```bash
# from npm (once published)
npx expo install react-native-realtime-voice

# or straight from GitHub — no publish required
npm install github:tejasvi8686/react-native-realtime-voice

# pin to a tag or commit for reproducible builds
npm install github:tejasvi8686/react-native-realtime-voice#v0.1.0
```

A git install compiles itself during `npm install` via the `prepare` script, so
it produces the same output as the published tarball.

You also need a WebRTC implementation and (optionally) audio routing:

```bash
# either one — the package works with both
npx expo install @config-plugins/react-native-webrtc react-native-webrtc
# or, if you already use LiveKit:
npx expo install @livekit/react-native-webrtc

# recommended: routes call audio to the loudspeaker instead of the earpiece
npx expo install react-native-incall-manager
```

Add the config plugins to `app.json`. The `react-native-realtime-voice` plugin writes the microphone permission and Android audio permissions for you:

```json
{
  "expo": {
    "plugins": [
      "@config-plugins/react-native-webrtc",
      [
        "react-native-realtime-voice",
        {
          "microphonePermission": "We use your mic so you can talk to your coach.",
          "backgroundAudio": false
        }
      ]
    ]
  }
}
```

> Requires a development build — WebRTC has native code, so this does not run in Expo Go.
> `npx expo prebuild --clean && npx expo run:ios`

### Register the WebRTC module

Once, at app start, before the first connection:

```ts
// App.tsx — pick the line matching the package you installed
import "react-native-realtime-voice/webrtc/rn"; // react-native-webrtc
// import "react-native-realtime-voice/webrtc/livekit";  // @livekit/react-native-webrtc
```

This exists because Metro resolves `require` statically: the package cannot `try/catch` an optional native module, so you point it at the one you have. The adapter file is the only place either package is referenced, so the other is never bundled.

---

## Credentials

### Ephemeral tokens (do this)

Your backend mints a short-lived `ek_...` secret. The device never sees your OpenAI key.

```ts
useRealtimeVoice({
  auth: {
    getToken: async () => {
      const res = await fetch("https://your-api.example/realtime-token", {
        headers: { Authorization: `Bearer ${userSessionJwt}` },
      });
      return res.json(); // { value: "ek_...", expires_at: 1234567890 }
    },
  },
});
```

The package caches the token and re-mints it automatically when it nears expiry or when a reconnect needs a fresh one — `getToken` may be called more than once per session, so keep it cheap and don't cache inside it.

Server side, `mintEphemeralToken` is exported for your backend (see [`examples/token-endpoint/`](examples/token-endpoint)):

```ts
import { mintEphemeralToken } from "react-native-realtime-voice";

const token = await mintEphemeralToken({
  apiKey: process.env.OPENAI_API_KEY!,
  session: {
    type: "realtime",
    model: "gpt-realtime",
    audio: { output: { voice: "alloy" } },
  },
  expiresAfterSeconds: 120,
});
```

**This splits ownership usefully:** your backend fixes `model` and `voice` (cost and brand safety), while the app controls `instructions`, `tools` and `turnDetection` at runtime — so product changes ship without a backend deploy.

### Raw API key (local development only)

```ts
useRealtimeVoice({
  auth: { apiKey: process.env.EXPO_PUBLIC_OPENAI_API_KEY! },
});
```

An `sk-...` key in your app is extractable from any shipped build in minutes. The package warns on every use and refuses a raw key returned from `getToken`. Guard it behind `__DEV__` and never ship it.

---

## Tools

A tool owns its schema **and** its handler. No separate registry, no `switch` on tool names.

```ts
import { defineTool } from "react-native-realtime-voice";
import { z } from "zod";

const logWaterTool = defineTool({
  name: "log_water",
  // Say *when* to call it, not just what it does — this drives selection accuracy.
  description:
    "Log water the user says they drank. Call this when they mention drinking " +
    "water or ask to log hydration. Amount is in millilitres.",
  parameters: z.object({
    amount_ml: z.number().describe("Millilitres, e.g. 250 for a glass"),
  }),
  handler: async ({ amount_ml }) => {
    //                ^? number — inferred from the zod schema
    await api.logWater(amount_ml);
    return { logged: amount_ml };
  },
});
```

zod is optional. Plain JSON Schema works identically:

```ts
defineTool<{ amount_ml: number }>({
  name: "log_water",
  description: "...",
  parameters: {
    type: "object",
    properties: { amount_ml: { type: "number" } },
    required: ["amount_ml"],
  },
  handler: async ({ amount_ml }) => ({ logged: amount_ml }),
});
```

What the registry handles for you:

| Behaviour           | Detail                                                           |
| ------------------- | ---------------------------------------------------------------- |
| Argument validation | zod schemas validate and apply defaults before your handler runs |
| Bad arguments       | Returned to the model as a correctable message, not thrown       |
| Duplicate `call_id` | Ignored (bounded LRU — cannot leak across a long session)        |
| Timeouts            | 10s default, per-tool via `timeoutMs`; reported to the model     |
| Cancellation        | `ctx.signal` aborts when the session ends or the call times out  |
| Late results        | Discarded if the session closed while the handler ran            |
| Parallel calls      | Several calls in one turn get one follow-up reply, not one each  |

Handlers get a context object:

```ts
handler: async (args, { signal, callId, send }) => {
  const res = await fetch(url, { signal }); // aborts on disconnect
  return res.json();
};
```

---

## The hook

```tsx
const voice = useRealtimeVoice({
  auth,
  instructions: () => buildPrompt(reduxState), // evaluated once per connection
  tools: [logWaterTool, getWorkoutTool],
  voice: "alloy",
  turnDetection: {
    type: "server_vad",
    threshold: 0.5,
    silence_duration_ms: 500,
  },
  greeting: true,
  inCallManager: InCallManager,
  logLevel: __DEV__ ? "debug" : "silent",
});
```

Returns:

```ts
{
  // state
  state, isConnected, isConnecting, isReconnecting,
  isUserSpeaking, isAgentSpeaking, isMicEnabled, error,

  // conversation
  transcripts, userTranscript, agentTranscript,
  toolCalls, usage, diagnostics, remoteStream,

  // actions
  connect, disconnect, interrupt, toggleMic, setMicEnabled,
  setSpeakerphone, sendText, refreshInstructions,
  clearTranscripts, clearError,
  session,   // the underlying RealtimeSession
}
```

`instructions` takes a string or a function:

- **A string** is pushed to the live call whenever its value changes.
- **A function** runs once when each connection opens, always using the closure from the latest render, so it never goes stale between calls. Writing it inline is fine: a new function identity on each render does not re-run it. To rebuild the prompt mid-call, for example after the app state it reads has changed, call `voice.refreshInstructions()`.

Changing `instructions`, `tools`, `toolChoice` or `turnDetection` on a **live** session pushes a `session.update` rather than reconnecting, and only when the resulting config actually differs. `model` and `voice` are fixed for a connection's lifetime (an API constraint) and apply on the next connect.

### Conversation history

- **Order.** `transcripts` is in conversation order, by each item's `order` field. The user's transcription often finishes after the agent has started replying, so sorting by arrival time would put the question under its answer.
- **After hang-up.** `disconnect()` keeps the transcripts and tool calls, so you can show or save the call. The next `connect()` starts a fresh conversation and clears them. `clearTranscripts()` clears them at any time.
- **Reconnects.** Each new connection is a fresh server session that remembers nothing. When a dropped call reconnects, the last 20 finished messages are replayed into it so the agent keeps the thread. Set `replayHistory` to change the number, or `false` to turn it off. Only text is replayed, not tool calls or their results.
- **Continuing a call.** `connect({ resume: true })` continues the previous call: its history is kept and replayed, and the greeting is skipped.

User speech is transcribed with `gpt-4o-mini-transcribe` by default. It streams partial text and costs half as much as `whisper-1`. For captions that update while the user is still talking, use `transcription: { model: "gpt-live-transcribe" }`, which costs more. Pass `transcription: false` if you show no text at all.

### Provider

Hoist the config that never varies:

```tsx
<RealtimeVoiceProvider
  auth={{ getToken }}
  inCallManager={InCallManager}
  logLevel={__DEV__ ? "debug" : "silent"}
>
  <App />
</RealtimeVoiceProvider>
```

Screens then declare only what makes them different:

```ts
const voice = useRealtimeVoice({ instructions, tools });
```

---

## UI

Optional, from a separate subpath — import nothing and none of it ships:

```tsx
import {
  VoiceAgentView,
  VoiceOrb,
  MicButton,
  TranscriptView,
} from "react-native-realtime-voice/ui";

<VoiceAgentView
  voice={voice}
  title="Coach"
  transcriptVariant="caption"
  theme={{ accent: "#55B3FE" }}
/>;
```

Built on React Native's own `Animated` and plain `View` glyphs — **no** icon library, animation library, or gradient library. Every piece is exported individually if you want your own layout; the theme is a flat token object (`accent`, `listening`, `speaking`, `danger`, `text`, …) with `darkTheme` and `lightTheme` presets.

---

## Reliability

- **Reconnect** — retryable failures (network drop, expired token, 5xx) reconnect with exponential backoff. Configure via `reconnect: { enabled, maxAttempts, initialDelayMs, maxDelayMs }`; auth failures force a fresh token on retry. A reconnect continues the same call: recent history is replayed into the new server session (see [Conversation history](#conversation-history)), and the greeting is not repeated.
- **Barge-in** — enabled by default through `turn_detection.interrupt_response`. `voice.interrupt()` cancels the response and clears queued audio.
- **Audio routing** — pass `inCallManager` to route to the loudspeaker; omit it and routing is untouched. Supply your own `audioRouter` for full control.
- **Usage** — `voice.usage` accumulates input/output and audio token counts per session.
- **Diagnostics** — `voice.diagnostics` exposes peer/ICE/data-channel state, `callId`, connect latency and reconnect count. Useful in support tickets.

---

## Errors

`voice.error` is a `RealtimeVoiceError` with a `code` you can branch on, rather than a string to match:

```ts
if (voice.error?.code === "mic-permission-denied") openSettings();
```

`no-webrtc-module` · `no-credentials` · `auth-failed` · `mic-permission-denied` · `no-audio-track` · `sdp-exchange-failed` · `connection-failed` · `connection-lost` · `tool-failed` · `tool-timeout` · `server-error` · `aborted`

---

## Without React

The hook is a thin adapter; `RealtimeSession` works standalone:

```ts
const session = new RealtimeSession({ auth, tools, instructions });
session.on("transcript", (item) => console.log(item.role, item.text));
session.on("toolResult", (call) => console.log(call.name, call.result));
await session.connect();
```

Events: `stateChange` · `transcript` · `conversationReset` · `userSpeechStart|Stop` · `agentSpeechStart|Stop` · `toolCall` · `toolResult` · `usage` · `remoteStream` · `diagnostics` · `error` · `raw`.

`raw` emits every server event, including ones the package does not interpret — you are never blocked by our coverage.

---

## Licence

MIT

---

## Releasing

Publishing is automated. CI runs typecheck, build and the test suite on every
push; the publish job compares `package.json`'s version against what is on npm
and publishes only when they differ.

```bash
npm version patch --no-git-tag-version   # 0.1.1 → 0.1.2
git commit -am "fix: ..."
git push
```

CI then publishes to npm, creates the `v0.1.2` tag and opens a GitHub release.
Pushing without a version bump runs the tests and skips publishing, so there is
no failed build for an ordinary commit.

Authentication uses npm **trusted publishing** (OIDC) — there is no token to
store or rotate. Configure it once at npmjs.com → the package → Settings →
Trusted Publisher, pointing at this repository and `ci.yml`.
