/**
 * End-to-end smoke test of RealtimeSession against a fake WebRTC module.
 * Exercises: connect -> session.update -> transcripts -> tool call -> output.
 */
const { z } = require("zod");
const PKG = "../lib/commonjs/index.js";
const { RealtimeSession, defineTool, registerWebRTC } = require(PKG);

let assertions = 0;
const fail = [];
function check(label, cond) {
  assertions++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    fail.push(label);
  }
}

// ---- fake WebRTC -----------------------------------------------------------
const sent = [];
let dcListeners = {};
let pcListeners = {};

class FakeTrack {
  constructor() { this.enabled = true; }
  stop() {}
}
class FakeStream {
  constructor() { this.tracks = [new FakeTrack()]; }
  getAudioTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}
class FakeDataChannel {
  constructor() { this.readyState = "connecting"; }
  addEventListener(n, fn) { (dcListeners[n] ||= []).push(fn); }
  send(data) { sent.push(JSON.parse(data)); }
  close() { this.readyState = "closed"; }
}
class FakePeerConnection {
  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.localDescription = null;
  }
  addEventListener(n, fn) { (pcListeners[n] ||= []).push(fn); }
  addTrack() {}
  createDataChannel() { return (this.dc = new FakeDataChannel()); }
  async createOffer() { return { type: "offer", sdp: "v=0\r\nfake-offer" }; }
  async setLocalDescription(d) { this.localDescription = { sdp: d.sdp }; }
  async setRemoteDescription() { this.remoteSet = true; }
  close() { this.connectionState = "closed"; }
}

let pcInstance = null;
registerWebRTC({
  RTCPeerConnection: function (cfg) { return (pcInstance = new FakePeerConnection(cfg)); },
  RTCSessionDescription: function (init) { return init; },
  mediaDevices: { getUserMedia: async () => new FakeStream() },
});

// ---- fake OpenAI endpoint --------------------------------------------------
let capturedRequest = null;
globalThis.fetch = async (url, init) => {
  capturedRequest = { url, init };
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === "Location" ? "/v1/realtime/calls/call_abc123" : null) },
    text: async () => "v=0\r\nfake-answer",
  };
};

function emitServer(event) {
  (dcListeners.message || []).forEach((fn) => fn({ data: JSON.stringify(event) }));
}

