/**
 * Fake WebRTC module and Realtime endpoint for driving a RealtimeSession
 * without a device or network.
 *
 * Unlike the inline fake in session.test.cjs, every peer connection keeps its
 * own listeners, so suites can observe reconnects and assert how many peer
 * connections a scenario actually opened.
 */

class FakeTrack {
  constructor() {
    this.enabled = true;
  }
  stop() {}
}

class FakeStream {
  constructor() {
    this.tracks = [new FakeTrack()];
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

function listenable(target) {
  target.listeners = {};
  target.addEventListener = (name, fn) => {
    (target.listeners[name] ||= []).push(fn);
  };
  target.fire = (name, payload) => {
    (target.listeners[name] || []).forEach((fn) => fn(payload));
  };
  return target;
}

function createFakeWebRTC() {
  /** Every client event sent, in order, across all connections. */
  const sent = [];
  /** Every peer connection ever constructed, oldest first. */
  const pcs = [];

  class FakeDataChannel {
    constructor() {
      listenable(this);
      this.readyState = "connecting";
    }
    send(data) {
      sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = "closed";
    }
  }

  class FakePeerConnection {
    constructor() {
      listenable(this);
      this.connectionState = "new";
      this.iceConnectionState = "new";
      this.localDescription = null;
      this.closed = false;
      pcs.push(this);
    }
    addTrack() {}
    createDataChannel() {
      return (this.dc = new FakeDataChannel());
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\nfake-offer" };
    }
    async setLocalDescription(d) {
      this.localDescription = { sdp: d.sdp };
    }
    async setRemoteDescription() {}
    close() {
      this.closed = true;
      this.connectionState = "closed";
    }
  }

  const module = {
    RTCPeerConnection: FakePeerConnection,
    RTCSessionDescription: function (init) {
      return init;
    },
    mediaDevices: { getUserMedia: async () => new FakeStream() },
  };

  const latest = () => pcs[pcs.length - 1];

  return {
    module,
    sent,
    pcs,
    latest,
    /** Peer connections not yet closed. */
    live: () => pcs.filter((pc) => !pc.closed),
    openDataChannel(pc = latest()) {
      pc.dc.readyState = "open";
      pc.dc.fire("open");
    },
    emitServer(event, pc = latest()) {
      pc.dc.fire("message", { data: JSON.stringify(event) });
    },
    failPeer(pc = latest()) {
      pc.connectionState = "failed";
      pc.fire("connectionstatechange");
    },
  };
}

/** Stub `fetch` so the SDP exchange always succeeds. */
function mockRealtimeFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h === "Location" ? "/v1/realtime/calls/call_fake" : null),
    },
    text: async () => "v=0\r\nfake-answer",
  });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal assertion helper matching the other suites' output format. */
function createChecker() {
  let count = 0;
  const failed = [];
  return {
    check(label, condition) {
      count++;
      if (condition) console.log(`  ok   ${label}`);
      else {
        console.log(`  FAIL ${label}`);
        failed.push(label);
      }
    },
    finish() {
      console.log(`\n${count - failed.length}/${count} passed`);
      if (failed.length) {
        console.log("FAILED:", failed.join(", "));
        process.exit(1);
      }
    },
  };
}

module.exports = { createFakeWebRTC, mockRealtimeFetch, tick, createChecker };
