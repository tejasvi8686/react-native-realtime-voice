/**
 * WebRTC module injection.
 *
 * React Native has no built-in WebRTC, and the two common providers
 * (`react-native-webrtc` and `@livekit/react-native-webrtc`) cannot both be a
 * hard dependency — Metro resolves `require` statically, so a `try/catch`
 * around a missing module still fails at build time.
 *
 * The package therefore never imports either one. You register the module you
 * already have, once, at app start:
 *
 * ```ts
 * import { registerWebRTC } from "@tejasvi8686/realtime-voice";
 * import * as webrtc from "@livekit/react-native-webrtc";
 * registerWebRTC(webrtc);
 * ```
 *
 * Or import one of the prebuilt adapters, which contain the only hard import:
 * `@tejasvi8686/realtime-voice/webrtc/livekit` or `.../webrtc/rn`.
 */

import { RealtimeVoiceError } from "./errors";

/** Structural type covering both providers' public surface. */
export type WebRTCModule = {
  RTCPeerConnection: new (config?: any) => any;
  RTCSessionDescription: new (init: { type: string; sdp: string }) => any;
  mediaDevices: {
    getUserMedia: (constraints: any) => Promise<any>;
  };
  registerGlobals?: () => void;
};

let registered: WebRTCModule | null = null;

/**
 * Register the WebRTC implementation the package should use. Call once, before
 * the first `connect()`. Calling again replaces the previous registration.
 */
export function registerWebRTC(module: WebRTCModule): void {
  if (
    !module ||
    typeof module.RTCPeerConnection !== "function" ||
    typeof module.mediaDevices?.getUserMedia !== "function"
  ) {
    throw new RealtimeVoiceError(
      "no-webrtc-module",
      "registerWebRTC() expects a module exporting RTCPeerConnection, " +
        "RTCSessionDescription and mediaDevices.",
    );
  }
  registered = module;
}

export function getRegisteredWebRTC(): WebRTCModule | null {
  return registered;
}

/** Resolve the module to use, preferring a per-session override. */
export function resolveWebRTC(override?: WebRTCModule): WebRTCModule {
  const module = override ?? registered;
  if (!module) {
    throw new RealtimeVoiceError(
      "no-webrtc-module",
      "No WebRTC module registered. Add this once at app start:\n\n" +
        '  import { registerWebRTC } from "@tejasvi8686/realtime-voice";\n' +
        '  import * as webrtc from "@livekit/react-native-webrtc";\n' +
        "  registerWebRTC(webrtc);\n\n" +
        "Or import the adapter: " +
        'import "@tejasvi8686/realtime-voice/webrtc/livekit";',
    );
  }
  return module;
}

/** ICE configuration. STUN-only is sufficient for the vast majority of networks. */
export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Microphone constraints tuned for speech: 24 kHz mono matches the Realtime
 * API's PCM rate, and the three DSP flags materially reduce false VAD triggers.
 */
export const DEFAULT_MEDIA_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 24000,
    channelCount: 1,
  },
  video: false,
};
