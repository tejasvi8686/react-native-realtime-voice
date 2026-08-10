/**
 * Mic + end-call row, with an optional barge-in button while the agent talks.
 */

import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { MicButton } from "./MicButton";
import { resolveTheme, type RealtimeVoiceTheme } from "./theme";

export type VoiceControlBarProps = {
  isConnected?: boolean;
  isConnecting?: boolean;
  isMicEnabled?: boolean;
  isUserSpeaking?: boolean;
  isAgentSpeaking?: boolean;
  onMicPress?: () => void;
  onEndPress?: () => void;
  /** Omit to hide the interrupt control entirely. */
  onInterruptPress?: () => void;
  theme?: Partial<RealtimeVoiceTheme>;
  style?: ViewStyle;
};

export function VoiceControlBar({
  isConnected = false,
  isConnecting = false,
  isMicEnabled = true,
  isUserSpeaking = false,
  isAgentSpeaking = false,
  onMicPress,
  onEndPress,
  onInterruptPress,
  theme: themeOverride,
  style,
}: VoiceControlBarProps) {
  const theme = resolveTheme(themeOverride);
  // Reserve the left slot even when empty so the mic stays optically centred.
  const showInterrupt = Boolean(onInterruptPress) && isAgentSpeaking;

  return (
    <View style={[styles.row, style]}>
      <View style={styles.slot}>
        {showInterrupt ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Interrupt the assistant"
            onPress={onInterruptPress}
            style={({ pressed }) => [
              styles.secondary,
              {
                backgroundColor: theme.surface,
                borderColor: theme.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View style={[styles.stopGlyph, { backgroundColor: theme.text }]} />
          </Pressable>
        ) : null}
      </View>

      <MicButton
        isConnected={isConnected}
        isConnecting={isConnecting}
        isMicEnabled={isMicEnabled}
        isUserSpeaking={isUserSpeaking}
        isAgentSpeaking={isAgentSpeaking}
        onPress={onMicPress}
        theme={themeOverride}
      />

      <View style={styles.slot}>
        {isConnected && onEndPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="End voice conversation"
            onPress={onEndPress}
            style={({ pressed }) => [
              styles.secondary,
              {
                backgroundColor: theme.danger,
                borderColor: "transparent",
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View style={styles.closeGlyphWrapper}>
              <View
                style={[
                  styles.closeBar,
                  {
                    backgroundColor: theme.onAccent,
                    transform: [{ rotate: "45deg" }],
                  },
                ]}
              />
              <View
                style={[
                  styles.closeBar,
                  {
                    backgroundColor: theme.onAccent,
                    transform: [{ rotate: "-45deg" }],
                  },
                ]}
              />
            </View>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 32,
    paddingVertical: 16,
  },
  slot: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  secondary: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  stopGlyph: {
    width: 18,
    height: 18,
    borderRadius: 3,
  },
  closeGlyphWrapper: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  closeBar: {
    position: "absolute",
    width: 22,
    height: 2,
    borderRadius: 1,
  },
});
