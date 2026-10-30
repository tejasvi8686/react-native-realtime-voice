/**
 * Tool definition and execution.
 *
 * A tool owns its schema *and* its handler. This is the main departure from the
 * pattern where schemas live in one file and a `switch` over tool names lives in
 * a screen — there, adding a tool means editing two layers and nothing checks
 * that they agree.
 */

import { RealtimeVoiceError } from "./errors";
import type { Logger } from "./logger";
import { resolveParameters, type ParsableSchema } from "./schema";
import type { JSONSchema, RealtimeFunctionTool } from "./types";

/** Passed to every handler so tools can react to cancellation. */
export type ToolContext = {
  /**
   * Aborted when the session disconnects or this call times out. Not aborted
   * by `interrupt()`: cutting the agent off mid-sentence should not cancel an
   * action the user already asked for.
   */
  signal: AbortSignal;
  /** OpenAI's id for this invocation. */
  callId: string;
  /** Send a client event on the live data channel (advanced). */
  send: (event: Record<string, unknown>) => void;
};

/**
 * Infers handler argument types from a zod schema when one is supplied,
 * falling back to the explicit generic otherwise.
 */
type InferArgs<TParams, TFallback> = TParams extends {
  safeParse: (v: unknown) => any;
}
  ? TParams extends { _output: infer O }
    ? O
    : TParams extends { _zod: { output: infer O } }
      ? O
      : TFallback
  : TFallback;

export type ToolDefinition<TArgs = Record<string, unknown>> = {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: (args: TArgs, ctx: ToolContext) => Promise<unknown> | unknown;
  /** Runtime arg validation, present when `parameters` was a zod schema. */
  validator: ParsableSchema | null;
  /** Abandon the call after this long and report the failure to the model. */
  timeoutMs: number;
};

export type DefineToolConfig<TParams, TArgs> = {
  /** Snake_case, stable. The model refers to the tool by this name. */
  name: string;
  /**
   * Tell the model *when* to call this, not just what it does — description
   * quality is the single biggest driver of tool-selection accuracy.
   */
  description: string;
  /** A zod object schema, or a plain JSON Schema object. */
  parameters: TParams;
  handler: (
    args: InferArgs<TParams, TArgs>,
    ctx: ToolContext,
  ) => Promise<unknown> | unknown;
  /** Default 10000. */
  timeoutMs?: number;
};

/**
 * Define a tool the voice agent can call.
 *
 * @example Zod (argument types inferred)
 * ```ts
 * defineTool({
 *   name: "log_water",
 *   description: "Log water the user says they drank. Amount is in millilitres.",
 *   parameters: z.object({ amount_ml: z.number().describe("e.g. 250, 500") }),
 *   handler: async ({ amount_ml }) => {           // amount_ml: number
 *     await api.logWater(amount_ml);
 *     return { logged: amount_ml };
 *   },
 * });
 * ```
 *
 * @example Plain JSON Schema (no zod needed)
 * ```ts
 * defineTool<{ amount_ml: number }>({
 *   name: "log_water",
 *   description: "...",
 *   parameters: {
 *     type: "object",
 *     properties: { amount_ml: { type: "number" } },
 *     required: ["amount_ml"],
 *   },
 *   handler: async ({ amount_ml }) => ({ logged: amount_ml }),
 * });
 * ```
 */
export function defineTool<TArgs = Record<string, unknown>, TParams = unknown>(
  config: DefineToolConfig<TParams, TArgs>,
): ToolDefinition<any> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.name)) {
    throw new Error(
      `Invalid tool name "${config.name}". Use 1–64 characters of [a-zA-Z0-9_-].`,
    );
  }
  const { jsonSchema, validator } = resolveParameters(config.parameters);
  return {
    name: config.name,
    description: config.description,
    parameters: jsonSchema,
    handler: config.handler as ToolDefinition<any>["handler"],
    validator,
    timeoutMs: config.timeoutMs ?? 10_000,
  };
}

export type ToolResult = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  output: unknown;
  ok: boolean;
  durationMs: number;
};

