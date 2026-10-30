/**
 * React binding for {@link RealtimeSession}.
 *
 * The hook owns exactly one session for the component's lifetime. Config is
 * read through a ref so that changing `instructions` or `tools` does not tear
 * down a live call — a re-render mid-conversation must never drop the line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RealtimeVoiceError } from "../core/errors";
import { RealtimeSession, type RealtimeVoiceConfig } from "../core/session";
import type {
  ConnectionState,
  Diagnostics,
  ToolInvocation,
  TranscriptItem,
  UsageSnapshot,
} from "../core/types";
import {
  useRealtimeVoiceDefaults,
  type RealtimeVoiceDefaults,
} from "./RealtimeVoiceProvider";

/**
 * `auth` may be omitted when a {@link RealtimeVoiceProvider} supplies it.
 * The session constructor still requires one, so a missing `auth` throws at
 * connect time with a message naming both ways to provide it.
 */
export type UseRealtimeVoiceOptions = Omit<RealtimeVoiceConfig, "auth"> & {
  auth?: RealtimeVoiceConfig["auth"];
  /** Connect as soon as the component mounts. Default false. */
  autoConnect?: boolean;
  onError?: (error: RealtimeVoiceError) => void;
  onTranscript?: (item: TranscriptItem) => void;
  onToolCall?: (invocation: ToolInvocation) => void;
  onToolResult?: (invocation: ToolInvocation) => void;
  onStateChange?: (state: ConnectionState) => void;
};

export type UseRealtimeVoiceResult = {
  // state
  state: ConnectionState;
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  /** True while the user is talking (per server VAD). */
  isUserSpeaking: boolean;
  /** True while the agent's audio is playing. */
  isAgentSpeaking: boolean;
  isMicEnabled: boolean;
  error: RealtimeVoiceError | null;

  // conversation
  transcripts: TranscriptItem[];
  /** Newest user text, live-updating. */
  userTranscript: string;
  /** Newest agent text, live-updating. */
  agentTranscript: string;
  toolCalls: ToolInvocation[];
  usage: UsageSnapshot;
  diagnostics: Diagnostics;
  /** Remote MediaStream, for visualisers. Audio plays without touching this. */
  remoteStream: unknown | null;

  // actions
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  interrupt: () => void;
  toggleMic: () => void;
  setMicEnabled: (enabled: boolean) => void;
  setSpeakerphone: (enabled: boolean) => void;
  sendText: (text: string) => void;
  /**
   * Re-run an `instructions` function mid-call and push the result if it
   * changed. Otherwise a function runs once per connection.
   */
  refreshInstructions: () => Promise<void>;
  clearTranscripts: () => void;
  clearError: () => void;
  /** Escape hatch for advanced use. */
  session: RealtimeSession;
};

