const { z } = require("zod");
const { zodToJSONSchema, defineTool } = require("../lib/commonjs/index.js");

const schema = z.object({
  amount_ml: z.number().describe("Amount of water in millilitres, e.g. 250"),
  mode: z.enum(["today", "yesterday", "week"]).optional(),
  note: z.string().optional(),
  tags: z.array(z.string()),
  confirm: z.boolean().default(false),
});

console.log("--- zod v3 classic (z from 'zod') ---");
console.log(JSON.stringify(zodToJSONSchema(schema), null, 2));

const tool = defineTool({
  name: "log_water",
  description: "Log water intake.",
  parameters: schema,
  handler: async (args) => ({ ok: true, args }),
});
console.log(
  "\nvalidator valid  :",
  JSON.stringify(tool.validator.safeParse({ amount_ml: 250, tags: [] })),
);
console.log(
  "validator invalid:",
  tool.validator.safeParse({ amount_ml: "lots", tags: [] }).success,
);

// zod 4 layout, shipped inside zod 3.25 at the /v4 subpath
const z4 = require("zod/v4");
const schema4 = z4.object({
  amount_ml: z4.number().describe("millilitres"),
  mode: z4.enum(["today", "week"]).optional(),
  tags: z4.array(z4.string()),
});
console.log("\n--- zod v4 layout ---");
console.log(JSON.stringify(zodToJSONSchema(schema4), null, 2));

console.log("\n--- plain JSON Schema passthrough ---");
const plain = defineTool({
  name: "no_args",
  description: "d",
  parameters: { type: "object", properties: {}, required: [] },
  handler: () => ({}),
});
console.log(JSON.stringify(plain.parameters), "validator:", plain.validator);
