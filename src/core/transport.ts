/**
 * WebRTC transport for the OpenAI Realtime API.
 *
 * Owns exactly one peer connection and its `oai-events` data channel. It knows
 * nothing about tools, transcripts or React — it moves SDP and JSON.
 */

import { Emitter } from "./emitter";
import { RealtimeVoiceError, toRealtimeError } from "./errors";
import type { ClientEvent, ServerEvent } from "./events";
import type { Logger } from "./logger";
import type { ResolvedCredential } from "./auth";
import type { RealtimeSessionPayload } from "./types";
import {
  DEFAULT_ICE_SERVERS,
  DEFAULT_MEDIA_CONSTRAINTS,
  resolveWebRTC,
  type WebRTCModule,
} from "./webrtc";

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DATA_CHANNEL_LABEL = "oai-events";

export type TransportEvents = {
  serverEvent: ServerEvent;
  remoteStream: unknown;
  dataChannelOpen: void;
  dataChannelClose: void;
  peerStateChange: string;
  iceStateChange: string;
  error: RealtimeVoiceError;
};

export type TransportOptions = {
  logger: Logger;
  webrtc?: WebRTCModule;
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  mediaConstraints?: Record<string, unknown>;
};

export class WebRTCTransport extends Emitter<TransportEvents> {
  private pc: any = null;
  private dataChannel: any = null;
  private localStream: any = null;
  private localAudioTrack: any = null;
  private abortController: AbortController | null = null;
  private callId: string | null = null;
  private closed = false;

  constructor(private readonly options: TransportOptions) {
    super();
  }

  get isOpen(): boolean {
    return this.dataChannel?.readyState === "open";
  }

  getCallId(): string | null {
    return this.callId;
  }

  getPeerConnectionState(): string {
    return this.pc?.connectionState ?? "closed";
  }

  getIceConnectionState(): string {
    return this.pc?.iceConnectionState ?? "closed";
  }

  getDataChannelState(): string {
    return this.dataChannel?.readyState ?? "closed";
  }

  /**
   * Establish the peer connection and complete the SDP exchange.
   *
   * With an ephemeral credential the session config already lives in the token,
   * so we POST bare SDP. With a raw API key the config has to ride along in a
   * multipart body, which is the only reason that code path exists.
   */
  async connect(params: {
    credential: ResolvedCredential;
    session: RealtimeSessionPayload;
  }): Promise<void> {
    const { logger } = this.options;
    if (this.pc) await this.close();

    this.closed = false;
    this.abortController = new AbortController();
    const webrtc = resolveWebRTC(this.options.webrtc);

    // 1. Microphone. Permission denial surfaces here.
    let stream: any;
    try {
      stream = await webrtc.mediaDevices.getUserMedia(
        this.options.mediaConstraints ?? DEFAULT_MEDIA_CONSTRAINTS,
      );
    } catch (e) {
      throw new RealtimeVoiceError(
        "mic-permission-denied",
        "Microphone access was denied or unavailable. Check the microphone " +
          "permission for this app in system settings.",
        { cause: e },
      );
    }
    this.localStream = stream;

    const audioTracks = stream.getAudioTracks?.() ?? [];
    if (!audioTracks.length) {
      stream.getTracks?.().forEach((t: any) => t.stop?.());
      this.localStream = null;
      throw new RealtimeVoiceError(
        "no-audio-track",
        "The microphone returned no audio track.",
      );
    }
    this.localAudioTrack = audioTracks[0];

    // 2. Peer connection.
    const pc = new webrtc.RTCPeerConnection({
      iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 10,
    });
    this.pc = pc;
    this.attachPeerListeners(pc);

    pc.addTrack(this.localAudioTrack, stream);

    // 3. Data channel must exist before the offer so it lands in the SDP.
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL);
    this.dataChannel = dc;
    this.attachDataChannelListeners(dc);

    // 4. Offer.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offerSdp: string | undefined = pc.localDescription?.sdp;
    if (!offerSdp) {
      await this.close();
      throw new RealtimeVoiceError(
        "sdp-exchange-failed",
        "Failed to produce a local SDP offer.",
      );
    }

    // 5. Exchange.
    const { answerSdp, callId } = await this.postOffer(
      offerSdp,
      params.credential,
      params.session,
    );
    this.callId = callId;
    logger.debug("SDP exchange complete", { callId });

    if (this.closed) {
      throw new RealtimeVoiceError("aborted", "Connection was cancelled.");
    }

