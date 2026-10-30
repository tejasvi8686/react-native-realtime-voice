/**
 * Conversation continuity: transcripts that outlive a call, stay in
 * conversation order, and carry over into a fresh server session after a
 * reconnect or an explicit resume.
 */
const PKG = "../lib/commonjs/index.js";
const { RealtimeSession } = require(PKG);
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
    reconnect: { initialDelayMs: 10 },
    ...config,
  });
}

async function connectAndOpen(session, fake, options) {
  await session.connect(options);
  fake.openDataChannel();
  await tick();
}

/** One finished exchange: the user speaks, then the agent answers. */
function exchange(fake, n) {
  fake.emitServer({
    type: "conversation.item.added",
    item: { id: `u${n}`, type: "message", role: "user" },
  });
  fake.emitServer({
    type: "conversation.item.added",
    item: { id: `a${n}`, type: "message", role: "assistant" },
  });
  fake.emitServer({
    type: "response.output_audio_transcript.done",
    item_id: `a${n}`,
    transcript: `answer ${n}`,
  });
  fake.emitServer({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: `u${n}`,
    transcript: `question ${n}`,
  });
}

const replayed = (events) =>
  events.filter(
    (e) => e.type === "conversation.item.create" && e.item?.type === "message",
  );

(async () => {
  console.log("\n== transcripts outlive the call ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake);
    let resets = 0;
    session.on("conversationReset", () => resets++);

    await connectAndOpen(session, fake);
    resets = 0;
    exchange(fake, 1);
    await session.disconnect();
    check("kept after disconnect", session.getTranscripts().length === 2);

    await connectAndOpen(session, fake);
    check("cleared by a fresh connect", session.getTranscripts().length === 0);
    check("conversationReset emitted", resets === 1);

    exchange(fake, 2);
    session.clearTranscripts();
    check("clearTranscripts() clears", session.getTranscripts().length === 0);
    check("and emits conversationReset", resets === 2);
    await session.disconnect();
  }

  console.log("\n== transcripts follow conversation order ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake);
    await connectAndOpen(session, fake);
    // exchange() finishes the agent's text before the user's transcription,
    // which is the order the API often delivers them in.
    exchange(fake, 1);
    exchange(fake, 2);
    const ids = session.getTranscripts().map((t) => t.id);
    check(
      "user before agent despite late transcription",
      ids.join(",") === "u1,a1,u2,a2",
    );
    const orders = session.getTranscripts().map((t) => t.order);
    check(
      "order is strictly increasing",
      orders.every((o, i) => i === 0 || o > orders[i - 1]),
    );

    fake.emitServer({
      type: "response.output_audio_transcript.delta",
      item_id: "a-unannounced",
      delta: "hi",
    });
    check(
      "an item never announced still gets a position",
      session.getTranscripts().at(-1)?.id === "a-unannounced",
    );
    await session.disconnect();
  }

  console.log("\n== reconnect replays recent history ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake, { greeting: true });
    await connectAndOpen(session, fake);
    exchange(fake, 1);
    exchange(fake, 2);
    fake.emitServer({
      type: "response.output_audio_transcript.delta",
      item_id: "a3",
      delta: "half a sent",
    });

    fake.failPeer();
    await tick(60);
    const mark = fake.sent.length;
    fake.openDataChannel();
    await tick();
    const items = replayed(fake.sent.slice(mark));

    check("replays only finished messages", items.length === 4);
    check(
      "in conversation order",
      items.map((e) => e.item.content[0].text).join("|") ===
        "question 1|answer 1|question 2|answer 2",
    );
    check(
      "user text as input_text",
      items[0].item.role === "user" &&
        items[0].item.content[0].type === "input_text",
    );
    check(
      "assistant text as output_text",
      items[1].item.role === "assistant" &&
        items[1].item.content[0].type === "output_text",
    );
    check(
      "replayed before the session.update",
      fake.sent.slice(mark).findIndex((e) => e.type === "session.update") >
        fake.sent.slice(mark).indexOf(items[3]),
    );
    check(
      "local transcripts untouched by the replay",
      session.getTranscripts().length === 5,
    );
    await session.disconnect();
  }

  console.log("\n== replayHistory limits and disables ==");
  for (const [limit, expected] of [
    [1, 1],
    [false, 0],
  ]) {
    const fake = createFakeWebRTC();
    const session = newSession(fake, { replayHistory: limit });
    await connectAndOpen(session, fake);
    exchange(fake, 1);
    fake.failPeer();
    await tick(60);
    const mark = fake.sent.length;
    fake.openDataChannel();
    await tick();
    const items = replayed(fake.sent.slice(mark));
    check(
      `replayHistory: ${limit} → ${expected} item(s)`,
      items.length === expected &&
        (expected === 0 || items[0].item.content[0].text === "answer 1"),
    );
    await session.disconnect();
  }

  console.log("\n== connect({ resume: true }) continues the last call ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake, { greeting: true });
    let resets = 0;
    session.on("conversationReset", () => resets++);

    await connectAndOpen(session, fake);
    resets = 0;
    exchange(fake, 1);
    await session.disconnect();

    const mark = fake.sent.length;
    await connectAndOpen(session, fake, { resume: true });
    const sent = fake.sent.slice(mark);
    check("history kept", session.getTranscripts().length === 2);
    check("no conversationReset", resets === 0);
    check("history replayed", replayed(sent).length === 2);
    check(
      "resumed call does not greet",
      !sent.some((e) => e.type === "response.create"),
    );

    exchange(fake, 2);
    check(
      "new turns land after the resumed history",
      session
        .getTranscripts()
        .map((t) => t.id)
        .join(",") === "u1,a1,u2,a2",
    );
    await session.disconnect();
  }

  console.log("\n== default transcription streams ==");
  {
    const fake = createFakeWebRTC();
    const session = newSession(fake);
    await connectAndOpen(session, fake);
    const update = fake.sent.find((e) => e.type === "session.update");
    check(
      "defaults to gpt-4o-mini-transcribe",
      update?.session?.audio?.input?.transcription?.model ===
        "gpt-4o-mini-transcribe",
    );
    await session.disconnect();
  }

  finish();
})();
