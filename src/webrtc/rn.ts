/**
 * Adapter for `react-native-webrtc`.
 *
 * ```ts
 * import "@tejasvi8686/realtime-voice/webrtc/rn";
 * ```
 *
 * This is the only file that references `react-native-webrtc`, so apps using
 * the LiveKit fork never resolve it. See `./livekit.ts` for why this uses
 * `require` rather than `import`.
 */

import { registerWebRTC, type WebRTCModule } from "../core/webrtc";

declare const require: (id: string) => unknown;

const module = require("react-native-webrtc") as WebRTCModule;

registerWebRTC(module);

export default module;
