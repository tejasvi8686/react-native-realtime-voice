const PKG = "../lib/commonjs/index.js";
const { RealtimeSession, registerWebRTC } = require(PKG);

let ok = 0;
const bad = [];
const check = (label, condition) => {
  ok++;
  if (condition) {
    console.log("  ok   " + label);
  } else {
    console.log("  FAIL " + label);
    bad.push(label);
  }
};

let dcListeners = {};
class T {
  constructor() {
    this.enabled = true;
  }
  stop() {}
}
class S {
  constructor() {
    this.t = [new T()];
  }
  getAudioTracks() {
    return this.t;
  }
  getTracks() {
    return this.t;
  }
}
class DC {
  constructor() {
    this.readyState = "connecting";
  }
  addEventListener(n, f) {
    (dcListeners[n] ||= []).push(f);
  }
  send() {}
  close() {}
}
class PC {
  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
  }
  addEventListener() {}
  addTrack() {}
  createDataChannel() {
    return (this.dc = new DC());
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\noffer" };
  }
  async setLocalDescription(d) {
    this.localDescription = { sdp: d.sdp };
  }
  async setRemoteDescription() {}
  close() {}
}
registerWebRTC({
  RTCPeerConnection: function () {
    return new PC();
  },
  RTCSessionDescription: function (i) {
    return i;
  },
  mediaDevices: { getUserMedia: async () => new S() },
});

let req = null,
  tokenCalls = 0;
globalThis.fetch = async (url, init) => {
  req = { url, init };
  return {
    ok: true,
    status: 200,
    headers: { get: () => "/v1/realtime/calls/c1" },
    text: async () => "v=0\r\nanswer",
  };
};

(async () => {
  console.log("== ephemeral token path ==");
  const s = new RealtimeSession({
    auth: {
      getToken: async () => {
        tokenCalls++;
        return {
          value: "ek_test_abc",
          expires_at: Math.floor(Date.now() / 1000) + 120,
        };
      },
    },
    logLevel: "silent",
  });
  await s.connect();
  check("getToken called once", tokenCalls === 1);
  check(
    "Content-Type is application/sdp",
    req.init.headers["Content-Type"] === "application/sdp",
  );
  check(
    "Bearer is the ephemeral key",
    req.init.headers.Authorization === "Bearer ek_test_abc",
  );
  check(
    "body is the bare SDP (no multipart)",
    req.init.body === "v=0\r\noffer",
  );
  await s.disconnect();

  console.log("\n== token cache reused inside validity window ==");
  await s.connect();
  check("no second mint needed", tokenCalls === 1);
  await s.disconnect();

  console.log("\n== raw sk- key from getToken is rejected ==");
  const s2 = new RealtimeSession({
    auth: { getToken: async () => ({ value: "sk-live-oops" }) },
    logLevel: "silent",
  });
  let err = null;
  s2.on("error", (e) => (err = e));
  await s2.connect();
  check("error code is auth-failed", err?.code === "auth-failed");
  check("message names client_secrets", err?.message.includes("client secret"));
  check("state is failed", s2.getState() === "failed");

  console.log("\n== registerWebRTC rejects an incomplete module ==");
  // Behavioural, rather than grepping the source for an error string. Safe to
  // run after a valid registration: registerWebRTC validates before assigning,
  // so a rejected module leaves the working one in place.
  const { registerWebRTC: reg, getRegisteredWebRTC } = require(PKG);
  const before = getRegisteredWebRTC();
  let regErr = null;
  try {
    reg({ mediaDevices: {} });
  } catch (e) {
    regErr = e;
  }
  check("throws on a module missing RTCPeerConnection", regErr !== null);
  check("error code is no-webrtc-module", regErr?.code === "no-webrtc-module");
  check(
    "message tells you what to do",
    typeof regErr?.message === "string" &&
      regErr.message.includes("registerWebRTC"),
  );
  check(
    "a rejected module does not clobber the registered one",
    getRegisteredWebRTC() === before,
  );

  console.log(`\n${ok - bad.length}/${ok} passed`);
  if (bad.length) process.exit(1);
})();
