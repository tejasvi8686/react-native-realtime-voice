/**
 * RealtimeSession — the orchestrator.
 *
 * Owns credentials, transport, tool execution, transcript state and reconnect
 * policy. Framework-agnostic on purpose: the React hook is a thin adapter over
 * this class, and it can equally be driven from a plain script or a test.
 */

import {
  CredentialProvider,
  isApiKeyAuth,
  type AuthConfig,
} from "./auth";
import {
  createInCallAudioRouter,
  noopAudioRouter,
  type AudioRouter,
  type InCallManagerLike,
} from "./audio";
import { Emitter } from "./emitter";
import { RealtimeVoiceError, toRealtimeError } from "./errors";
import type {
  ErrorEvent,
  FunctionCallArgumentsDoneEvent,
  InputTranscriptionCompletedEvent,
  InputTranscriptionDeltaEvent,
  ResponseAudioTranscriptDeltaEvent,
  ResponseAudioTranscriptDoneEvent,
  ResponseDoneEvent,
  ServerEvent,
} from "./events";
import { createLogger, type LogLevel, type Logger } from "./logger";
import { ToolRegistry, type ToolDefinition } from "./tools";
import { WebRTCTransport } from "./transport";
import type {
  ConnectionState,
  Diagnostics,
  InputTranscription,
  NoiseReduction,
  RealtimeSessionPayload,
  RealtimeVoice,
  ToolChoice,
  ToolInvocation,
  TranscriptItem,
  TurnDetection,
  UsageSnapshot,
} from "./types";
import type { WebRTCModule } from "./webrtc";

export type ReconnectPolicy = {
  /** Default true. */
  enabled?: boolean;
  /** Default 3. */
  maxAttempts?: number;
  /** Default 500ms, doubled each attempt. */
  initialDelayMs?: number;
  /** Default 8000ms. */
  maxDelayMs?: number;
};

export type RealtimeVoiceConfig = {
  /** Ephemeral tokens (recommended) or a raw key for local development. */
  auth: AuthConfig;

  /**
   * Only used on the raw-API-key path. With ephemeral tokens the model is fixed
   * by your backend when it mints the secret.
   */
  model?: string;
  /** Same caveat as `model`: ephemeral tokens carry the voice from the backend. */
  voice?: RealtimeVoice;
  /** 0.25–1.5. Raw-key path only. */
  speed?: number;

  /**
   * System prompt. Pass a function to rebuild it at connect time — useful when
   * the prompt embeds app state that would otherwise go stale between sessions.
   */
  instructions?: string | (() => string | Promise<string>);

  /** VAD tuning. Pass `null` to disable and drive turns manually. */
  turnDetection?: TurnDetection;
  /** Input transcription. `false` disables it (saves tokens if you show no text). */
  transcription?: InputTranscription | false;
  noiseReduction?: NoiseReduction | false;
  maxOutputTokens?: number | "inf";
  toolChoice?: ToolChoice;
  tools?: ToolDefinition<any>[];

  /** Speak first on connect. `true` uses a neutral built-in nudge. */
  greeting?: string | boolean;

  // ---- infrastructure ----

  /** Override the registered WebRTC module for this session only. */
  webrtc?: WebRTCModule;
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  mediaConstraints?: Record<string, unknown>;

  /**
   * Pass your imported `react-native-incall-manager` to route audio to the
   * loudspeaker. Omit it (or pass `false`) to leave routing untouched.
   */
  inCallManager?: InCallManagerLike | false;
  /** Default true when `inCallManager` is supplied. */
  speakerphone?: boolean;
  /** Full control: supply your own router and ignore the above. */
  audioRouter?: AudioRouter;

  /** Default "silent". Use "debug" while integrating. */
  logLevel?: LogLevel;
  reconnect?: ReconnectPolicy;
  /** Marks raw-key usage as expected. Defaults to `__DEV__` when available. */
  isDevelopment?: boolean;
};

export type SessionEvents = {
  stateChange: ConnectionState;
  /** Fires on every delta; `isFinal` marks completion. */
  transcript: TranscriptItem;
  userSpeechStart: void;
  userSpeechStop: void;
  agentSpeechStart: void;
  agentSpeechStop: void;
  toolCall: ToolInvocation;
  toolResult: ToolInvocation;
  usage: UsageSnapshot;
  remoteStream: unknown;
  diagnostics: Diagnostics;
  error: RealtimeVoiceError;
  /** Every server event, including ones the package does not interpret. */
  raw: ServerEvent;
};

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_GREETING =
  "Greet the user warmly in one short sentence, then wait for them to speak.";

