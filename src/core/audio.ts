/**
 * Audio      routing.
 *
 * On a phone, a WebRTC voice call defaults to the earpiece — the user has to
 * hold the device to their ear to hear the agent. Routing to the loudspeaker is
 * almost always what a voice assistant wants, but it must be reversible and
 * skippable, so it lives behind an interface rather than being inlined in the
 * connection callback.
 */

import type { Logger } from "./logger";

export interface AudioRouter {
  /** Called once the peer connection is established. */
  activate(): void;
  /** Called on disconnect. Must be safe to call when never activated. */
  deactivate(): void;
  setSpeakerphone(enabled: boolean): void;
}

export const noopAudioRouter: AudioRouter = {
  activate: () => {},
  deactivate: () => {},
  setSpeakerphone: () => {},
};

/**
 * Structural match for `react-native-incall-manager`'s default export.
 *
 * These mirror that module's real signatures rather than a convenient
 * approximation. `start` takes an *optional* setup object whose `media` is a
 * literal union; declaring it as a required `{ media: string }` meant the real
 * module failed to type-check against this under strictFunctionTypes, which is
 * the default in any app extending expo/tsconfig.base.
 */
export type InCallManagerLike = {
  start: (setup?: {
    auto?: boolean;
    media?: "video" | "audio";
    ringback?: string;
  }) => void;
  stop: (setup?: { busytone?: string }) => void;
  setSpeakerphoneOn: (enabled: boolean) => void;
  setForceSpeakerphoneOn: (enabled: boolean) => void;
};

/**
 * Router backed by `react-native-incall-manager`.
 *
 * The module is injected rather than imported so the package does not force the
 * dependency on consumers who route audio themselves.
 */
export function createInCallAudioRouter(params: {
  inCallManager: InCallManagerLike;
  logger: Logger;
  speakerphone?: boolean;
}): AudioRouter {
  const { inCallManager, logger } = params;
  const speakerphone = params.speakerphone ?? true;
  let active = false;

  return {
    activate() {
      if (active) return;
      try {
        inCallManager.start({ media: "audio" });
        if (speakerphone) {
          inCallManager.setSpeakerphoneOn(true);
          inCallManager.setForceSpeakerphoneOn(true);
        }
        active = true;
      } catch (e) {
        logger.warn("Audio routing failed; falling back to system default.", e);
      }
    },
    deactivate() {
      if (!active) return;
      try {
        inCallManager.setForceSpeakerphoneOn(false);
        inCallManager.stop();
      } catch (e) {
        logger.warn("Audio routing teardown failed.", e);
      }
      active = false;
    },
    setSpeakerphone(enabled: boolean) {
      try {
        inCallManager.setSpeakerphoneOn(enabled);
        inCallManager.setForceSpeakerphoneOn(enabled);
      } catch (e) {
        logger.warn("Could not toggle speakerphone.", e);
      }
    },
  };
}
