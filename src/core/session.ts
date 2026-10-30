/**
 * RealtimeSession — the orchestrator.
 *
 * Owns credentials, transport, tool execution, transcript state and reconnect
 * policy. Framework-agnostic on purpose: the React hook is a thin adapter over
 * this class, and it can equally be driven from a plain script or a test.
 */

import { CredentialProvider, isApiKeyAuth, type AuthConfig } from "./auth";
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
  iceServers?: {
    urls: string | string[];
    username?: string;
    credential?: string;
  }[];
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
  /**
   * Bumped by every `connect()` and `disconnect()`. A connection attempt keeps
   * the value it started with and abandons itself once that no longer matches,
   * so a fast disconnect-then-connect can never leave two peer connections.
   */
  private connectionGeneration = 0;
  /** A reconnect continues the same call, so it must not greet a second time. */
  private hasGreeted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectStartedAt: number | null = null;
  private connectLatencyMs: number | null = null;

  private micEnabled = true;
  private agentSpeaking = false;
  private userSpeaking = false;
  private transcripts = new Map<string, TranscriptItem>();
  /**
   * Last session.update payload sent on the current connection, used to skip
   * redundant re-sends. Must be cleared whenever a new connection is opened:
   * a fresh server-side session starts with no config, so the update has to go
   * out again even though the local config is unchanged.
   */
  private lastSessionUpdateJson: string | null = null;
  /**
   * Instructions resolved for the current connection. The function form is
   * evaluated once per connection, not on every config push — a re-render that
   * only changes `tools` identity must not re-run a prompt builder.
   */
  private instructionsPromise: Promise<string | undefined> | null = null;
  /** Tool runs waiting on their response's `response.done`, by response id. */
  private pendingToolRuns = new Map<string, Promise<boolean>[]>();
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
    return [...this.transcripts.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
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
    const previousTools = this.config.tools ?? [];
    this.config = { ...this.config, ...partial };
    if (partial.tools && !sameItems(partial.tools, previousTools)) {
      this.tools.replace(partial.tools);
    }
    // An explicitly supplied prompt is always re-resolved; everything else
    // reuses the value resolved for this connection.
    if ("instructions" in partial) this.instructionsPromise = null;
    if (this.transport?.isOpen) void this.pushSessionUpdate();
  }

  /**
   * Re-evaluate `instructions` and push the result if it changed. The function
   * form otherwise runs once per connection.
   */
  async refreshInstructions(): Promise<void> {
    this.instructionsPromise = null;
    await this.pushSessionUpdate();
  }

  async connect(): Promise<void> {
    if (
      this.state === "connected" ||
      this.state === "connecting" ||
      this.state === "authenticating" ||
      this.state === "reconnecting"
    ) {
      this.logger.debug("connect() ignored; already " + this.state);
      return;
    }
    this.wantsConnection = true;
    this.reconnectAttempts = 0;
    this.hasGreeted = false;
    await this.openConnection(++this.connectionGeneration);
  }

  async disconnect(): Promise<void> {
    this.wantsConnection = false;
    this.connectionGeneration++;
    this.clearReconnectTimer();
    this.toolAbort?.abort();
    this.toolAbort = null;
    this.pendingToolRuns.clear();
    this.audioRouter.deactivate();

    // Detach before closing so the transport's own "closed" events are not
    // mistaken for a dropped call, and so a connect() issued right after this
    // starts clean instead of finding the old transport still attached.
    const transport = this.transport;
    this.transport = null;
    transport?.removeAllListeners();

    this.tools.reset();
    this.transcripts.clear();
    this.agentSpeaking = false;
    this.userSpeaking = false;
    this.micEnabled = true;
    this.connectStartedAt = null;
    this.lastSessionUpdateJson = null;
    this.instructionsPromise = null;
    this.setState("idle");

    await transport?.close();
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

  private async openConnection(generation: number): Promise<void> {
    this.connectStartedAt = Date.now();
    // A new server-side session carries none of our config, so the dedupe
    // cache must not survive into it.
    this.lastSessionUpdateJson = null;
    this.instructionsPromise = null;
    this.pendingToolRuns.clear();
    this.setState("authenticating");

    let transport: WebRTCTransport | null = null;
    try {
      const credential = await this.credentials.resolve();
      if (generation !== this.connectionGeneration) return;

      this.setState("connecting");

      transport = new WebRTCTransport({
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

      if (this.isSuperseded(generation, transport)) {
        await discardTransport(transport);
        return;
      }
      transport.setMicEnabled(this.micEnabled);
    } catch (e) {
      // Superseded by disconnect(), a newer connect() or a reconnect. Its
      // failure — usually "aborted" — belongs to a call nobody awaits any more.
      if (this.isSuperseded(generation, transport)) {
        if (transport) await discardTransport(transport);
        return;
      }
      const error = toRealtimeError(e);
      // An expired ephemeral token is the common retryable failure; force a
      // fresh mint before the next attempt.
      if (error.code === "auth-failed") this.credentials.invalidate();
      this.emit("error", error);
      this.handleConnectionFailure(error);
    }
  }

  private isSuperseded(
    generation: number,
    transport: WebRTCTransport | null,
  ): boolean {
    return (
      generation !== this.connectionGeneration ||
      (transport !== null && transport !== this.transport)
    );
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
            new RealtimeVoiceError(
              "connection-lost",
              `Peer connection ${peerState}.`,
              {
                retryable: true,
              },
            ),
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

    const instructions = await this.currentInstructions();
    if (!this.transport?.isOpen) return;
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

    // React consumers routinely pass `tools: [a, b]` and `instructions: () => …`
    // as inline literals, which get a fresh identity on every render. Without
    // this guard each render would push an identical session.update across the
    // wire. Compare the resolved payload and send only on a real change.
    const serialised = JSON.stringify(session);
    if (serialised === this.lastSessionUpdateJson) {
      this.logger.debug("Skipping session.update; config unchanged");
      return;
    }
    this.lastSessionUpdateJson = serialised;

    this.transport.send({ type: "session.update", session });
  }

  private maybeGreet(): void {
    const greeting = this.config.greeting;
    if (!greeting || this.hasGreeted) return;
    const instructions =
      typeof greeting === "string" ? greeting : DEFAULT_GREETING;
    this.hasGreeted =
      this.transport?.send({
        type: "response.create",
        response: { instructions },
      }) ?? false;
  }

  /** Instructions for this connection, resolved at most once until invalidated. */
  private currentInstructions(): Promise<string | undefined> {
    if (!this.instructionsPromise) {
      const pending = this.resolveInstructions();
      this.instructionsPromise = pending;
      // Never cache a failure; the next push retries.
      pending.catch(() => {
        if (this.instructionsPromise === pending) {
          this.instructionsPromise = null;
        }
      });
    }
    return this.instructionsPromise;
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
    const instructions = await this.currentInstructions();
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
        if (e.delta)
          this.appendTranscript(
            e.item_id ?? "user-live",
            "user",
            e.delta,
            false,
          );
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const e = event as InputTranscriptionCompletedEvent;
        if (e.transcript) {
          this.setTranscript(
            e.item_id ?? "user-live",
            "user",
            e.transcript,
            true,
          );
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
          this.appendTranscript(
            e.item_id ?? "agent-live",
            "assistant",
            e.delta,
            false,
          );
        }
        break;
      }

      case "response.output_text.delta": {
        const e = event as ResponseAudioTranscriptDeltaEvent;
        if (e.delta) {
          this.appendTranscript(
            e.item_id ?? "agent-live",
            "assistant",
            e.delta,
            false,
          );
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        const e = event as ResponseAudioTranscriptDoneEvent;
        if (e.transcript) {
          this.setTranscript(
            e.item_id ?? "agent-live",
            "assistant",
            e.transcript,
            true,
          );
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
        if (e.response?.id) {
          void this.finishToolRuns(e.response.id, e.response.status);
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const e = event as FunctionCallArgumentsDoneEvent;
        // Start the handler now rather than at response.done: the arguments
        // are final, and every millisecond here is silence on the call.
        const run = this.handleToolCall(e);
        if (e.response_id) {
          const runs = this.pendingToolRuns.get(e.response_id) ?? [];
          runs.push(run);
          this.pendingToolRuns.set(e.response_id, runs);
        } else {
          // No response id to wait on: follow up as soon as this one is in.
          const transport = this.transport;
          void run.then((sent) => {
            if (sent && transport) this.requestFollowUp(transport);
          });
        }
        break;
      }

      case "error": {
        const e = event as ErrorEvent;
        this.emit(
          "error",
          new RealtimeVoiceError(
            "server-error",
            e.error?.message ?? "Realtime API error.",
          ),
        );
        break;
      }

      default:
        break;
    }
  }

  /**
   * Run one tool call and send its output. Resolves true once the output is in
   * the conversation; the follow-up `response.create` is the caller's job.
   */
  private async handleToolCall(
    event: FunctionCallArgumentsDoneEvent,
  ): Promise<boolean> {
    const { call_id: callId, name } = event;
    if (!callId || !name) return false;

    const transport = this.transport;
    const signal = this.toolAbort?.signal;
    if (!transport || !signal) return false;

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
    if (!result) return false;
    if (signal.aborted || !transport.isOpen) {
      this.logger.debug(
        `Discarding result for ${name}; session no longer open.`,
      );
      return false;
    }

    this.emit("toolResult", {
      ...invocation,
      args: result.args,
      status: result.ok ? "succeeded" : "failed",
      result: result.ok ? result.output : undefined,
      error: result.ok
        ? undefined
        : String((result.output as any)?.error ?? "failed"),
      finishedAt: Date.now(),
    });

    return transport.send({
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
  }

  /**
   * Ask for the model's follow-up once every tool call in a response has its
   * output in the conversation and the response itself has finished. The API
   * rejects a `response.create` while a response is active, so a response that
   * called two tools must produce one follow-up, not one per tool.
   */
  private async finishToolRuns(
    responseId: string,
    status: string | undefined,
  ): Promise<void> {
    const runs = this.pendingToolRuns.get(responseId);
    if (!runs) return;
    this.pendingToolRuns.delete(responseId);

    const transport = this.transport;
    const sent = await Promise.all(runs);
    // A cancelled response means the user barged in, and turn detection is
    // already producing the reply to that; a second request would collide.
    if (status === "cancelled" || !sent.some(Boolean) || !transport) return;
    this.requestFollowUp(transport);
  }

  private requestFollowUp(transport: WebRTCTransport): void {
    // A reconnect in the meantime means a different server session, which
    // never saw these outputs.
    if (transport !== this.transport || !transport.isOpen) return;
    transport.send({ type: "response.create" });
  }

  private accumulateUsage(event: ResponseDoneEvent): void {
    const usage = event.response?.usage;
    if (!usage) return;
    this.usage = {
      inputTokens: this.usage.inputTokens + (usage.input_tokens ?? 0),
      outputTokens: this.usage.outputTokens + (usage.output_tokens ?? 0),
      inputAudioTokens:
        this.usage.inputAudioTokens +
        (usage.input_token_details?.audio_tokens ?? 0),
      outputAudioTokens:
        this.usage.outputAudioTokens +
        (usage.output_token_details?.audio_tokens ?? 0),
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

    const generation = this.connectionGeneration;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantsConnection || generation !== this.connectionGeneration) {
        return;
      }
      const stale = this.transport;
      this.transport = null;
      void (stale ? discardTransport(stale) : Promise.resolve()).then(() => {
        if (generation === this.connectionGeneration) {
          void this.openConnection(generation);
        }
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

/** Detach and close a transport that no live call is using. */
async function discardTransport(transport: WebRTCTransport): Promise<void> {
  transport.removeAllListeners();
  await transport.close();
}

/** Same tools in the same order — a re-render, not a real change. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function resolveAudioRouter(
  config: RealtimeVoiceConfig,
  logger: Logger,
): AudioRouter {
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
