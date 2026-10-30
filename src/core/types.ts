/**
 * Typed model of the OpenAI Realtime GA session object.
 *
 * Everything the API accepts is represented here so that a value set by a
 * consumer is either transmitted or rejected by the type checker — never
 * silently dropped.
 */

/** Voices supported by the Realtime API, or a custom voice reference. */
export type RealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse"
  | "marin"
  | "cedar"
  | { id: string };

export type AudioFormat =
  | { type: "audio/pcm"; rate?: 24000 | 16000 | 8000 }
  | { type: "audio/pcmu" }
  | { type: "audio/pcma" };

export type TranscriptionModel =
  | "whisper-1"
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe"
  | "gpt-transcribe"
  | "gpt-live-transcribe"
  | (string & {});

export type InputTranscription = {
  model: TranscriptionModel;
  /** ISO-639-1 code. Constrains the transcriber and improves accuracy. */
  language?: string;
  languages?: string[];
  prompt?: string;
  delay?: "minimal" | "low" | "medium" | "high" | "xhigh";
  keywords?: string[];
};

export type NoiseReduction = { type: "near_field" | "far_field" };

/**
 * Server-side voice activity detection.
 *
 * `server_vad` thresholds raw audio energy; `semantic_vad` uses the model to
 * decide whether the user has finished a thought, which handles mid-sentence
 * pauses far better at the cost of slightly higher latency.
 */
export type TurnDetection =
  | {
      type: "server_vad";
      /** 0.0–1.0, default 0.5. Higher = less sensitive to quiet speech. */
      threshold?: number;
      /** ms of audio kept before detected speech. Default 300. */
      prefix_padding_ms?: number;
      /** ms of silence that ends a turn. Default 500. */
      silence_duration_ms?: number;
      /** Auto-request a response when the turn ends. Default true. */
      create_response?: boolean;
      /** Let user speech cut off in-progress audio (barge-in). Default true. */
      interrupt_response?: boolean;
      idle_timeout_ms?: number;
    }
  | {
      type: "semantic_vad";
      eagerness?: "low" | "medium" | "high" | "auto";
      create_response?: boolean;
      interrupt_response?: boolean;
    }
  | null;

export type SessionAudioInput = {
  format?: AudioFormat;
  transcription?: InputTranscription;
  noise_reduction?: NoiseReduction;
  turn_detection?: TurnDetection;
};

export type SessionAudioOutput = {
  format?: AudioFormat;
  voice?: RealtimeVoice;
  /** 0.25–1.5, default 1.0. */
  speed?: number;
};

export type SessionAudio = {
  input?: SessionAudioInput;
  output?: SessionAudioOutput;
};

/** A function tool exactly as the Realtime API expects it on the wire. */
export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema;
};

export type ToolChoice =
  "none" | "auto" | "required" | { type: "function"; name: string };

export type Truncation =
  | "auto"
  | "disabled"
  | {
      type: "retention_ratio";
      retention_ratio: number;
      token_limits?: { post_instructions?: number };
    };

export type Tracing =
  | "auto"
  | null
  | {
      workflow_name?: string;
      group_id?: string;
      metadata?: Record<string, unknown>;
    };

/**
 * The wire-format session object. Consumers do not build this by hand —
 * {@link RealtimeVoiceConfig} is flattened into it by `buildSessionPayload`.
 */
export type RealtimeSessionPayload = {
  type: "realtime";
  model?: string;
  instructions?: string;
  output_modalities?: ("text" | "audio")[];
  audio?: SessionAudio;
  tools?: RealtimeFunctionTool[];
  tool_choice?: ToolChoice;
  max_output_tokens?: number | "inf";
  truncation?: Truncation;
  tracing?: Tracing;
};

/** Minimal JSON Schema shape used for tool parameters. */
export type JSONSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: unknown;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
};

/** Lifecycle of a voice session, as observed by the consumer. */
export type ConnectionState =
  | "idle"
  | "requesting-permission"
  | "authenticating"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

/** Who is currently holding the floor. */
export type ConversationRole = "user" | "assistant";

export type TranscriptItem = {
  id: string;
  role: ConversationRole;
  /** Text captured so far. Grows while `isFinal` is false. */
  text: string;
  isFinal: boolean;
  /** Epoch ms when the item was first observed. */
  createdAt: number;
  /**
   * Position in the conversation. Sort by this, not `createdAt`: the user's
   * transcription often finishes after the agent has started replying.
   */
  order: number;
};

export type ToolInvocation = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type UsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
};

export type Diagnostics = {
  peerConnectionState: string;
  iceConnectionState: string;
  dataChannelState: string;
  /** Populated once the SDP exchange completes. Useful for support tickets. */
  callId: string | null;
  /** ms between `connect()` and the data channel opening. */
  connectLatencyMs: number | null;
  reconnectAttempts: number;
};
