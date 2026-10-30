/**
 * Regression tests for session-level bugs. Each scenario gets its own fake
 * WebRTC module, passed per session, so scenarios cannot see each other's peer
 * connections or client events.
 */
const PKG = "../lib/commonjs/index.js";
const { RealtimeSession, defineTool } = require(PKG);
const {
  createFakeWebRTC,
  mockRealtimeFetch,
  tick,
  createChecker,
} = require("./helpers/fake-webrtc.cjs");

mockRealtimeFetch();
const { check, finish } = createChecker();

function newSession(fake, config = {}) {
  return new RealtimeSession({
    auth: { apiKey: "sk-test" },
    isDevelopment: true,
    logLevel: "silent",
    webrtc: fake.module,
    ...config,
  });
}

async function connectAndOpen(session, fake) {
  await session.connect();
  fake.openDataChannel();
  await tick();
}

const noArgs = { type: "object", properties: {} };
const responseCreates = (sent) =>
  sent.filter((e) => e.type === "response.create");

(async () => {
  console.log("\n== parallel tool calls share one follow-up response ==");
  {
    const fake = createFakeWebRTC();
    const tool = (name) =>
      defineTool({
        name,
        description: name,
        parameters: noArgs,
        handler: async () => ({ ok: name }),
      });
    const session = newSession(fake, { tools: [tool("a"), tool("b")] });
    await connectAndOpen(session, fake);
    fake.sent.length = 0;

    fake.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "resp_1",
      call_id: "call_a",
      name: "a",
      arguments: "{}",
    });
    fake.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "resp_1",
      call_id: "call_b",
      name: "b",
      arguments: "{}",
    });
    await tick();

    const outputs = fake.sent.filter(
      (e) => e.item?.type === "function_call_output",
    );
    check("both tool outputs sent", outputs.length === 2);
    check(
      "no response.create before response.done",
      responseCreates(fake.sent).length === 0,
    );

    fake.emitServer({
      type: "response.done",
      response: { id: "resp_1", status: "completed" },
    });
    await tick();
    check(
      "exactly one response.create after response.done",
      responseCreates(fake.sent).length === 1,
    );
    await session.disconnect();
  }

  console.log("\n== cancelled tool response asks for no follow-up ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake, {
      tools: [
        defineTool({
          name: "a",
          description: "a",
          parameters: noArgs,
          handler: () => ({}),
        }),
      ],
    });
    await connectAndOpen(session, fake);
    fake.sent.length = 0;
    fake.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "resp_2",
      call_id: "call_c",
      name: "a",
      arguments: "{}",
    });
    fake.emitServer({
      type: "response.done",
      response: { id: "resp_2", status: "cancelled" },
    });
    await tick();
    check(
      "output still recorded",
      fake.sent.some((e) => e.item?.call_id === "call_c"),
    );
    check(
      "no response.create for a barged-in response",
      responseCreates(fake.sent).length === 0,
    );
    await session.disconnect();
  }

  console.log("\n== connect → disconnect → connect opens one connection ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake);
    const states = [];
    session.on("stateChange", (s) => states.push(s));

    const first = session.connect();
    void session.disconnect();
    const second = session.connect();
    await Promise.all([first, second]);
    await tick();

    check("one live peer connection", fake.live().length === 1);
    check("no reconnect scheduled", !states.includes("reconnecting"));
    check("no failure reported", !states.includes("failed"));
    fake.openDataChannel();
    await tick();
    check("surviving attempt connects", session.getState() === "connected");
    await session.disconnect();
  }

  console.log("\n== double connect while authenticating ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake);
    await Promise.all([session.connect(), session.connect()]);
    await tick();
    check("second connect() ignored", fake.pcs.length === 1);
    await session.disconnect();
  }

  console.log("\n== instructions run once per connection ==");
  {
    const fake = createFakeWebRTC();
    let calls = 0;
    const tool = defineTool({
      name: "a",
      description: "a",
      parameters: noArgs,
      handler: () => ({}),
    });
    const session = newSession(fake, {
      tools: [tool],
      instructions: () => {
        calls++;
        return "prompt";
      },
    });
    await connectAndOpen(session, fake);
    check("evaluated once on connect", calls === 1);

    for (let i = 0; i < 5; i++) session.updateConfig({ tools: [tool] });
    await tick();
    check("tool updates do not re-run instructions", calls === 1);

    session.updateConfig({ turnDetection: { type: "semantic_vad" } });
    await tick();
    check("other config updates do not re-run instructions", calls === 1);
    check(
      "turn detection change still pushed",
      fake.sent.filter((e) => e.type === "session.update").length === 2,
    );

    await session.refreshInstructions();
    check("refreshInstructions() re-runs it", calls === 2);
    await session.disconnect();
  }

  console.log("\n== reconnect does not greet again ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake, {
      greeting: true,
      reconnect: { initialDelayMs: 10 },
    });
    const greetings = () =>
      fake.sent.filter(
        (e) => e.type === "response.create" && e.response?.instructions,
      ).length;

    await connectAndOpen(session, fake);
    check("greets on first connect", greetings() === 1);

    fake.failPeer();
    await tick(60);
    check("reconnected on a new peer connection", fake.pcs.length === 2);
    fake.openDataChannel();
    await tick();
    check("reconnect is connected", session.getState() === "connected");
    check("no second greeting", greetings() === 1);
    check(
      "config re-sent to the fresh server session",
      fake.sent.filter((e) => e.type === "session.update").length === 2,
    );

    await session.disconnect();
    fake.sent.length = 0;
    await connectAndOpen(session, fake);
    check("a new call greets again", greetings() === 1);
    await session.disconnect();
  }

  console.log("\n== timed-out tool sees its signal abort ==");
  {
    const fake = createFakeWebRTC();
    let seenSignal = null;
    const session = newSession(fake, {
      tools: [
        defineTool({
          name: "slow",
          description: "slow",
          parameters: noArgs,
          timeoutMs: 20,
          handler: (_args, { signal }) => {
            seenSignal = signal;
            return new Promise(() => {});
          },
        }),
      ],
    });
    await connectAndOpen(session, fake);
    fake.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "resp_3",
      call_id: "call_slow",
      name: "slow",
      arguments: "{}",
    });
    await tick(60);
    check("handler signal aborted on timeout", seenSignal?.aborted === true);
    const output = fake.sent.find((e) => e.item?.call_id === "call_slow");
    check(
      "timeout reported to the model",
      JSON.parse(output?.item?.output ?? "{}").error?.includes("20ms"),
    );
    await session.disconnect();
  }

  finish();
})();
