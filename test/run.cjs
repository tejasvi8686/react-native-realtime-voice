/**
 * Test runner.
 *
 * Each suite runs in its own process because they install conflicting global
 * `fetch` stubs and register different fake WebRTC modules.
 *
 * Run against the built output: `npm run build && npm test`.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const SUITES = ["schema.test.cjs", "session.test.cjs", "auth.test.cjs"];

const lib = path.join(__dirname, "..", "lib", "commonjs", "index.js");
if (!fs.existsSync(lib)) {
  console.error("Build output missing. Run `npm run build` first.");
  process.exit(1);
}

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n──── ${suite} ${"─".repeat(Math.max(0, 50 - suite.length))}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], {
      stdio: "inherit",
      cwd: __dirname,
    });
  } catch {
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed.`);
  process.exit(1);
}
console.log("\nAll suites passed.");
