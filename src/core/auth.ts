/**
 * Credential resolution for the Realtime API.
 *
 * Two modes, deliberately asymmetric in ergonomics:
 *
 *   1. `ephemeral` (default, safe) — your backend mints a short-lived
 *      `ek_...` client secret and the device never sees your OpenAI key.
 *      The session config is baked into the token server-side, so the SDP
 *      exchange is a plain `Content-Type: application/sdp` POST.
 *
 *   2. `apiKey` (escape hatch, unsafe) — the raw `sk-...` key ships inside
 *      the app bundle, where anyone can extract it. Permitted for local
 *      development only, and it warns loudly every time it is used.
 */

import { RealtimeVoiceError } from "./errors";
import type { Logger } from "./logger";
import type { RealtimeSessionPayload } from "./types";

/** What your token endpoint should return. Matches OpenAI's response verbatim. */
export type EphemeralToken = {
  /** The `ek_...` secret the device sends to /v1/realtime/calls. */
  value: string;
  /** Unix seconds. Used to pre-emptively refresh before expiry. */
  expires_at?: number;
  session?: { id?: string; model?: string };
};

export type ResolvedCredential = {
  token: string;
  /**
   * `ephemeral` tokens already carry their session config, so the transport
   * posts bare SDP. `apiKey` must smuggle the config alongside the SDP in a
   * multipart body.
   */
  kind: "ephemeral" | "apiKey";
  expiresAt: number | null;
};

export type EphemeralAuthConfig = {
  /**
   * Fetch a fresh client secret from *your* backend. Called on every connect
   * and on refresh; do not cache inside this function — the provider does it.
   */
  getToken: () => Promise<EphemeralToken | string>;
  /**
   * Seconds before `expires_at` at which a cached token is considered stale.
   * Default 30.
   */
  refreshSkewSeconds?: number;
};

export type ApiKeyAuthConfig = {
  /**
   * A raw `sk-...` key. Ships in your bundle and is trivially extractable.
   * Guard it behind `__DEV__` and never ship it to production.
   */
  apiKey: string;
  /** Set true to silence the security warning. You are on your own. */
  dangerouslyAllowInProduction?: boolean;
};

export type AuthConfig = EphemeralAuthConfig | ApiKeyAuthConfig;

export function isApiKeyAuth(auth: AuthConfig): auth is ApiKeyAuthConfig {
  return typeof (auth as ApiKeyAuthConfig).apiKey === "string";
}

const OPENAI_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

/**
 * Resolves and caches credentials across reconnects.
 *
 * A single instance is owned by a session, so a reconnect inside the token's
 * validity window costs zero extra round-trips to your backend.
 */
export class CredentialProvider {
  private cached: ResolvedCredential | null = null;
  private inFlight: Promise<ResolvedCredential> | null = null;

  constructor(
    private readonly auth: AuthConfig,
    private readonly logger: Logger,
    private readonly isDev: boolean,
  ) {
    if (isApiKeyAuth(auth) && !auth.dangerouslyAllowInProduction && !isDev) {
      this.logger.warn(
        "auth.apiKey is being used outside development. Your OpenAI key is " +
          "embedded in this bundle and can be extracted from the shipped app. " +
          "Switch to ephemeral tokens (auth.getToken) before release.",
      );
    }
  }

  /** Returns a valid credential, minting or refreshing only when needed. */
  async resolve(force = false): Promise<ResolvedCredential> {
    if (!force && this.cached && !this.isExpired(this.cached)) {
      return this.cached;
    }
    // Collapse concurrent connect attempts onto one backend call.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchCredential()
      .then((credential) => {
        this.cached = credential;
        return credential;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private isExpired(credential: ResolvedCredential): boolean {
    if (credential.expiresAt == null) return false;
    const skew =
      (isApiKeyAuth(this.auth) ? 0 : (this.auth.refreshSkewSeconds ?? 30)) *
      1000;
    return Date.now() + skew >= credential.expiresAt;
  }

  private async fetchCredential(): Promise<ResolvedCredential> {
    if (isApiKeyAuth(this.auth)) {
      const key = this.auth.apiKey?.trim();
      if (!key) {
        throw new RealtimeVoiceError(
          "no-credentials",
          "auth.apiKey was empty. Provide a key, or switch to auth.getToken.",
        );
      }
      if (this.isDev) {
        this.logger.warn(
          "Connecting with a raw OpenAI API key. This is fine locally, but " +
            "ephemeral tokens are required for anything you ship.",
        );
      }
      return { token: key, kind: "apiKey", expiresAt: null };
    }

    let raw: EphemeralToken | string;
    try {
      raw = await this.auth.getToken();
    } catch (e) {
      throw new RealtimeVoiceError(
        "auth-failed",
        `auth.getToken() threw: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e, retryable: true },
      );
    }

    const token = typeof raw === "string" ? raw : raw?.value;
    if (!token || typeof token !== "string") {
      throw new RealtimeVoiceError(
        "auth-failed",
        "auth.getToken() must resolve to an ephemeral token string or an " +
          'object shaped { value: "ek_..." }.',
      );
    }
    if (token.startsWith("sk-")) {
      throw new RealtimeVoiceError(
        "auth-failed",
        "auth.getToken() returned a standard OpenAI API key (sk-...). It must " +
          "return a short-lived client secret (ek-...) minted by your backend " +
          "via POST /v1/realtime/client_secrets. If you really want to use a " +
          "raw key in development, pass { apiKey } instead.",
      );
    }

    const expiresAtSeconds =
      typeof raw === "string" ? undefined : raw?.expires_at;
    return {
      token,
      kind: "ephemeral",
      expiresAt: expiresAtSeconds ? expiresAtSeconds * 1000 : null,
    };
  }
}

/**
 * Server-side helper: mint an ephemeral client secret.
 *
 * Import this in a Node/Deno/edge runtime — never in the app. Exported so your
 * backend and your app agree on the session payload shape without duplicating it.
 *
 * @example
 * ```ts
 * // supabase/functions/realtime-token/index.ts
 * const token = await mintEphemeralToken({
 *   apiKey: Deno.env.get("OPENAI_API_KEY")!,
 *   session: { type: "realtime", model: "gpt-realtime", audio: { output: { voice: "alloy" } } },
 *   expiresAfterSeconds: 120,
 * });
 * ```
 */
export async function mintEphemeralToken(params: {
  apiKey: string;
  session: RealtimeSessionPayload;
  /** 10–7200, default 600. Keep it short; the client reconnects transparently. */
  expiresAfterSeconds?: number;
  /** Hashed user id forwarded to OpenAI for abuse monitoring. */
  safetyIdentifier?: string;
  fetchImpl?: typeof fetch;
}): Promise<EphemeralToken> {
  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(OPENAI_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      ...(params.safetyIdentifier
        ? { "OpenAI-Safety-Identifier": params.safetyIdentifier }
        : {}),
    },
    body: JSON.stringify({
      session: params.session,
      ...(params.expiresAfterSeconds
        ? {
            expires_after: {
              anchor: "created_at",
              seconds: params.expiresAfterSeconds,
            },
          }
        : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RealtimeVoiceError(
      "auth-failed",
      `Failed to mint ephemeral token (${response.status}): ${text || response.statusText}`,
    );
  }

  return (await response.json()) as EphemeralToken;
}
