/**
 * Animated status orb.
 *
 * Built on React Native's own `Animated` (native driver) rather than
 * Reanimated, so the UI kit adds no peer dependencies.
 */

import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View, type ViewStyle } from "react-native";

import { resolveTheme, statusColor, type RealtimeVoiceTheme } from "./theme";

export type VoiceOrbProps = {
  isConnected?: boolean;
  isConnecting?: boolean;
  isUserSpeaking?: boolean;
  isAgentSpeaking?: boolean;
  size?: number;
  /** Number of expanding rings. 0 disables them. Default 3. */
  ringCount?: number;
  theme?: Partial<RealtimeVoiceTheme>;
  style?: ViewStyle;
  children?: React.ReactNode;
};

const RING_DURATION = 2000;

export function VoiceOrb({
  isConnected = false,
  isConnecting = false,
  isUserSpeaking = false,
  isAgentSpeaking = false,
  size = 96,
  ringCount = 3,
  theme: themeOverride,
  style,
  children,
}: VoiceOrbProps) {
  const theme = resolveTheme(themeOverride);
  const active = isUserSpeaking || isAgentSpeaking || isConnecting;
  const color = statusColor(theme, { isUserSpeaking, isAgentSpeaking, isConnected });

  const breathe = useRef(new Animated.Value(0)).current;
  // One shared value per ring, staggered by index.
  const rings = useRef(
    Array.from({ length: Math.max(0, ringCount) }, () => new Animated.Value(0)),
  ).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: isAgentSpeaking ? 600 : 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: isAgentSpeaking ? 600 : 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [breathe, isAgentSpeaking]);

  useEffect(() => {
    if (!active || rings.length === 0) {
      rings.forEach((ring) => ring.setValue(0));
      return;
    }
    const animations = rings.map((ring, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((RING_DURATION / rings.length) * index),
          Animated.timing(ring, {
            toValue: 1,
            duration: RING_DURATION,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    animations.forEach((a) => a.start());
    return () => {
      animations.forEach((a) => a.stop());
      rings.forEach((ring) => ring.setValue(0));
    };
  }, [active, rings]);

  const coreScale = breathe.interpolate({
    inputRange: [0, 1],
    outputRange: [1, isAgentSpeaking ? 1.14 : 1.05],
  });

  return (
    <View
      style={[styles.container, { width: size * 2, height: size * 2 }, style]}
      pointerEvents="box-none"
    >
      {active &&
        rings.map((ring, index) => (
          <Animated.View
            key={index}
            pointerEvents="none"
            style={[
              styles.ring,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
                borderColor: color,
                opacity: ring.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.55, 0],
                }),
                transform: [
                  {
                    scale: ring.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 2],
                    }),
                  },
                ],
              },
            ]}
          />
        ))}

      <Animated.View
        style={[
          styles.core,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            transform: [{ scale: coreScale }],
          },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    borderWidth: 2,
  },
  core: {
    alignItems: "center",
    justifyContent: "center",
  },
});
