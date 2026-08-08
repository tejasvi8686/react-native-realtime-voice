/**
 * react-native-realtime-voice
 *
 * Voice-to-voice agents for React Native / Expo on the OpenAI Realtime API.
 */

// ---- React ----
export {
  useRealtimeVoice,
  type UseRealtimeVoiceOptions,
  type UseRealtimeVoiceResult,
} from "./react/useRealtimeVoice";
export {
  RealtimeVoiceProvider,
  useRealtimeVoiceDefaults,
  type RealtimeVoiceDefaults,
} from "./react/RealtimeVoiceProvider";

// ---- Session ----
export {
  RealtimeSession,
  type RealtimeVoiceConfig,
  type ReconnectPolicy,
  type SessionEvents,
} from "./core/session";

// ---- Tools ----
export {
  defineTool,
  ToolRegistry,
  type DefineToolConfig,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./core/tools";

// ---- Auth ----
export {
  CredentialProvider,
  isApiKeyAuth,
  mintEphemeralToken,
  type ApiKeyAuthConfig,
  type AuthConfig,
  type EphemeralAuthConfig,
  type EphemeralToken,
  type ResolvedCredential,
} from "./core/auth";

// ---- WebRTC wiring ----
export {
  DEFAULT_ICE_SERVERS,
  DEFAULT_MEDIA_CONSTRAINTS,
  getRegisteredWebRTC,
  registerWebRTC,
  type WebRTCModule,
} from "./core/webrtc";

// ---- Audio routing ----
export {
  createInCallAudioRouter,
  noopAudioRouter,
  type AudioRouter,
  type InCallManagerLike,
} from "./core/audio";

// ---- Errors & logging ----
export {
  isRealtimeVoiceError,
  RealtimeVoiceError,
  type RealtimeErrorCode,
} from "./core/errors";
export { createLogger, type Logger, type LogLevel } from "./core/logger";

// ---- Types ----
export type {
  AudioFormat,
  ConnectionState,
  ConversationRole,
  Diagnostics,
  InputTranscription,
  JSONSchema,
  NoiseReduction,
  RealtimeFunctionTool,
  RealtimeSessionPayload,
  RealtimeVoice,
  SessionAudio,
  SessionAudioInput,
  SessionAudioOutput,
  ToolChoice,
  ToolInvocation,
  TranscriptItem,
  TurnDetection,
  UsageSnapshot,
} from "./core/types";
export type { ClientEvent, ServerEvent } from "./core/events";

// ---- Advanced ----
export { WebRTCTransport, type TransportEvents, type TransportOptions } from "./core/transport";
export { Emitter, type Listener, type Unsubscribe } from "./core/emitter";
export { zodToJSONSchema, type ParsableSchema } from "./core/schema";
