/**
 * Supabase Edge Function: mint an ephemeral Realtime client secret.
 *
 * Deploy:
 *   supabase functions deploy realtime-token
 *   supabase secrets set OPENAI_API_KEY=sk-...
 *
 * The app calls this with the user's Supabase JWT; the OpenAI key stays here.
 *
 * NOTE: This file is a template, not part of the published package build.
 * Copy it into `supabase/functions/realtime-token/index.ts`.
 */

// @ts-nocheck — Deno globals; this runs on the edge runtime, not in the app.

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

/** Keep this short. The client re-mints transparently on reconnect. */
const TOKEN_TTL_SECONDS = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 1. Authenticate the caller. Without this, anyone can mint tokens against
  //    your OpenAI account — which is the whole problem ephemeral tokens solve.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  // 2. This is where you enforce your own limits — subscription tier, a daily
  //    minutes cap, abuse checks. Everything past this point costs you money.
  //
  // const allowed = await checkVoiceQuota(supabase, user.id);
  // if (!allowed) return json({ error: "Voice quota exceeded" }, 429);

  // 3. Mint. Model and voice are fixed here on purpose: the client cannot
  //    upgrade itself to a pricier model, and branding stays consistent.
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      // Hashed id helps OpenAI's abuse monitoring without leaking the real one.
      "OpenAI-Safety-Identifier": await sha256(user.id),
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: {
          output: { voice: "alloy" },
          input: {
            transcription: { model: "whisper-1" },
            noise_reduction: { type: "near_field" },
          },
        },
      },
      expires_after: { anchor: "created_at", seconds: TOKEN_TTL_SECONDS },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("client_secrets failed", response.status, detail);
    return json({ error: "Could not create voice session" }, 502);
  }

  // 4. Return OpenAI's response as-is — it is exactly the shape the client
  //    expects: { value, expires_at, session }.
  return json(await response.json(), 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
