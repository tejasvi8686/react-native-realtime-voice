/**
 * Zod → JSON Schema conversion for tool parameters, without depending on zod.
 *
 * `zod` is an optional peer dependency, so we cannot import it. Instead we walk
 * the schema's internal definition. Both zod 3 (`_def.typeName`) and zod 4
 * (`_zod.def.type`) layouts are handled, covering the subset that actually
 * appears in function-tool parameters. Anything exotic throws with a message
 * telling the consumer to pass plain JSON Schema instead.
 */

import type { JSONSchema } from "./types";

/** Anything exposing zod's `safeParse` can validate tool arguments at runtime. */
export type ParsableSchema = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: unknown } | { success: false; error: unknown };
};

type ZodLike = {
  _def?: Record<string, any>;
  _zod?: { def?: Record<string, any> };
};

export function isZodSchema(value: unknown): value is ZodLike & ParsableSchema {
  if (typeof value !== "object" || value === null) return false;
  const v = value as ZodLike & { safeParse?: unknown };
  return (
    typeof v.safeParse === "function" &&
    (typeof v._def === "object" || typeof v._zod === "object")
  );
}

export function isJSONSchema(value: unknown): value is JSONSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as JSONSchema).type === "string" &&
    !isZodSchema(value)
  );
}

/** Normalised view over zod 3 and zod 4 internals. */
type Def = {
  kind: string;
  raw: Record<string, any>;
  description?: string;
};

function readDef(schema: any): Def | null {
  // zod 4: schema._zod.def = { type: "object", shape: {...} }
  const v4 = schema?._zod?.def;
  if (v4 && typeof v4.type === "string") {
    return {
      kind: v4.type,
      raw: v4,
      description: schema.description ?? schema._zod?.def?.description,
    };
  }
  // zod 3: schema._def = { typeName: "ZodObject", shape: () => ({...}) }
  const v3 = schema?._def;
  if (v3 && typeof v3.typeName === "string") {
    return {
      kind: v3.typeName.replace(/^Zod/, "").toLowerCase(),
      raw: v3,
      description: v3.description,
    };
  }
  return null;
}

function readShape(def: Def): Record<string, any> {
  const shape = def.raw.shape;
  return typeof shape === "function" ? shape() : (shape ?? {});
}

function unwrapOptional(schema: any): { inner: any; optional: boolean } {
  let current = schema;
  let optional = false;
  // Peel optional/nullable/default/catch wrappers, which affect `required`
  // rather than the emitted type.
  for (let depth = 0; depth < 10; depth++) {
    const def = readDef(current);
    if (!def) break;
    if (
      def.kind === "optional" ||
      def.kind === "default" ||
      def.kind === "prefault" ||
      def.kind === "catch"
    ) {
      optional = true;
      current = def.raw.innerType ?? def.raw.type ?? current;
      continue;
    }
    if (def.kind === "nullable") {
      current = def.raw.innerType ?? def.raw.type ?? current;
      continue;
    }
    break;
  }
  return { inner: current, optional };
}

function convertNode(schema: any, path: string): JSONSchema {
  const { inner } = unwrapOptional(schema);
  const def = readDef(inner);
  if (!def) {
    throw new Error(
      `Could not read the zod definition at "${path}". Pass a plain JSON Schema object for this tool's parameters instead.`,
    );
  }

  const described = (out: JSONSchema): JSONSchema => {
    const description = inner.description ?? def.description;
    return description ? { ...out, description } : out;
  };

  switch (def.kind) {
    case "string": {
      const out: JSONSchema = { type: "string" };
      const checks: any[] = def.raw.checks ?? [];
      for (const check of checks) {
        const c = check?._zod?.def ?? check;
        if (c?.format === "email" || c?.kind === "email") out.format = "email";
        if (c?.format === "url" || c?.kind === "url") out.format = "uri";
      }
      return described(out);
    }
    case "number":
    case "int":
      return described({
        type: def.kind === "int" ? "integer" : "number",
      });
    case "bigint":
      return described({ type: "integer" });
    case "boolean":
      return described({ type: "boolean" });
    case "date":
      return described({ type: "string", format: "date-time" });
    case "literal": {
      const values = def.raw.values ?? [def.raw.value];
      const first = Array.isArray(values) ? values[0] : values;
      return described({
        type: typeof first === "number" ? "number" : "string",
        enum: Array.isArray(values) ? values : [values],
      });
    }
    case "enum": {
      const entries = def.raw.entries ?? def.raw.values;
      const values = Array.isArray(entries)
        ? entries
        : Object.values(entries ?? {});
      return described({ type: "string", enum: values });
    }
    case "nativeenum": {
      const values = Object.values(def.raw.values ?? {}).filter(
        (v) => typeof v === "string" || typeof v === "number",
      );
      return described({ type: "string", enum: values });
    }
    case "array": {
      const element = def.raw.element ?? def.raw.type ?? def.raw.valueType;
      return described({
        type: "array",
        items: convertNode(element, `${path}[]`),
      });
    }
    case "object":
      return described(convertObject(inner, path));
    case "union": {
      // Realtime tool params do not support anyOf reliably; collapse a union of
      // literals into an enum, which is the common case.
      const options: any[] = def.raw.options ?? [];
      const literals = options
        .map((o) => readDef(o))
        .filter((d): d is Def => d?.kind === "literal")
        .map((d) =>
          Array.isArray(d.raw.values) ? d.raw.values[0] : d.raw.value,
        );
      if (literals.length === options.length && literals.length > 0) {
        return described({ type: "string", enum: literals });
      }
      throw new Error(
        `Unions are only supported when every member is a literal (at "${path}"). Use z.enum(), or pass plain JSON Schema.`,
      );
    }
    case "record":
      return described({ type: "object", additionalProperties: true });
    case "any":
    case "unknown":
      return described({ type: "string" });
    default:
      throw new Error(
        `Unsupported zod type "${def.kind}" at "${path}". Pass a plain JSON Schema object for this tool's parameters instead.`,
      );
  }
}

function convertObject(schema: any, path: string): JSONSchema {
  const def = readDef(schema);
  if (!def || def.kind !== "object") {
    throw new Error(
      `Tool parameters must be an object schema (z.object({...})). Got "${def?.kind ?? "unknown"}" at "${path}".`,
    );
  }
  const shape = readShape(def);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const childPath = path ? `${path}.${key}` : key;
    properties[key] = convertNode(value, childPath);
    if (!unwrapOptional(value).optional) required.push(key);
  }

  return {
    type: "object",
    properties,
    required,
    // The Realtime API rejects unknown keys more predictably when this is set.
    additionalProperties: false,
  };
}

/**
 * Convert a zod object schema into the JSON Schema the Realtime API expects.
 * Throws a descriptive error for constructs outside the supported subset.
 */
export function zodToJSONSchema(schema: unknown): JSONSchema {
  return convertObject(schema, "");
}

/** Accepts either a zod schema or a ready-made JSON Schema. */
export function resolveParameters(parameters: unknown): {
  jsonSchema: JSONSchema;
  validator: ParsableSchema | null;
} {
  if (isZodSchema(parameters)) {
    return {
      jsonSchema: zodToJSONSchema(parameters),
      validator: parameters,
    };
  }
  if (isJSONSchema(parameters)) {
    return { jsonSchema: parameters, validator: null };
  }
  throw new Error(
    "Tool `parameters` must be a zod object schema or a JSON Schema object " +
      'shaped { type: "object", properties: {...} }.',
  );
}
