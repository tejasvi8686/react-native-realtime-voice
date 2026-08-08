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
    | "isDevelopment"
  >
>;

const RealtimeVoiceContext = createContext<RealtimeVoiceDefaults | null>(null);

export function RealtimeVoiceProvider({
  children,
  ...defaults
}: RealtimeVoiceDefaults & { children: React.ReactNode }) {
  // Serialising is not viable here (functions, native modules), so identity is
  // the contract: pass a stable object or accept re-provides.
  const value = useMemo(
    () => defaults,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    Object.values(defaults),
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
