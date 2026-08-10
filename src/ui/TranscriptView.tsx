/**
 * Scrolling transcript with live-updating partials.
 */

import { useRef } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";

import type { TranscriptItem } from "../core/types";
import { resolveTheme, type RealtimeVoiceTheme } from "./theme";

export type TranscriptViewProps = {
  transcripts: TranscriptItem[];
  /** Render as chat bubbles, or as a single flowing caption. Default "bubbles". */
  variant?: "bubbles" | "caption";
  /** Hide interim (non-final) items. Default false. */
  finalOnly?: boolean;
  theme?: Partial<RealtimeVoiceTheme>;
  style?: ViewStyle;
  contentContainerStyle?: ViewStyle;
  emptyText?: string;
};

export function TranscriptView({
  transcripts,
  variant = "bubbles",
  finalOnly = false,
  theme: themeOverride,
  style,
  contentContainerStyle,
  emptyText,
}: TranscriptViewProps) {
  const theme = resolveTheme(themeOverride);
  const scrollRef = useRef<ScrollView>(null);
  const items = finalOnly ? transcripts.filter((t) => t.isFinal) : transcripts;

  if (items.length === 0 && emptyText) {
    return (
      <View style={[styles.empty, style]}>
        <Text
          style={[
            styles.emptyText,
            { color: theme.textMuted, fontFamily: theme.fontFamily },
          ]}
        >
          {emptyText}
        </Text>
      </View>
    );
  }

  if (variant === "caption") {
    const latest = items[items.length - 1];
    return (
      <View style={[styles.caption, style]}>
        <Text
          style={[
            styles.captionText,
            { color: theme.text, fontFamily: theme.fontFamily },
          ]}
        >
          {latest?.text ?? ""}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={style}
      contentContainerStyle={[styles.list, contentContainerStyle]}
      onContentSizeChange={() =>
        scrollRef.current?.scrollToEnd({ animated: true })
      }
      showsVerticalScrollIndicator={false}
    >
      {items.map((item) => {
        const isUser = item.role === "user";
        return (
          <View
            key={item.id}
            style={[
              styles.bubble,
              {
                alignSelf: isUser ? "flex-end" : "flex-start",
                backgroundColor: isUser ? theme.accent : theme.surface,
                borderColor: isUser ? "transparent" : theme.border,
                borderRadius: theme.radius,
                // Interim text is dimmed so users can tell it may still change.
                opacity: item.isFinal ? 1 : 0.65,
              },
            ]}
          >
            <Text
              style={[
                styles.bubbleText,
                {
                  color: isUser ? theme.onAccent : theme.text,
                  fontFamily: theme.fontFamily,
                },
              ]}
            >
              {item.text}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  caption: {
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  captionText: {
    fontSize: 20,
    lineHeight: 28,
    textAlign: "center",
  },
  empty: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center",
  },
});
