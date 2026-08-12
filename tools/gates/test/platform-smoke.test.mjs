// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePlatformSmoke } from "../platform-smoke.mjs";
import { makeRepo } from "./helpers.mjs";

test("G20 resolves the real package bin and cold-starts help without daemon state", () => {
  const { rootDir } = makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/index.js" } }),
    "packages/cli/dist/index.js": [
      "const a=process.argv.slice(2), c=a[a.indexOf('daemon')+1];",
      "if(a.includes('--help')) console.log('Usage: ha <command>');",
      "else { const code=c==='start'?'service_required':'daemon_unavailable'; console.log(JSON.stringify({code})); process.exitCode=1; }"
    ].join("\n")
  });
  const result = evaluatePlatformSmoke(rootDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.match(result.checks.join("\n"), /parseable.*without daemon state/su);
});

test("G20 daemon start status stop fail closed without platform-specific process behavior", () => {
  const { rootDir } = makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/index.js" } }),
    "packages/cli/dist/index.js": `const a=process.argv.slice(2),c=a[a.indexOf("daemon")+1];if(a.includes("--help"))console.log("Usage: ha");else{const code=c==="start"?"service_required":"daemon_unavailable";console.log(JSON.stringify({code}));process.exitCode=1}`
  });
  const result = evaluatePlatformSmoke(rootDir); assert.equal(result.ok, true, result.errors.join("\n"));
  assert.match(result.checks.join("\n"), /daemon start fails closed.*daemon status fails closed.*daemon stop fails closed/su);
});

test("G20 fails when the declared CLI entrypoint is unresolved", () => {
  const { rootDir } = makeRepo({
    "packages/cli/package.json": JSON.stringify({ type: "module", bin: { ha: "dist/missing.js" } })
  });
  const result = evaluatePlatformSmoke(rootDir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /bin target is not built/u);
});
