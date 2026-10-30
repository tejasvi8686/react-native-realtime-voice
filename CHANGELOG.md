# Changelog

All notable changes to this package. Versions follow [semver](https://semver.org/).

## [Unreleased]

### Changed

- **Transcripts now outlive the call.** `disconnect()` no longer clears
  transcripts or the hook's tool calls; the next fresh `connect()` does. If you
  relied on a hang-up clearing the screen, call `clearTranscripts()` after
  `disconnect()`.
- `clearTranscripts()` on the hook now clears the session's copy too, and the
  tool calls, instead of only the hook's transcript list.
- Transcripts are ordered by their position in the conversation, not by when
  their text first arrived. Previously the user's turn often appeared below
  the agent's reply, because input transcription completes asynchronously.
- The default input transcription model is now `gpt-4o-mini-transcribe`
  instead of `whisper-1`. It streams partial text, which `whisper-1` does not,
  and costs half as much per minute. Pass `transcription` to choose another.
- The hook applies transcript updates once per animation frame instead of once
  per token, cutting re-renders during speech. `onTranscript` still fires for
  every event.

### Added

- History replay on reconnect. A reconnect lands on a new server session, so
  the agent used to forget the call. The last 20 finished messages are now
  replayed into it; `replayHistory` changes the limit or disables it.
- `connect({ resume: true })` continues the previous call's conversation
  without the greeting.
- `order` on `TranscriptItem`, a `conversationReset` session event, and
  `session.clearTranscripts()`.

### Fixed

- `useRealtimeVoice` stopped receiving session events after a StrictMode
  mount or any Fast Refresh. The unmount cleanup called `session.dispose()`
  without awaiting it, and when React re-ran the effects the late
  `removeAllListeners()` wiped the subscriptions that had just been re-added.
  Teardown is now deferred one tick and cancelled by the re-run, so a hot
  reload no longer drops a live call either.
- When the model called several tools in one response, the session sent one
  `response.create` per tool, each before the response had finished. The API
  rejects a second request while a response is active, or the agent answered
  twice. Outputs are still sent as each handler finishes. A single follow-up is
  requested after `response.done`, and none if that response was cancelled by
  barge-in.
- An `instructions` function ran on every re-render during a live call,
  because inline `tools` re-triggered a config push. It now runs once per
  connection, using the latest render's closure. A string value is still
  pushed whenever it changes.
- Calling `connect()` while a connection was authenticating, or calling
  `disconnect()` then `connect()` in quick succession, could open two peer
  connections. Superseded attempts now abandon themselves.
- The agent greeted the user again after every automatic reconnect.
- A tool call that timed out kept running with no way to notice. Its
  `ctx.signal` now aborts on timeout. The docs no longer claim `interrupt()`
  cancels tools; it deliberately does not.

### Added

- `refreshInstructions()` on the hook and on `RealtimeSession`, which re-runs
  the `instructions` function mid-call and pushes the result if it changed.

## [0.1.5] — 2026-08-10

### Added

- Prettier, ESLint and `.editorconfig`, wired into CI. `eslint-plugin-react-hooks`
  is included specifically because it catches dependency-array mistakes — the
  class of bug fixed in 0.1.1.
- This changelog.

### Removed

- An app-specific migration guide that documented moving one private
  application onto this package. It did not belong in the library's repository.

## [0.1.4] — 2026-08-08

### Fixed

- `InCallManagerLike` declared `start` as taking a required `{ media: string }`.
  The real `react-native-incall-manager` takes an optional setup object whose
  `media` is the literal union `"video" | "audio"`, so passing the actual module
  to the `inCallManager` option failed to type-check under
  `strictFunctionTypes` — the default in any Expo app. `start` and `stop` now
  mirror the module's declared signatures.

## [0.1.3] — 2026-08-08

No functional change. Released to verify the automated publish pipeline end to
end: CI now authenticates to npm over OIDC trusted publishing, tags the commit
and opens a GitHub release with no manual step and no stored token.

## [0.1.2] — 2026-08-08

### Fixed

- Emitted proper dual CommonJS/ESM output. The `exports` map previously routed
  every condition to the ESM build, which was compiled with extensionless
  relative specifiers that Node's resolver rejects — so `require()` and
  `import` of the package both failed with `ERR_MODULE_NOT_FOUND`. React Native
  was unaffected, as Metro resolves the `react-native` condition to `src/`, so
  this only surfaced for Node consumers of `mintEphemeralToken`.

### Added

- `prepare` script, so installing straight from GitHub builds `lib/` rather
  than yielding a package whose `main` points at files that do not exist.
- `examples/token-endpoint/` ships in the published tarball; the README linked
  to it.

## [0.1.1] — 2026-08-08

### Fixed

- `RealtimeVoiceProvider` derived its `useMemo` dependency list from
  `Object.values` over its props. Spreading a prop conditionally changes that
  list's length between renders, which React rejects outright. Each key is now
  destructured so the list has a fixed size.
- `RealtimeSession` pushed a `session.update` on every `updateConfig` call.
  Passing `tools` and `instructions` as inline literals — as the README's own
  example does — gives them a fresh identity on each render, so a re-render sent
  an identical update across the data channel every time. The resolved payload
  is now compared against the last one sent and skipped when unchanged, with the
  cache cleared on every new connection so a fresh server session still
  receives its config.

### Added

- `expo` as an optional peer dependency; the config plugin requires
  `expo/config-plugins` at prebuild time.

## [0.1.0] — 2026-08-08

Initial release.

- `RealtimeSession`: framework-agnostic orchestrator over the OpenAI Realtime
  API on WebRTC — credentials, transport, tool execution, transcripts, reconnect
  with exponential backoff, barge-in, usage accounting and typed error codes.
- `useRealtimeVoice`: React binding that owns one session for the component's
  lifetime and pushes config changes through without dropping a live call.
- `defineTool`: schema and handler in one place, with argument types inferred
  from a zod schema. zod is optional — plain JSON Schema works identically, and
  the conversion is done without depending on zod.
- Ephemeral client secrets as the default auth path; a raw API key is a
  development escape hatch that warns on use and is refused if returned from
  `getToken`.
- Optional UI kit on the `/ui` subpath, built on React Native's own primitives
  so it adds no peer dependencies.
- Expo config plugin for the microphone and Android audio permissions.
- Zero runtime dependencies.

[unreleased]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tejasvi8686/react-native-realtime-voice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tejasvi8686/react-native-realtime-voice/releases/tag/v0.1.0
