/**
 * Optional UI kit — `@tejasvi8686/realtime-voice/ui`.
 *
 * Pure React Native: no icon library, no animation library, no gradient
 * library. Import nothing from here and none of it ships in your bundle.
 */

export { MicButton, type MicButtonProps } from "./MicButton";
export { TranscriptView, type TranscriptViewProps } from "./TranscriptView";
export { VoiceAgentView, type VoiceAgentViewProps } from "./VoiceAgentView";
export { VoiceControlBar, type VoiceControlBarProps } from "./VoiceControlBar";
export { VoiceOrb, type VoiceOrbProps } from "./VoiceOrb";
export {
  darkTheme,
  defaultTheme,
  lightTheme,
  resolveTheme,
  statusColor,
  type RealtimeVoiceTheme,
} from "./theme";