export function useRealtimeVoice(
  options: UseRealtimeVoiceOptions,
): UseRealtimeVoiceResult {
  const defaults = useRealtimeVoiceDefaults();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Created once. Config changes are pushed in, never rebuilt around.
  const [session] = useState(
    () =>
      new RealtimeSession({
        ...mergeConfig(defaults, options),
        // Stable for the session's lifetime but always reads the latest prop,
        // so an inline function — new on every render — neither re-runs on
        // each render nor goes stale between calls.
        instructions: () => {
          const { instructions } = optionsRef.current;
          return typeof instructions === "function"
            ? instructions()
            : (instructions ?? "");
        },
      }),
  );

  const [state, setState] = useState<ConnectionState>("idle");
  const [isUserSpeaking, setUserSpeaking] = useState(false);
  const [isAgentSpeaking, setAgentSpeaking] = useState(false);
  const [isMicEnabled, setMicEnabledState] = useState(true);
  const [error, setError] = useState<RealtimeVoiceError | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolInvocation[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot>(() => session.getUsage());
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(() =>
    session.getDiagnostics(),
  );
  const [remoteStream, setRemoteStream] = useState<unknown | null>(null);

  // Subscribe once. Handlers read from the ref so they never go stale.
  useEffect(() => {
    const offs = [
      session.on("stateChange", (next) => {
        setState(next);
        if (next === "connected") setError(null);
        optionsRef.current.onStateChange?.(next);
      }),
      session.on("userSpeechStart", () => setUserSpeaking(true)),
      session.on("userSpeechStop", () => setUserSpeaking(false)),
      session.on("agentSpeechStart", () => setAgentSpeaking(true)),
      session.on("agentSpeechStop", () => setAgentSpeaking(false)),
      session.on("transcript", (item) => {
        setTranscripts((prev) => upsertById(prev, item));
        optionsRef.current.onTranscript?.(item);
      }),
      session.on("toolCall", (invocation) => {
        setToolCalls((prev) => upsertByCallId(prev, invocation));
        optionsRef.current.onToolCall?.(invocation);
      }),
      session.on("toolResult", (invocation) => {
        setToolCalls((prev) => upsertByCallId(prev, invocation));
        optionsRef.current.onToolResult?.(invocation);
      }),
      session.on("usage", setUsage),
      session.on("diagnostics", setDiagnostics),
      session.on("remoteStream", (stream) => setRemoteStream(stream)),
      session.on("error", (e) => {
        setError(e);
        optionsRef.current.onError?.(e);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [session]);

  // Tear down on unmount. Deferred one tick because StrictMode and Fast Refresh
  // run this cleanup and then the setup again on the same component: the
  // re-run cancels the pending teardown instead of dropping a live call.
  const teardownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (teardownTimer.current) {
      clearTimeout(teardownTimer.current);
      teardownTimer.current = null;
    }
    return () => {
      teardownTimer.current = setTimeout(() => {
        teardownTimer.current = null;
        void session.dispose();
      }, 0);
    };
  }, [session]);

  // Push live-updatable config through without recreating the session.
  const {
    instructions,
    tools,
    toolChoice,
    turnDetection,
    transcription,
    maxOutputTokens,
    greeting,
  } = options;
  useEffect(() => {
    session.updateConfig({
      tools,
      toolChoice,
      turnDetection,
      transcription,
      maxOutputTokens,
      greeting,
    });
  }, [
    session,
    tools,
    toolChoice,
    turnDetection,
    transcription,
    maxOutputTokens,
    greeting,
  ]);

  // A string prompt is pushed as soon as it changes. A function's identity
  // changes on every render when written inline, so it says nothing; it is
  // read at connect time and on refreshInstructions() instead.
  const instructionsText =
    typeof instructions === "string" ? instructions : null;
  useEffect(() => {
    if (instructionsText !== null) void session.refreshInstructions();
  }, [session, instructionsText]);

  const connect = useCallback(async () => {
    setError(null);
    await session.connect();
  }, [session]);

  const disconnect = useCallback(async () => {
    await session.disconnect();
    setTranscripts([]);
    setToolCalls([]);
    setRemoteStream(null);
    setMicEnabledState(true);
    setUserSpeaking(false);
    setAgentSpeaking(false);
  }, [session]);

  const autoConnect = options.autoConnect ?? false;
  useEffect(() => {
    if (!autoConnect) return;
    void session.connect();
  }, [autoConnect, session]);

  const interrupt = useCallback(() => session.interrupt(), [session]);

  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      session.setMicEnabled(enabled);
      setMicEnabledState(enabled);
    },
    [session],
  );

  const toggleMic = useCallback(() => {
    setMicEnabledState(session.toggleMic());
  }, [session]);

  const setSpeakerphone = useCallback(
    (enabled: boolean) => session.setSpeakerphone(enabled),
    [session],
  );

  const sendText = useCallback(
    (text: string) => session.sendText(text),
    [session],
  );

  const refreshInstructions = useCallback(
    () => session.refreshInstructions(),
    [session],
  );

  const clearTranscripts = useCallback(() => setTranscripts([]), []);
  const clearError = useCallback(() => setError(null), []);

  const userTranscript = useMemo(
    () => latestTextForRole(transcripts, "user"),
    [transcripts],
  );
  const agentTranscript = useMemo(
    () => latestTextForRole(transcripts, "assistant"),
    [transcripts],
  );

  return {
    state,
    isConnected: state === "connected",
    isConnecting: state === "connecting" || state === "authenticating",
    isReconnecting: state === "reconnecting",
    isUserSpeaking,
    isAgentSpeaking,
    isMicEnabled,
    error,
    transcripts,
    userTranscript,
    agentTranscript,
    toolCalls,
    usage,
    diagnostics,
    remoteStream,
    connect,
    disconnect,
    interrupt,
    toggleMic,
    setMicEnabled,
    setSpeakerphone,
    sendText,
    refreshInstructions,
    clearTranscripts,
    clearError,
    session,
  };
}

/**
 * Combine provider defaults with per-call options, dropping the hook-only keys
 * that the session does not understand. Explicit options always win.
 */
function mergeConfig(
  defaults: RealtimeVoiceDefaults | null,
  options: UseRealtimeVoiceOptions,
): RealtimeVoiceConfig {
  const {
    autoConnect: _autoConnect,
    onError: _onError,
    onTranscript: _onTranscript,
    onToolCall: _onToolCall,
    onToolResult: _onToolResult,
    onStateChange: _onStateChange,
    ...rest
  } = options;

  const merged = { ...(defaults ?? {}), ...stripUndefined(rest) };

  if (!merged.auth) {
    throw new Error(
      "[react-native-realtime-voice] No credentials. Pass `auth` to useRealtimeVoice(), or " +
        "wrap your app in <RealtimeVoiceProvider auth={...}>.",
    );
  }
  return merged as RealtimeVoiceConfig;
}

/** An explicitly-undefined option must not blank out a provider default. */
function stripUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out as Partial<T>;
}

function upsertById(
  list: TranscriptItem[],
  item: TranscriptItem,
): TranscriptItem[] {
  const index = list.findIndex((i) => i.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function upsertByCallId(
  list: ToolInvocation[],
  item: ToolInvocation,
): ToolInvocation[] {
  const index = list.findIndex((i) => i.callId === item.callId);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function latestTextForRole(
  transcripts: TranscriptItem[],
  role: TranscriptItem["role"],
): string {
  for (let i = transcripts.length - 1; i >= 0; i--) {
    const item = transcripts[i];
    if (item && item.role === role) return item.text;
  }
  return "";
}
