/**
 * Express: mint an ephemeral Realtime client secret.
 *
 * NOTE: Template, not part of the published package build.
 */

// @ts-nocheck — depends on your app's express/auth setup.

import express from "express";
import { mintEphemeralToken } from "realtime-voice";

const app = express();

/** Keep this short. The client re-mints transparently on reconnect. */
const TOKEN_TTL_SECONDS = 120;

app.post("/api/realtime-token", requireAuth, async (req, res) => {
  try {
    // Everything past this point costs money — enforce your own quota here.
    // if (!(await hasVoiceQuota(req.user.id))) {
    //   return res.status(429).json({ error: "Voice quota exceeded" });
    // }

    const token = await mintEphemeralToken({
      apiKey: process.env.OPENAI_API_KEY!,
      // Model and voice are fixed server-side so the client cannot upgrade
      // itself to a pricier model or change the brand voice.
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: {
          output: { voice: "alloy" },
          input: { transcription: { model: "whisper-1" } },
        },
      },
      expiresAfterSeconds: TOKEN_TTL_SECONDS,
      safetyIdentifier: hash(req.user.id),
    });

    // Shape is { value, expires_at, session } — exactly what the client wants.
    res.json(token);
  } catch (error) {
    console.error("Failed to mint realtime token", error);
    res.status(502).json({ error: "Could not create voice session" });
  }
});

export default app;
