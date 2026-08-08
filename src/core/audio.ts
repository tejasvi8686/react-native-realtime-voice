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

export type InCallManagerLike = {
  start: (options: { media: string; auto?: boolean }) => void;
  stop: () => void;
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
