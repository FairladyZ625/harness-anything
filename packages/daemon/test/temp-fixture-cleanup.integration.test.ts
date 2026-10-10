// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const gateFixture = pathToFileURL(path.resolve(import.meta.dirname, "../../../tools/gates/test/helpers.mjs")).href,
  keycloakFixture = pathToFileURL(path.join(import.meta.dirname, "keycloak.fixtures.ts")).href;

for (const outcome of ["normal", "failure", "timeout"] as const) {
  test(`temporary fixture directories are released after ${outcome}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-cleanup-control-")),
      temporary = path.join(root, "temporary"),
      script = path.join(root, "control.test.mjs");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(temporary);
    writeFileSync(
      script,
      `import test from "node:test";
import { makeRepo } from ${JSON.stringify(gateFixture)};
import { keycloakUserRoot } from ${JSON.stringify(keycloakFixture)};
test("cleanup control", { timeout: 50 }, async (t) => {
  makeRepo({ "fixture.txt": "fixture" });
  const user = keycloakUserRoot();
  t.after(user.cleanup);
  console.log("fixtures-created");
  if (${JSON.stringify(outcome)} === "failure") throw new Error("intentional cleanup failure");
  if (${JSON.stringify(outcome)} === "timeout") {
    const timer = setInterval(() => {}, 1000);
    t.after(() => clearInterval(timer));
    await new Promise(() => {});
  }
});
`,
    );
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", script], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    console.log(result.stdout, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /fixtures-created/u);
    assert.equal(result.status, outcome === "normal" ? 0 : 1, result.stdout + result.stderr);
    if (outcome === "failure") assert.match(result.stdout, /intentional cleanup failure/u);
    if (outcome === "timeout") assert.match(result.stdout, /test timed out after 50ms/u);
    const remaining = readdirSync(temporary);
    console.log(`cleanup-count outcome=${outcome} before=0 after=${remaining.length}`);
    assert.deepEqual(remaining, []);
  });
}