    // 6. Answer.
    await pc.setRemoteDescription(
      new webrtc.RTCSessionDescription({ type: "answer", sdp: answerSdp }),
    );
  }

  private attachPeerListeners(pc: any): void {
    pc.addEventListener("connectionstatechange", () => {
      this.emit("peerStateChange", pc.connectionState);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      this.emit("iceStateChange", pc.iceConnectionState);
    });
    pc.addEventListener("track", (event: any) => {
      const stream = event?.streams?.[0];
      // Remote audio is rendered by the native peer connection automatically;
      // the stream is surfaced only so consumers can visualise it.
      if (stream) this.emit("remoteStream", stream);
    });
    pc.addEventListener("error", (e: any) => {
      this.emit("error", toRealtimeError(e, "connection-failed"));
    });
  }

  private attachDataChannelListeners(dc: any): void {
    dc.addEventListener("open", () => this.emit("dataChannelOpen", undefined));
    dc.addEventListener("close", () => this.emit("dataChannelClose", undefined));
    dc.addEventListener("message", (e: any) => {
      const data = e?.data;
      if (typeof data !== "string") return;
      try {
        this.emit("serverEvent", JSON.parse(data) as ServerEvent);
      } catch {
        this.options.logger.debug("Ignoring non-JSON data channel frame");
      }
    });
    dc.addEventListener("error", (e: any) => {
      this.emit("error", toRealtimeError(e, "connection-lost"));
    });
  }

  private async postOffer(
    sdp: string,
    credential: ResolvedCredential,
    session: RealtimeSessionPayload,
  ): Promise<{ answerSdp: string; callId: string | null }> {
    const signal = this.abortController?.signal;

    const request: RequestInit =
      credential.kind === "ephemeral"
        ? {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credential.token}`,
              "Content-Type": "application/sdp",
            },
            body: sdp,
            signal,
          }
        : buildMultipartRequest(sdp, credential.token, session, signal);

    let response: Response;
    try {
      response = await fetch(REALTIME_CALLS_URL, request);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        throw new RealtimeVoiceError("aborted", "Connection was cancelled.");
      }
      throw new RealtimeVoiceError(
        "sdp-exchange-failed",
        `Could not reach the Realtime API: ${(e as Error)?.message ?? e}`,
        { cause: e, retryable: true },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new RealtimeVoiceError(
          "auth-failed",
          credential.kind === "ephemeral"
            ? "The ephemeral token was rejected. It may have expired — tokens are " +
              "short-lived, so mint one immediately before connecting."
            : "The OpenAI API key was rejected. Check it at platform.openai.com.",
          { retryable: credential.kind === "ephemeral" },
        );
      }
      throw new RealtimeVoiceError(
        "sdp-exchange-failed",
        `Realtime API returned ${response.status}: ${text || response.statusText}`,
        { retryable: response.status >= 500 },
      );
    }

    return {
      answerSdp: await response.text(),
      callId: response.headers.get("Location")?.split("/").pop() ?? null,
    };
  }

  /** Send a client event. Returns false when the channel is not open. */
  send(event: ClientEvent | Record<string, unknown>): boolean {
    if (this.dataChannel?.readyState !== "open") {
      this.options.logger.debug("Dropping event, data channel not open", event);
      return false;
    }
    this.dataChannel.send(JSON.stringify(event));
    return true;
  }

  setMicEnabled(enabled: boolean): void {
    if (this.localAudioTrack) this.localAudioTrack.enabled = enabled;
  }

  isMicEnabled(): boolean {
    return this.localAudioTrack?.enabled ?? false;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController?.abort();
    this.abortController = null;

    try {
      this.dataChannel?.close();
    } catch {
      /* already closed */
    }
    this.dataChannel = null;

    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.pc = null;

    this.localStream?.getTracks?.().forEach((t: any) => t.stop?.());
    this.localStream = null;
    this.localAudioTrack = null;
    this.callId = null;
    // Listeners are intentionally preserved so the transport can be reconnected.
  }

  /** Release listeners too. Call when the owning session is discarded. */
  dispose(): void {
    void this.close();
    this.removeAllListeners();
  }
}

/** Monotonic counter keeps multipart boundaries unique within a process. */
let multipartCounter = 0;

/**
 * Raw-API-key path only: the session config cannot be pre-registered, so it is
 * sent as a second multipart part alongside the SDP.
 */
function buildMultipartRequest(
  sdp: string,
  apiKey: string,
  session: RealtimeSessionPayload,
  signal: AbortSignal | undefined,
): RequestInit {
  const boundary = `----realtimevoice${Date.now().toString(36)}${(multipartCounter++).toString(36)}`;
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="sdp"',
    "Content-Type: application/sdp",
    "",
    sdp,
    `--${boundary}`,
    'Content-Disposition: form-data; name="session"',
    "Content-Type: application/json",
    "",
    JSON.stringify(session),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal,
  };
}