/**
 * Owns the tool set for a session: wire-format serialisation, argument
 * validation, de-duplication of repeated `call_id`s, and timeouts.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>();
  /** call_ids already executed. Bounded so a long session cannot leak memory. */
  private handledCallIds: string[] = [];
  private handledCallIdSet = new Set<string>();
  private static readonly MAX_TRACKED_CALLS = 200;

  constructor(
    tools: ToolDefinition<any>[] = [],
    private readonly logger: Logger,
  ) {
    this.replace(tools);
  }

  replace(tools: ToolDefinition<any>[]): void {
    this.tools.clear();
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}".`);
      }
      this.tools.set(tool.name, tool);
    }
    if (this.tools.size > 20) {
      this.logger.warn(
        `${this.tools.size} tools registered. Selection accuracy degrades past ~20; consider consolidating.`,
      );
    }
  }

  get size(): number {
    return this.tools.size;
  }

  /** Serialise for `session.update`. */
  toWireFormat(): RealtimeFunctionTool[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private markHandled(callId: string): void {
    this.handledCallIdSet.add(callId);
    this.handledCallIds.push(callId);
    if (this.handledCallIds.length > ToolRegistry.MAX_TRACKED_CALLS) {
      const evicted = this.handledCallIds.shift();
      if (evicted) this.handledCallIdSet.delete(evicted);
    }
  }

  reset(): void {
    this.handledCallIds = [];
    this.handledCallIdSet.clear();
  }

  /**
   * Execute a tool call. Returns null when the call is a duplicate and should
   * be ignored entirely.
   */
  async execute(params: {
    callId: string;
    name: string;
    rawArguments: string | undefined;
    signal: AbortSignal;
    send: (event: Record<string, unknown>) => void;
  }): Promise<ToolResult | null> {
    const { callId, name, rawArguments, signal, send } = params;

    if (this.handledCallIdSet.has(callId)) {
      this.logger.debug(`Ignoring duplicate tool call ${name} (${callId})`);
      return null;
    }
    this.markHandled(callId);

    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn(`Model called unregistered tool "${name}"`);
      return {
        callId,
        name,
        args: {},
        ok: false,
        output: { error: `Unknown tool "${name}".` },
        durationMs: Date.now() - startedAt,
      };
    }

    let args: Record<string, unknown> = {};
    if (typeof rawArguments === "string" && rawArguments.trim()) {
      try {
        args = JSON.parse(rawArguments) as Record<string, unknown>;
      } catch {
        return {
          callId,
          name,
          args: {},
          ok: false,
          output: {
            error: "Arguments were not valid JSON. Try calling again.",
          },
          durationMs: Date.now() - startedAt,
        };
      }
    }

    if (tool.validator) {
      const parsed = tool.validator.safeParse(args);
      if (!parsed.success) {
        // Hand the model a correctable message rather than throwing.
        return {
          callId,
          name,
          args,
          ok: false,
          output: {
            error: "Arguments did not match the expected schema.",
            details: describeValidationError(parsed.error),
          },
          durationMs: Date.now() - startedAt,
        };
      }
      args = parsed.data as Record<string, unknown>;
    }

    this.logger.debug(`Executing tool ${name}`, args);

    // Each call gets its own signal: it follows the session's, and also fires
    // when this call times out, so an abandoned handler can stop its work.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort);

    try {
      const output = await withTimeout(
        Promise.resolve(
          tool.handler(args, { signal: controller.signal, callId, send }),
        ),
        tool.timeoutMs,
        name,
        abort,
      );
      return {
        callId,
        name,
        args,
        ok: true,
        output: output ?? {},
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Tool ${name} failed: ${message}`);
      return {
        callId,
        name,
        args,
        ok: false,
        output: { error: message },
        durationMs: Date.now() - startedAt,
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
  onTimeout: () => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(
        new RealtimeVoiceError(
          "tool-timeout",
          `Tool "${toolName}" did not resolve within ${ms}ms.`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeValidationError(error: unknown): string {
  const issues = (
    error as { issues?: { path?: (string | number)[]; message?: string }[] }
  )?.issues;
  if (!Array.isArray(issues)) return "Invalid arguments.";
  return issues
    .slice(0, 5)
    .map(
      (i) =>
        `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`,
    )
    .join("; ");
}
