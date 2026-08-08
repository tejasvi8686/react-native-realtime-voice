/**
 * Typed errors so consumers can branch on failure cause instead of
 * string-matching messages.
 */

export type RealtimeErrorCode =
  | "no-webrtc-module"
  | "no-credentials"
  | "auth-failed"
  | "mic-permission-denied"
  | "no-audio-track"
  | "sdp-exchange-failed"
  | "connection-failed"
  | "connection-lost"
  | "tool-failed"
  | "tool-timeout"
  | "server-error"
  | "aborted";

export class RealtimeVoiceError extends Error {
  readonly code: RealtimeErrorCode;
  readonly cause?: unknown;
  /** True when retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    code: RealtimeErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "RealtimeVoiceError";
    this.code = code;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
  }
}

export function isRealtimeVoiceError(e: unknown): e is RealtimeVoiceError {
  return e instanceof RealtimeVoiceError;
}

/** Normalise anything thrown into a RealtimeVoiceError. */
export function toRealtimeError(
  e: unknown,
  fallbackCode: RealtimeErrorCode = "connection-failed",
): RealtimeVoiceError {
  if (isRealtimeVoiceError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new RealtimeVoiceError(fallbackCode, message, { cause: e });
}
