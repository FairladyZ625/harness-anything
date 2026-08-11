// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePlatformSmoke } from "../platform-smoke.mjs";
import { makeRepo } from "./helpers.mjs";

test("G20 resolves the real package bin and cold-starts help without daemon state", () => {
  const { rootDir } = makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/index.js" } }),
    "packages/cli/dist/index.js": [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "if (process.env.HARNESS_DAEMON_MODE !== 'direct') { mkdirSync(process.env.HARNESS_DAEMON_USER_ROOT, { recursive: true }); writeFileSync(`${process.env.HARNESS_DAEMON_USER_ROOT}/started`, '1'); }",
      "console.log('Usage: ha <command>');"
    ].join("\n")
  });
  const result = evaluatePlatformSmoke(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.match(result.checks.join("\n"), /parseable.*without daemon state/su);
});

test("G20 fails when the declared CLI entrypoint is unresolved", () => {
  const { rootDir } = makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/missing.js" } })
  });
  const result = evaluatePlatformSmoke(rootDir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /bin target is not built/u);
});
