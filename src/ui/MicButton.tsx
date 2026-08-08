/**
 * Primary call control.
 *
 * One button covering the whole lifecycle: connect → mute/unmute → (busy).
 * Glyphs are drawn with plain Views so the kit needs no icon library.
 */

import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { resolveTheme, statusColor, type RealtimeVoiceTheme } from "./theme";

export type MicButtonProps = {
  isConnected?: boolean;
  isConnecting?: boolean;
  isMicEnabled?: boolean;
  isUserSpeaking?: boolean;
  isAgentSpeaking?: boolean;
  onPress?: () => void;
  size?: number;
  disabled?: boolean;
  theme?: Partial<RealtimeVoiceTheme>;
  style?: ViewStyle;
  accessibilityLabel?: string;
};

export function MicButton({
  isConnected = false,
  isConnecting = false,
  isMicEnabled = true,
  isUserSpeaking = false,
  isAgentSpeaking = false,
  onPress,
  size = 72,
  disabled = false,
  theme: themeOverride,
  style,
  accessibilityLabel,
}: MicButtonProps) {
  const theme = resolveTheme(themeOverride);
  const muted = isConnected && !isMicEnabled;
  const background = muted
    ? theme.idle
    : statusColor(theme, { isUserSpeaking, isAgentSpeaking, isConnected });

  const label =
    accessibilityLabel ??
    (isConnecting
      ? "Connecting"
      : !isConnected
        ? "Start voice conversation"
        : muted
          ? "Unmute microphone"
          : "Mute microphone");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || isConnecting, selected: !muted }}
      disabled={disabled || isConnecting}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {isConnecting ? (
        <ActivityIndicator color={theme.onAccent} />
      ) : muted ? (
        <MicOffGlyph color={theme.onAccent} size={size * 0.42} />
      ) : (
        <MicGlyph color={theme.onAccent} size={size * 0.42} />
      )}
    </Pressable>
  );
}

function MicGlyph({ color, size }: { color: string; size: number }) {
  const capsuleWidth = size * 0.42;
  return (
    <View style={{ alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: capsuleWidth,
          height: size * 0.58,
          borderRadius: capsuleWidth / 2,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.72,
          height: size * 0.3,
          borderBottomLeftRadius: size * 0.36,
          borderBottomRightRadius: size * 0.36,
          borderWidth: size * 0.09,
          borderTopWidth: 0,
          borderColor: color,
          marginTop: size * 0.06,
        }}
      />
      <View
        style={{
          width: size * 0.09,
          height: size * 0.14,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function MicOffGlyph({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center" }}>
      <MicGlyph color={color} size={size} />
      <View
        style={{
          position: "absolute",
          width: size * 1.25,
          height: Math.max(2, size * 0.09),
          backgroundColor: color,
          transform: [{ rotate: "-45deg" }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
  },
});
