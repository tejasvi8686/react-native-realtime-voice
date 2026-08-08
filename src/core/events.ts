/**
 * Realtime server events, narrowed to the set a voice agent actually reacts to.
 *
 * The API emits far more than this; unknown events are passed through untyped
 * via the session's `raw` event so consumers are never blocked by our coverage.
 */

export type ServerEventBase = { type: string; event_id?: string };

export type SessionCreatedEvent = ServerEventBase & {
  type: "session.created";
  session?: { id?: string; model?: string };
};

export type SessionUpdatedEvent = ServerEventBase & { type: "session.updated" };

export type ConversationItemCreatedEvent = ServerEventBase & {
  type: "conversation.item.created";
  item?: {
    id?: string;
    role?: string;
    type?: string;
    content?: { type?: string; text?: string; transcript?: string }[];
  };
};

export type InputTranscriptionDeltaEvent = ServerEventBase & {
  type: "conversation.item.input_audio_transcription.delta";
  item_id?: string;
  delta?: string;
};

export type InputTranscriptionCompletedEvent = ServerEventBase & {
  type: "conversation.item.input_audio_transcription.completed";
  item_id?: string;
  transcript?: string;
};

export type InputTranscriptionFailedEvent = ServerEventBase & {
  type: "conversation.item.input_audio_transcription.failed";
  item_id?: string;
  error?: { message?: string };
};

export type ResponseCreatedEvent = ServerEventBase & {
  type: "response.created";
  response?: { id?: string };
};

export type ResponseAudioTranscriptDeltaEvent = ServerEventBase & {
  type: "response.output_audio_transcript.delta";
  response_id?: string;
  item_id?: string;
  delta?: string;
};

export type ResponseAudioTranscriptDoneEvent = ServerEventBase & {
  type: "response.output_audio_transcript.done";
  response_id?: string;
  item_id?: string;
  transcript?: string;
};

export type ResponseTextDeltaEvent = ServerEventBase & {
  type: "response.output_text.delta";
  item_id?: string;
  delta?: string;
};

export type ResponseDoneEvent = ServerEventBase & {
  type: "response.done";
  response?: {
    id?: string;
    status?: string;
    status_details?: { error?: { message?: string } };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_token_details?: { audio_tokens?: number; text_tokens?: number };
      output_token_details?: { audio_tokens?: number; text_tokens?: number };
    };
  };
};

export type FunctionCallArgumentsDoneEvent = ServerEventBase & {
  type: "response.function_call_arguments.done";
  response_id?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  /** JSON-encoded argument object. May be an empty string for no-arg tools. */
  arguments?: string;
};

export type SpeechStartedEvent = ServerEventBase & {
  type: "input_audio_buffer.speech_started";
  item_id?: string;
};

export type SpeechStoppedEvent = ServerEventBase & {
  type: "input_audio_buffer.speech_stopped";
  item_id?: string;
};

/** Emitted by the WebRTC layer specifically — the model's audio began playing. */
export type OutputAudioStartedEvent = ServerEventBase & {
  type: "output_audio_buffer.started";
  response_id?: string;
};

export type OutputAudioStoppedEvent = ServerEventBase & {
  type: "output_audio_buffer.stopped";
  response_id?: string;
};

export type OutputAudioClearedEvent = ServerEventBase & {
  type: "output_audio_buffer.cleared";
  response_id?: string;
};

export type RateLimitsUpdatedEvent = ServerEventBase & {
  type: "rate_limits.updated";
  rate_limits?: { name?: string; limit?: number; remaining?: number; reset_seconds?: number }[];
};

export type ErrorEvent = ServerEventBase & {
  type: "error";
  error?: { type?: string; code?: string; message?: string; param?: string };
};

export type ServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ConversationItemCreatedEvent
  | InputTranscriptionDeltaEvent
  | InputTranscriptionCompletedEvent
  | InputTranscriptionFailedEvent
  | ResponseCreatedEvent
  | ResponseAudioTranscriptDeltaEvent
  | ResponseAudioTranscriptDoneEvent
  | ResponseTextDeltaEvent
  | ResponseDoneEvent
  | FunctionCallArgumentsDoneEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | OutputAudioStartedEvent
  | OutputAudioStoppedEvent
  | OutputAudioClearedEvent
  | RateLimitsUpdatedEvent
  | ErrorEvent
  | ServerEventBase;

/** Client events we send over the data channel. */
export type ClientEvent =
  | { type: "session.update"; session: Record<string, unknown> }
  | { type: "response.create"; response?: Record<string, unknown> }
  | { type: "response.cancel"; event_id?: string }
  | { type: "output_audio_buffer.clear"; event_id?: string }
  | { type: "input_audio_buffer.clear" }
  | {
      type: "conversation.item.create";
      item: Record<string, unknown>;
      previous_item_id?: string;
    }
  | { type: "conversation.item.truncate"; item_id: string; content_index: number; audio_end_ms: number };
