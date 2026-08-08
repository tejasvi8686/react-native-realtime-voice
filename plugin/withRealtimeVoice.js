/**
 * Expo config plugin for realtime-voice.
 *
 * Applies the native configuration a WebRTC voice session needs, so consumers
 * do not have to hand-copy Info.plist keys and Android permissions:
 *
 *   - iOS  NSMicrophoneUsageDescription
 *   - iOS  UIBackgroundModes: audio  (opt-in, keeps a call alive when
 *          the app is backgrounded)
 *   - Android RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, INTERNET,
 *          ACCESS_NETWORK_STATE, BLUETOOTH (for headset routing)
 *
 * Usage in app.json:
 *
 *   ["realtime-voice", {
 *     "microphonePermission": "We use the mic so you can talk to your coach.",
 *     "backgroundAudio": false
 *   }]
 */

const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");

const DEFAULT_MIC_PERMISSION =
  "This app uses your microphone so you can speak with the voice assistant.";

const ANDROID_PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.BLUETOOTH",
];

function withMicrophonePermission(config, props) {
  return withInfoPlist(config, (cfg) => {
    // Respect an existing description rather than clobbering the app's own copy.
    if (!cfg.modResults.NSMicrophoneUsageDescription) {
      cfg.modResults.NSMicrophoneUsageDescription =
        props.microphonePermission || DEFAULT_MIC_PERMISSION;
    }

    if (props.backgroundAudio) {
      const modes = new Set(cfg.modResults.UIBackgroundModes || []);
      modes.add("audio");
      cfg.modResults.UIBackgroundModes = [...modes];
    }

    return cfg;
  });
}

function withAudioPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    AndroidConfig.Permissions.ensurePermissions(cfg.modResults, ANDROID_PERMISSIONS);
    return cfg;
  });
}

/**
 * @param {object} config Expo config
 * @param {{ microphonePermission?: string, backgroundAudio?: boolean }} props
 */
function withRealtimeVoice(config, props = {}) {
  let next = withMicrophonePermission(config, props);
  next = withAudioPermissions(next);
  return next;
}

module.exports = createRunOncePlugin(
  withRealtimeVoice,
  "realtime-voice",
  "0.1.0",
);
