/**
 * Batteries-included screen body.
 *
 * Takes the result of `useRealtimeVoice` and renders a complete, working voice
 * UI. Intended as the fastest path to something on screen — every part of it is
 * also exported individually for apps that want their own layout.
 */

import { StyleSheet, Text, View, type ViewStyle } from "react-native";

import type { UseRealtimeVoiceResult } from "../react/useRealtimeVoice";
import { TranscriptView } from "./TranscriptView";
import { VoiceControlBar } from "./VoiceControlBar";
import { VoiceOrb } from "./VoiceOrb";
import { resolveTheme, type RealtimeVoiceTheme } from "./theme";

export type VoiceAgentViewProps = {
  /** The object returned by `useRealtimeVoice()`. */
  voice: UseRealtimeVoiceResult;
  title?: string;
  subtitle?: string;
  /** "bubbles" for a chat log, "caption" for a single centred line. */
  transcriptVariant?: "bubbles" | "caption";
  /** Show a barge-in button while the agent is speaking. Default true. */
  allowInterrupt?: boolean;
  theme?: Partial<RealtimeVoiceTheme>;
  style?: ViewStyle;
};

export function VoiceAgentView({
  voice,
  title,
  subtitle,
  transcriptVariant = "caption",
  allowInterrupt = true,
  theme: themeOverride,
  style,
}: VoiceAgentViewProps) {
  const theme = resolveTheme(themeOverride);

  const statusLine = voice.isReconnecting
    ? "Reconnecting…"
    : voice.isConnecting
      ? "Connecting…"
      : !voice.isConnected
        ? (subtitle ?? "Tap the mic to start talking")
        : !voice.isMicEnabled
          ? "Microphone muted"
          : voice.isAgentSpeaking
            ? "Speaking…"
            : voice.isUserSpeaking
              ? "Listening…"
              : "Ready when you are";

  const handleMicPress = () => {
    if (!voice.isConnected) void voice.connect();
    else voice.toggleMic();
  };

  return (
    <View
      style={[styles.container, { backgroundColor: theme.background }, style]}
    >
      <View style={styles.header}>
        {title ? (
          <Text
            style={[
              styles.title,
              {
                color: theme.text,
                fontFamily: theme.fontFamilyMedium ?? theme.fontFamily,
              },
            ]}
          >
            {title}
          </Text>
        ) : null}
        <Text
          style={[
            styles.status,
            { color: theme.textMuted, fontFamily: theme.fontFamily },
          ]}
        >
          {statusLine}
        </Text>
      </View>

      <View style={styles.orbArea}>
        <VoiceOrb
          isConnected={voice.isConnected}
          isConnecting={voice.isConnecting || voice.isReconnecting}
          isUserSpeaking={voice.isUserSpeaking}
          isAgentSpeaking={voice.isAgentSpeaking}
          theme={themeOverride}
        />
      </View>

      <View style={styles.transcriptArea}>
        <TranscriptView
          transcripts={voice.transcripts}
          variant={transcriptVariant}
          theme={themeOverride}
        />
      </View>

      {voice.error ? (
        <View
          style={[
            styles.errorBanner,
            {
              backgroundColor: theme.surface,
              borderColor: theme.danger,
              borderRadius: theme.radius,
            },
          ]}
        >
          <Text
            style={[
              styles.errorText,
              { color: theme.text, fontFamily: theme.fontFamily },
            ]}
          >
            {voice.error.message}
          </Text>
        </View>
      ) : null}

      <VoiceControlBar
        isConnected={voice.isConnected}
        isConnecting={voice.isConnecting || voice.isReconnecting}
        isMicEnabled={voice.isMicEnabled}
        isUserSpeaking={voice.isUserSpeaking}
        isAgentSpeaking={voice.isAgentSpeaking}
        onMicPress={handleMicPress}
        onEndPress={() => void voice.disconnect()}
        onInterruptPress={allowInterrupt ? voice.interrupt : undefined}
        theme={themeOverride}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "space-between",
  },
  header: {
    alignItems: "center",
    paddingTop: 32,
    paddingHorizontal: 24,
    gap: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: "600",
    textAlign: "center",
  },
  status: {
    fontSize: 14,
    textAlign: "center",
  },
  orbArea: {
    alignItems: "center",
    justifyContent: "center",
  },
  transcriptArea: {
    flex: 1,
    justifyContent: "center",
  },
  errorBanner: {
    marginHorizontal: 24,
    marginBottom: 8,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