// ---- the test --------------------------------------------------------------
(async () => {
  let handlerRanWith = null;

  const logWater = defineTool({
    name: "log_water",
    description: "Log water intake in millilitres.",
    parameters: z.object({ amount_ml: z.number() }),
    handler: async (args) => {
      handlerRanWith = args;
      return { logged: args.amount_ml };
    },
  });

  const session = new RealtimeSession({
    auth: { apiKey: "sk-test-key" },
    isDevelopment: true,
    logLevel: "silent",
    instructions: () => "You are a test coach.",
    tools: [logWater],
    voice: "alloy",
    turnDetection: { type: "server_vad", threshold: 0.6 },
    greeting: true,
  });

  const states = [];
  const transcripts = [];
  const toolResults = [];
  session.on("stateChange", (s) => states.push(s));
  session.on("transcript", (t) => transcripts.push(t));
  session.on("toolResult", (r) => toolResults.push(r));

  console.log("\n== connect ==");
  await session.connect();

  check("posted to /v1/realtime/calls", capturedRequest.url.includes("/v1/realtime/calls"));
  check("raw key uses multipart", capturedRequest.init.headers["Content-Type"].startsWith("multipart/form-data"));
  check("multipart carries session config", capturedRequest.init.body.includes('"voice":"alloy"'));
  check("multipart carries turn_detection threshold", capturedRequest.init.body.includes('"threshold":0.6'));
  check("multipart carries tool schema", capturedRequest.init.body.includes('"log_water"'));
  check("callId captured from Location", session.getDiagnostics().callId === "call_abc123");

  console.log("\n== data channel opens ==");
  pcInstance.dc.readyState = "open";
  (dcListeners.open || []).forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 20));

  check("state reached connected", session.getState() === "connected");
  const update = sent.find((e) => e.type === "session.update");
  check("sent session.update", !!update);
  check("session.update has instructions", update?.session?.instructions === "You are a test coach.");
  check("session.update has tools", update?.session?.tools?.[0]?.name === "log_water");
  check("session.update has turn_detection", update?.session?.audio?.input?.turn_detection?.threshold === 0.6);
  check("greeting requested", sent.some((e) => e.type === "response.create" && e.response?.instructions));

  console.log("\n== transcripts ==");
  emitServer({ type: "input_audio_buffer.speech_started" });
  check("user speaking flag set", session.isUserSpeaking() === true);
  emitServer({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "I drank " });
  emitServer({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "some water" });
  emitServer({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "I drank some water" });
  const userItem = session.getTranscripts().find((t) => t.id === "u1");
  check("user transcript accumulated + finalised", userItem?.text === "I drank some water" && userItem.isFinal);

  emitServer({ type: "response.created" });
  check("agent speaking flag set", session.isAgentSpeaking() === true);
  emitServer({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Nice, " });
  emitServer({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "logging it." });
  check("agent transcript streams", session.getTranscripts().find((t) => t.id === "a1")?.text === "Nice, logging it.");

  console.log("\n== tool call ==");
  const before = sent.length;
  emitServer({
    type: "response.function_call_arguments.done",
    call_id: "call_1",
    name: "log_water",
    arguments: '{"amount_ml":250}',
  });
  await new Promise((r) => setTimeout(r, 50));

  check("handler ran with parsed args", handlerRanWith?.amount_ml === 250);
  const output = sent.slice(before).find((e) => e.item?.type === "function_call_output");
  check("sent function_call_output", !!output);
  check("output carries call_id", output?.item?.call_id === "call_1");
  check("output carries result", JSON.parse(output?.item?.output ?? "{}").logged === 250);
  check("followed by response.create", sent.slice(before).some((e) => e.type === "response.create" && !e.response));
  check("emitted toolResult succeeded", toolResults[0]?.status === "succeeded");

  console.log("\n== duplicate call_id is ignored ==");
  const beforeDup = sent.length;
  handlerRanWith = null;
  emitServer({
    type: "response.function_call_arguments.done",
    call_id: "call_1",
    name: "log_water",
    arguments: '{"amount_ml":999}',
  });
  await new Promise((r) => setTimeout(r, 30));
  check("duplicate did not re-run handler", handlerRanWith === null);
  check("duplicate sent nothing", sent.length === beforeDup);

  console.log("\n== bad arguments are reported, not thrown ==");
  emitServer({
    type: "response.function_call_arguments.done",
    call_id: "call_2",
    name: "log_water",
    arguments: '{"amount_ml":"lots"}',
  });
  await new Promise((r) => setTimeout(r, 30));
  const badOut = sent.reverse().find((e) => e.item?.call_id === "call_2");
  sent.reverse();
  check("invalid args returned to model", JSON.parse(badOut?.item?.output ?? "{}").error?.includes("schema"));
  check("toolResult marked failed", toolResults.find((r) => r.callId === "call_2")?.status === "failed");

  console.log("\n== usage accounting ==");
  emitServer({
    type: "response.done",
    response: { usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140, output_token_details: { audio_tokens: 30 } } },
  });
  check("usage accumulated", session.getUsage().totalTokens === 140 && session.getUsage().outputAudioTokens === 30);
  check("agent speaking cleared", session.isAgentSpeaking() === false);

  console.log("\n== interrupt ==");
  const beforeInt = sent.length;
  session.interrupt();
  check("interrupt cancels + clears audio",
    sent.slice(beforeInt).some((e) => e.type === "response.cancel") &&
    sent.slice(beforeInt).some((e) => e.type === "output_audio_buffer.clear"));

  console.log("\n== mic + disconnect ==");
  session.setMicEnabled(false);
  check("mic track disabled", pcInstance.dc && session.isMicEnabled() === false);
  await session.disconnect();
  check("state returned to idle", session.getState() === "idle");
  check("transcripts cleared", session.getTranscripts().length === 0);

  console.log(`\n${assertions - fail.length}/${assertions} passed`);
  if (fail.length) {
    console.log("FAILED:", fail.join(", "));
    process.exit(1);
  }
})();
