/**
 * useRealtimeVoice under React's development-mode effect re-runs.
 *
 * StrictMode runs every effect's cleanup and setup an extra time on mount, and
 * Fast Refresh does the same on every edit. Both must leave the hook subscribed
 * to a live session, with one connection and the call still up.
 */
const React = require("react");
const TestRenderer = require("react-test-renderer");
const PKG = "../lib/commonjs/index.js";
const { useRealtimeVoice, defineTool } = require(PKG);
const {
  createFakeWebRTC,
  mockRealtimeFetch,
  tick,
  createChecker,
} = require("./helpers/fake-webrtc.cjs");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mockRealtimeFetch();
const { check, finish } = createChecker();
const { act } = React;

const fake = createFakeWebRTC();
let voice = null;
let instructionCalls = 0;

const tool = defineTool({
  name: "ping",
  description: "ping",
  parameters: { type: "object", properties: {} },
  handler: () => ({}),
});

function Probe({ label }) {
  voice = useRealtimeVoice({
    auth: { apiKey: "sk-test" },
    isDevelopment: true,
    logLevel: "silent",
    webrtc: fake.module,
    autoConnect: true,
    // Inline on purpose: a new function and a new array on every render.
    instructions: () => {
      instructionCalls++;
      return `prompt ${label}`;
    },
    tools: [tool],
  });
  return null;
}

const tree = (label) =>
  React.createElement(
    React.StrictMode,
    null,
    React.createElement(Probe, { label }),
  );

(async () => {
  console.log("\n== StrictMode mount ==");
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(tree("a"));
    await tick();
  });
  check("one peer connection despite double effects", fake.pcs.length === 1);

  await act(async () => {
    fake.openDataChannel();
    await tick();
  });
  check("hook reports connected", voice.state === "connected");

  await act(async () => {
    fake.emitServer({
      type: "response.output_audio_transcript.delta",
      item_id: "a1",
      delta: "Hello",
    });
    await tick();
  });
  check(
    "hook still receives session events",
    voice.transcripts[0]?.text === "Hello",
  );
  check("instructions evaluated once on connect", instructionCalls === 1);

  console.log("\n== re-renders with inline props ==");
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      renderer.update(tree("a"));
      await tick(5);
    });
  }
  check("re-renders do not re-run instructions", instructionCalls === 1);
  check(
    "re-renders do not re-send session.update",
    fake.sent.filter((e) => e.type === "session.update").length === 1,
  );

  console.log("\n== refreshInstructions picks up the latest closure ==");
  // Separate acts: React defers work queued inside an act until it exits.
  await act(async () => {
    renderer.update(tree("b"));
  });
  await act(async () => {
    await voice.refreshInstructions();
  });
  const updates = fake.sent.filter((e) => e.type === "session.update");
  check(
    "latest prompt pushed",
    updates[updates.length - 1]?.session?.instructions === "prompt b",
  );

  console.log("\n== unmount ==");
  await act(async () => {
    renderer.unmount();
  });
  await tick();
  check("peer connection closed on unmount", fake.live().length === 0);

  finish();
})();
