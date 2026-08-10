/**
 * Theming for the optional UI kit.
 *
 * A flat token object rather than imports from a design system, so the
 * components drop into any app without dragging a palette along.
 */

export type RealtimeVoiceTheme = {
  /** Orb + primary control fill. */
  accent: string;
  /** Shown while the user is talking. */
  listening: string;
  /** Shown while the agent is talking. */
  speaking: string;
  /** Shown when connected but nobody is talking. */
  idle: string;
  danger: string;
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  onAccent: string;
  radius: number;
  fontFamily?: string;
  fontFamilyMedium?: string;
};

export const darkTheme: RealtimeVoiceTheme = {
  accent: "#55B3FE",
  listening: "#17CCE9",
  speaking: "#7463FF",
  idle: "#4A5568",
  danger: "#F05252",
  background: "#0B0D1A",
  surface: "rgba(255,255,255,0.08)",
  border: "rgba(255,255,255,0.16)",
  text: "#FFFFFF",
  textMuted: "#9AA3B2",
  onAccent: "#FFFFFF",
  radius: 16,
};

export const lightTheme: RealtimeVoiceTheme = {
  accent: "#128BEE",
  listening: "#0FA4BC",
  speaking: "#5B4BDB",
  idle: "#C4CCD8",
  danger: "#D62828",
  background: "#FFFFFF",
  surface: "rgba(0,0,0,0.05)",
  border: "rgba(0,0,0,0.12)",
  text: "#101828",
  textMuted: "#667085",
  onAccent: "#FFFFFF",
  radius: 16,
};

export const defaultTheme = darkTheme;

export function resolveTheme(
  theme?: Partial<RealtimeVoiceTheme>,
): RealtimeVoiceTheme {
  return theme ? { ...defaultTheme, ...theme } : defaultTheme;
}

/** Which colour represents the current conversational state. */
export function statusColor(
  theme: RealtimeVoiceTheme,
  status: {
    isUserSpeaking?: boolean;
    isAgentSpeaking?: boolean;
    isConnected?: boolean;
  },
): string {
  if (status.isAgentSpeaking) return theme.speaking;
  if (status.isUserSpeaking) return theme.listening;
  if (status.isConnected) return theme.idle;
  return theme.accent;
}