function detectDev(): boolean {
  const g = globalThis as { __DEV__?: boolean };
  return typeof g.__DEV__ === "boolean" ? g.__DEV__ : false;
}

export class RealtimeSession extends Emitter<SessionEvents> {
  private config: RealtimeVoiceConfig;
  private readonly logger: Logger;
  private readonly credentials: CredentialProvider;
  private readonly tools: ToolRegistry;
  private readonly audioRouter: AudioRouter;

  private transport: WebRTCTransport | null = null;
  private state: ConnectionState = "idle";
  private toolAbort: AbortController | null = null;

  /** Set while the consumer intends to be connected; cleared by `disconnect()`. */
  private wantsConnection = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectStartedAt: number | null = null;
  private connectLatencyMs: number | null = null;

  private micEnabled = true;
  private agentSpeaking = false;
  private userSpeaking = false;
  private transcripts = new Map<string, TranscriptItem>();
  private usage: UsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    totalTokens: 0,
  };

  constructor(config: RealtimeVoiceConfig) {
    super();
    this.config = config;
    this.logger = createLogger(config.logLevel ?? "silent");
    this.credentials = new CredentialProvider(
      config.auth,
      this.logger,
      config.isDevelopment ?? detectDev(),
    );
    this.tools = new ToolRegistry(config.tools ?? [], this.logger);
    this.audioRouter = resolveAudioRouter(config, this.logger);
  }

  // ---------------------------------------------------------------- accessors

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  isAgentSpeaking(): boolean {
    return this.agentSpeaking;
  }

  isUserSpeaking(): boolean {
    return this.userSpeaking;
  }

  getTranscripts(): TranscriptItem[] {
    return [...this.transcripts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getUsage(): UsageSnapshot {
    return { ...this.usage };
  }

  getDiagnostics(): Diagnostics {
    return {
      peerConnectionState: this.transport?.getPeerConnectionState() ?? "closed",
      iceConnectionState: this.transport?.getIceConnectionState() ?? "closed",
      dataChannelState: this.transport?.getDataChannelState() ?? "closed",
      callId: this.transport?.getCallId() ?? null,
      connectLatencyMs: this.connectLatencyMs,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ------------------------------------------------------------------ control

  /**
   * Update configuration on a live session. Instructions, tools, tool choice
   * and turn detection take effect immediately; model and voice are fixed for
   * the lifetime of a connection and apply on the next connect.
   */
  updateConfig(partial: Partial<RealtimeVoiceConfig>): void {
    this.config = { ...this.config, ...partial };
    if (partial.tools) this.tools.replace(partial.tools);
    if (this.transport?.isOpen) void this.pushSessionUpdate();
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") {
      this.logger.debug("connect() ignored; already " + this.state);
      return;
    }
    this.wantsConnection = true;
    this.reconnectAttempts = 0;
    await this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.wantsConnection = false;
    this.clearReconnectTimer();
    this.toolAbort?.abort();
    this.toolAbort = null;
    this.audioRouter.deactivate();

    if (this.transport) {
      await this.transport.close();
      this.transport.removeAllListeners();
      this.transport = null;
    }

    this.tools.reset();
    this.transcripts.clear();
    this.agentSpeaking = false;
    this.userSpeaking = false;
    this.micEnabled = true;
    this.connectStartedAt = null;
    this.setState("idle");
  }

  /** Stop the agent mid-sentence and drop its queued audio. */
  interrupt(): void {
    if (!this.transport?.isOpen) return;
    this.transport.send({ type: "response.cancel" });
    this.transport.send({ type: "output_audio_buffer.clear" });
    this.setAgentSpeaking(false);
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    this.transport?.setMicEnabled(enabled);
  }

  toggleMic(): boolean {
    this.setMicEnabled(!this.micEnabled);
    return this.micEnabled;
  }

  setSpeakerphone(enabled: boolean): void {
    this.audioRouter.setSpeakerphone(enabled);
  }

  /** Inject a text turn from the user and ask the model to respond. */
  sendText(text: string): void {
    if (!this.transport?.isOpen) {
      this.logger.warn("sendText() ignored; not connected.");
      return;
    }
    this.transport.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.transport.send({ type: "response.create" });
  }

  /** Escape hatch for client events the package does not wrap. */
  sendEvent(event: Record<string, unknown>): boolean {
    return this.transport?.send(event) ?? false;
  }

  /** Release everything, including listeners. The instance is unusable after. */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.removeAllListeners();
  }

  // ----------------------------------------------------------------- internals

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.logger.debug(`state → ${next}`);
    this.emit("stateChange", next);
    this.emit("diagnostics", this.getDiagnostics());
  }

  private setAgentSpeaking(speaking: boolean): void {
    if (this.agentSpeaking === speaking) return;
    this.agentSpeaking = speaking;
    this.emit(speaking ? "agentSpeechStart" : "agentSpeechStop", undefined);
  }

  private setUserSpeaking(speaking: boolean): void {
    if (this.userSpeaking === speaking) return;
    this.userSpeaking = speaking;
    this.emit(speaking ? "userSpeechStart" : "userSpeechStop", undefined);
  }

  private async openConnection(): Promise<void> {
    this.connectStartedAt = Date.now();
    this.setState("authenticating");

    try {
      const credential = await this.credentials.resolve();
      if (!this.wantsConnection) return;

      this.setState("connecting");

      const transport = new WebRTCTransport({
        logger: this.logger,
        webrtc: this.config.webrtc,
        iceServers: this.config.iceServers,
        mediaConstraints: this.config.mediaConstraints,
      });
      this.transport = transport;
      this.wireTransport(transport);

      this.toolAbort = new AbortController();

      await transport.connect({
        credential,
        session: await this.buildSessionPayload(),
      });

      if (!this.wantsConnection) {
        await this.disconnect();
        return;
      }
      transport.setMicEnabled(this.micEnabled);
    } catch (e) {
      const error = toRealtimeError(e);
      // An expired ephemeral token is the common retryable failure; force a
      // fresh mint before the next attempt.
      if (error.code === "auth-failed") this.credentials.invalidate();
      this.emit("error", error);
      this.handleConnectionFailure(error);
    }
  }

  private wireTransport(transport: WebRTCTransport): void {
    transport.on("dataChannelOpen", () => {
      this.connectLatencyMs = this.connectStartedAt
        ? Date.now() - this.connectStartedAt
        : null;
      this.reconnectAttempts = 0;
      void this.pushSessionUpdate().then(() => this.maybeGreet());
      this.audioRouter.activate();
      this.setState("connected");
    });

    transport.on("serverEvent", (event) => this.handleServerEvent(event));
    transport.on("remoteStream", (stream) => this.emit("remoteStream", stream));

    transport.on("peerStateChange", (peerState) => {
      this.emit("diagnostics", this.getDiagnostics());
      if (peerState === "failed" || peerState === "closed") {
        if (this.wantsConnection) {
          this.handleConnectionFailure(
            new RealtimeVoiceError("connection-lost", `Peer connection ${peerState}.`, {
              retryable: true,
            }),
          );
        }
      } else if (peerState === "disconnected") {
        // Transient ICE drop; WebRTC often recovers on its own.
        this.logger.debug("Peer connection disconnected, awaiting recovery");
      }
    });

    transport.on("iceStateChange", () =>
      this.emit("diagnostics", this.getDiagnostics()),
    );
    transport.on("error", (error) => this.emit("error", error));
  }

  /**
   * Push everything the API allows to change mid-session.
   *
   * Deliberately re-sent on every (re)connect: with ephemeral tokens the
   * backend owns model and voice, while the app owns prompt, tools and VAD.
   * That split lets product behaviour ship without a backend deploy.
   */
  private async pushSessionUpdate(): Promise<void> {
    if (!this.transport?.isOpen) return;

    const instructions = await this.resolveInstructions();
    const session: Record<string, unknown> = { type: "realtime" };

    if (instructions) session.instructions = instructions;
    if (this.tools.size > 0) {
      session.tools = this.tools.toWireFormat();
      session.tool_choice = this.config.toolChoice ?? "auto";
    }

    const audio = this.buildAudioConfig({ includeOutput: false });
    if (audio) session.audio = audio;
    if (this.config.maxOutputTokens !== undefined) {
      session.max_output_tokens = this.config.maxOutputTokens;
    }

    this.transport.send({ type: "session.update", session });
  }

  private maybeGreet(): void {
    const greeting = this.config.greeting;
    if (!greeting) return;
    const instructions = typeof greeting === "string" ? greeting : DEFAULT_GREETING;
    this.transport?.send({ type: "response.create", response: { instructions } });
  }

  private async resolveInstructions(): Promise<string | undefined> {
    const { instructions } = this.config;
    if (!instructions) return undefined;
    const value =
      typeof instructions === "function" ? await instructions() : instructions;
    return value?.trim() || undefined;
  }

  private buildAudioConfig(opts: { includeOutput: boolean }) {
    const input: Record<string, unknown> = {};

    if (this.config.turnDetection !== undefined) {
      input.turn_detection = this.config.turnDetection;
    }
    if (this.config.transcription !== false) {
      input.transcription = this.config.transcription ?? { model: "whisper-1" };
    }
    if (this.config.noiseReduction !== false && this.config.noiseReduction) {
      input.noise_reduction = this.config.noiseReduction;
    }

    const output: Record<string, unknown> = {};
    if (opts.includeOutput) {
      if (this.config.voice !== undefined) output.voice = this.config.voice;
      if (this.config.speed !== undefined) output.speed = this.config.speed;
    }

    const audio: Record<string, unknown> = {};
    if (Object.keys(input).length) audio.input = input;
    if (Object.keys(output).length) audio.output = output;
    return Object.keys(audio).length ? audio : undefined;
  }

  /**
   * Full payload for the raw-API-key multipart path. On the ephemeral path this
   * is unused — the backend already registered the session.
   */
  private async buildSessionPayload(): Promise<RealtimeSessionPayload> {
    if (!isApiKeyAuth(this.config.auth)) {
      return { type: "realtime" };
    }
    const payload: RealtimeSessionPayload = {
      type: "realtime",
      model: this.config.model ?? DEFAULT_MODEL,
    };
    const instructions = await this.resolveInstructions();
    if (instructions) payload.instructions = instructions;
    const audio = this.buildAudioConfig({ includeOutput: true });
    if (audio) payload.audio = audio as RealtimeSessionPayload["audio"];
    if (this.tools.size > 0) {
      payload.tools = this.tools.toWireFormat();
      payload.tool_choice = this.config.toolChoice ?? "auto";
    }
    if (this.config.maxOutputTokens !== undefined) {
      payload.max_output_tokens = this.config.maxOutputTokens;
    }
    return payload;
  }

  // ------------------------------------------------------------ event handling

  private handleServerEvent(event: ServerEvent): void {
    this.emit("raw", event);

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.setUserSpeaking(true);
        break;

      case "input_audio_buffer.speech_stopped":
        this.setUserSpeaking(false);
        break;

      case "conversation.item.input_audio_transcription.delta": {
        const e = event as InputTranscriptionDeltaEvent;
        if (e.delta) this.appendTranscript(e.item_id ?? "user-live", "user", e.delta, false);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const e = event as InputTranscriptionCompletedEvent;
        if (e.transcript) {
          this.setTranscript(e.item_id ?? "user-live", "user", e.transcript, true);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.failed":
        this.logger.debug("Input transcription failed for one item");
        break;

      case "response.created":
        this.setAgentSpeaking(true);
        break;

      case "response.output_audio_transcript.delta": {
        const e = event as ResponseAudioTranscriptDeltaEvent;
        if (e.delta) {
          this.appendTranscript(e.item_id ?? "agent-live", "assistant", e.delta, false);
        }
        break;
      }

      case "response.output_text.delta": {
        const e = event as ResponseAudioTranscriptDeltaEvent;
        if (e.delta) {
          this.appendTranscript(e.item_id ?? "agent-live", "assistant", e.delta, false);
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        const e = event as ResponseAudioTranscriptDoneEvent;
        if (e.transcript) {
          this.setTranscript(e.item_id ?? "agent-live", "assistant", e.transcript, true);
        }
        break;
      }

      case "output_audio_buffer.started":
        this.setAgentSpeaking(true);
        break;

      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.setAgentSpeaking(false);
        break;

      case "response.done": {
        const e = event as ResponseDoneEvent;
        this.setAgentSpeaking(false);
        this.accumulateUsage(e);
        const failure = e.response?.status_details?.error?.message;
        if (e.response?.status === "failed" && failure) {
          this.emit("error", new RealtimeVoiceError("server-error", failure));
        }
        break;
      }

      case "response.function_call_arguments.done":
        void this.handleToolCall(event as FunctionCallArgumentsDoneEvent);
        break;

      case "error": {
        const e = event as ErrorEvent;
        this.emit(
          "error",
          new RealtimeVoiceError("server-error", e.error?.message ?? "Realtime API error."),
        );
        break;
      }

      default:
        break;
    }
  }

  private async handleToolCall(event: FunctionCallArgumentsDoneEvent): Promise<void> {
    const { call_id: callId, name } = event;
    if (!callId || !name) return;

    const transport = this.transport;
    const signal = this.toolAbort?.signal;
    if (!transport || !signal) return;

    const invocation: ToolInvocation = {
      callId,
      name,
      args: {},
      status: "running",
      startedAt: Date.now(),
    };
    this.emit("toolCall", invocation);

    const result = await this.tools.execute({
      callId,
      name,
      rawArguments: event.arguments,
      signal,
      send: (e) => transport.send(e),
    });

    // Duplicate call_id, or the session went away while the handler ran.
    if (!result) return;
    if (signal.aborted || !transport.isOpen) {
      this.logger.debug(`Discarding result for ${name}; session no longer open.`);
      return;
    }

    this.emit("toolResult", {
      ...invocation,
      args: result.args,
      status: result.ok ? "succeeded" : "failed",
      result: result.ok ? result.output : undefined,
      error: result.ok ? undefined : String((result.output as any)?.error ?? "failed"),
      finishedAt: Date.now(),
    });

    transport.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output:
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output ?? {}),
      },
    });
    // The API queues the item before it can generate; issuing response.create in
    // the same tick is what the 200ms sleep in the original code was papering
    // over. A microtask hop is enough because the data channel preserves order.
    await Promise.resolve();
    transport.send({ type: "response.create" });
  }

  private accumulateUsage(event: ResponseDoneEvent): void {
    const usage = event.response?.usage;
    if (!usage) return;
    this.usage = {
      inputTokens: this.usage.inputTokens + (usage.input_tokens ?? 0),
      outputTokens: this.usage.outputTokens + (usage.output_tokens ?? 0),
      inputAudioTokens:
        this.usage.inputAudioTokens + (usage.input_token_details?.audio_tokens ?? 0),
      outputAudioTokens:
        this.usage.outputAudioTokens + (usage.output_token_details?.audio_tokens ?? 0),
      totalTokens: this.usage.totalTokens + (usage.total_tokens ?? 0),
    };
    this.emit("usage", this.getUsage());
  }

  private appendTranscript(
    id: string,
    role: TranscriptItem["role"],
    delta: string,
    isFinal: boolean,
  ): void {
    const existing = this.transcripts.get(id);
    const item: TranscriptItem = existing
      ? { ...existing, text: existing.text + delta, isFinal }
      : { id, role, text: delta, isFinal, createdAt: Date.now() };
    this.transcripts.set(id, item);
    this.emit("transcript", item);
  }

  private setTranscript(
    id: string,
    role: TranscriptItem["role"],
    text: string,
    isFinal: boolean,
  ): void {
    const existing = this.transcripts.get(id);
    const item: TranscriptItem = {
      id,
      role,
      text,
      isFinal,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.transcripts.set(id, item);
    this.emit("transcript", item);
  }

  // -------------------------------------------------------------- reconnection

  private handleConnectionFailure(error: RealtimeVoiceError): void {
    if (!this.wantsConnection) {
      this.setState("disconnected");
      return;
    }

    const policy = this.config.reconnect ?? {};
    const enabled = policy.enabled ?? true;
    const maxAttempts = policy.maxAttempts ?? 3;

    if (!enabled || !error.retryable || this.reconnectAttempts >= maxAttempts) {
      this.wantsConnection = false;
      this.audioRouter.deactivate();
      void this.transport?.close();
      this.setState("failed");
      return;
    }

    const initial = policy.initialDelayMs ?? 500;
    const max = policy.maxDelayMs ?? 8000;
    const delay = Math.min(initial * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts += 1;

    this.logger.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`,
    );
    this.setState("reconnecting");

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantsConnection) return;
      void this.transport?.close().then(() => {
        this.transport?.removeAllListeners();
        this.transport = null;
        void this.openConnection();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function resolveAudioRouter(config: RealtimeVoiceConfig, logger: Logger): AudioRouter {
  if (config.audioRouter) return config.audioRouter;
  if (config.inCallManager) {
    return createInCallAudioRouter({
      inCallManager: config.inCallManager,
      logger,
      speakerphone: config.speakerphone ?? true,
    });
  }
  return noopAudioRouter;
}
