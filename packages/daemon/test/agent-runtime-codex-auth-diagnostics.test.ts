// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/daemon-host/agent-runtime-instances.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instance-types.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

// Codex subscription probes stay strictly read-only (`codex login status` + read-only quota
// routes): a missing/signed-out login reports `runtime_subscription_required`, while a locally
// ready login NEVER falls through to `codex exec` active inference when read-only quota routes
// fail or return 401/429.
test("a codex auth probe stays read-only, maps signed-out status, and never invokes codex exec on quota failure", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-codex-auth-diagnostics-")),
    home = path.join(parent, "home"),
    userRoot = path.join(parent, "user"),
    authFile = path.join(home, ".codex", "auth.json"),
    execMarker = path.join(parent, "exec-called"),
    fakeToken = "fake-refresh-token-never-echoed";
  try {
    mkdirSync(path.dirname(authFile), { recursive: true });
    const executablePath = writeProviderExecutable(
      path.join(parent, "codex"),
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const auth = JSON.parse(fs.readFileSync(${JSON.stringify(authFile)}, "utf8"));
if (args[0] === "login" && args[1] === "status") {
  if (auth.tokens && auth.tokens.refresh_token) { console.log("Logged in using ChatGPT"); process.exit(0); }
  process.exit(1);
}
if (args[0] === "exec") {
  fs.writeFileSync(${JSON.stringify(execMarker)}, "called");
  process.exit(99);
}
process.exit(9);
`,
    );
    let quotaStatus = 401;
    const installation: RuntimeInstallationWitness = {
        installationId: "codex-auth-diagnostics",
        kindId: "codex",
        executablePath,
        version: "0.159.3",
        observedAt: "2026-11-10T00:00:00.000Z",
      },
      store = openRuntimeInstanceStore({
        userRoot,
        env: {
          HOME: home,
          PATH: [path.dirname(executablePath), process.env.PATH].filter(Boolean).join(path.delimiter),
        },
        discover: () => [installation],
        quotaFetch: async () => new Response(JSON.stringify({ error: fakeToken }), { status: quotaStatus }),
      });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-auth-diagnostics",
      name: "Codex auth diagnostics",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "operator-environment",
      codex: {},
      auth: { mode: "subscription" },
    });

    // Signed-out login status maps to runtime_subscription_required.
    writeFileSync(authFile, JSON.stringify({ tokens: {} }));
    const signedOut = await store.authStatus("codex-auth-diagnostics");
    assert.equal(signedOut.code, "runtime_subscription_required", JSON.stringify(signedOut));

    // When login status is ready and both read-only routes fail (RPC exit 9, OAuth 401/429/503),
    // readiness stays ready, zero codex exec calls run, and tokens never leak.
    for (const status of [401, 429, 503]) {
      quotaStatus = status;
      writeFileSync(
        authFile,
        JSON.stringify({ tokens: { refresh_token: `${fakeToken}:${status}`, access_token: `${fakeToken}-access` } }),
      );
      const readiness = await store.authStatus("codex-auth-diagnostics");
      assert.deepEqual(readiness, { status: "ready", code: null, hint: null, basis: "metadata" });
      assert.doesNotMatch(
        JSON.stringify(readiness),
        new RegExp(fakeToken, "u"),
        "a credential value must never be echoed",
      );
    }
    assert.throws(() => readFileSync(execMarker, "utf8"), /ENOENT/u);
  } finally {
    removeTempRepository(parent);
  }
});
