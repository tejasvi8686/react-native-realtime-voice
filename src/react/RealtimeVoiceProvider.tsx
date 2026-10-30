/**
 * Optional provider for configuration that is identical everywhere in an app —
 * credentials, WebRTC module, audio routing, log level.
 *
 * Without it, every `useRealtimeVoice` call repeats `auth`. With it, screens
 * declare only what makes them different: instructions and tools.
 */

import React, { createContext, useContext, useMemo } from "react";

import type { RealtimeVoiceConfig } from "../core/session";

/** Config that sensibly lives app-wide rather than per screen. */
export type RealtimeVoiceDefaults = Partial<
  Pick<
    RealtimeVoiceConfig,
    | "auth"
    | "model"
    | "voice"
    | "speed"
    | "turnDetection"
    | "transcription"
    | "noiseReduction"
    | "maxOutputTokens"
    | "webrtc"
    | "iceServers"
    | "mediaConstraints"
    | "inCallManager"
    | "speakerphone"
    | "audioRouter"
    | "logLevel"
    | "reconnect"
    | "replayHistory"
    | "isDevelopment"
  >
>;

const RealtimeVoiceContext = createContext<RealtimeVoiceDefaults | null>(null);

export function RealtimeVoiceProvider({
  children,
  ...defaults
}: RealtimeVoiceDefaults & { children: React.ReactNode }) {
  const {
    auth,
    model,
    voice,
    speed,
    turnDetection,
    transcription,
    noiseReduction,
    maxOutputTokens,
    webrtc,
    iceServers,
    mediaConstraints,
    inCallManager,
    speakerphone,
    audioRouter,
    logLevel,
    reconnect,
    replayHistory,
    isDevelopment,
  } = defaults;

  // The dependency list must be a fixed length on every render. Destructuring
  // each key explicitly guarantees that; deriving it from the props object
  // (e.g. Object.values) breaks the moment a consumer spreads a prop
  // conditionally, and React throws on a deps array that changes size.
  const value = useMemo<RealtimeVoiceDefaults>(
    () => ({
      auth,
      model,
      voice,
      speed,
      turnDetection,
      transcription,
      noiseReduction,
      maxOutputTokens,
      webrtc,
      iceServers,
      mediaConstraints,
      inCallManager,
      speakerphone,
      audioRouter,
      logLevel,
      reconnect,
      replayHistory,
      isDevelopment,
    }),
    [
      auth,
      model,
      voice,
      speed,
      turnDetection,
      transcription,
      noiseReduction,
      maxOutputTokens,
      webrtc,
      iceServers,
      mediaConstraints,
      inCallManager,
      speakerphone,
      audioRouter,
      logLevel,
      reconnect,
      replayHistory,
      isDevelopment,
    ],
  );

  return (
    <RealtimeVoiceContext.Provider value={value}>
      {children}
    </RealtimeVoiceContext.Provider>
  );
}

export function useRealtimeVoiceDefaults(): RealtimeVoiceDefaults | null {
  return useContext(RealtimeVoiceContext);
}
