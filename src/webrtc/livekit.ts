/**
 * Adapter for `@livekit/react-native-webrtc`.
 *
 * Importing this module registers it as the package's WebRTC provider, so one
 * side-effect import at app start is all that is needed:
 *
 * ```ts
 * import "realtime-voice/webrtc/livekit";
 * ```
 *
 * This is the only file that references the LiveKit package, so apps using
 * `react-native-webrtc` never resolve it.
 *
 * `require` with a literal path is used instead of `import` because the module
 * is an *optional* peer dependency: Metro still resolves the literal statically
 * (which is exactly what we want here), while TypeScript does not demand the
 * types be installed for consumers who use the other provider.
 */

import { registerWebRTC, type WebRTCModule } from "../core/webrtc";

declare const require: (id: string) => unknown;

const module = require("@livekit/react-native-webrtc") as WebRTCModule;

registerWebRTC(module);

export default module;
