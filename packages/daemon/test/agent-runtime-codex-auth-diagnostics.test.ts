// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// `codex login status` only proves a refresh token is on disk; the provider can still
// reject that token when a real request runs. Each scenario below feeds the exact
// upstream wording through the one probe path and asserts the daemon names the cause
// and the next action instead of collapsing everything into "did not complete".
test("a codex auth probe maps revoked, expired, signed-out, and network failures to named readiness codes", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-codex-auth-diagnostics-")),
    home = path.join(parent, "home"),
    userRoot = path.join(parent, "user"),
    authFile = path.join(home, ".codex", "auth.json"),
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
  const scenario = auth.tokens.refresh_token.split(":").pop();
  if (scenario === "revoked") {
    console.log(JSON.stringify({ type: "turn.failed", error: {
      code: "refresh_token_revoked",
      message: "refresh token was revoked. Please log out and sign in again"
    } }));
    process.exit(1);
  }
  if (scenario === "expired") {
    console.log(JSON.stringify({ type: "turn.failed", error: {
      code: "refresh_token_expired",
      message: "Your access token could not be refreshed. Please log out and sign in again."
    } }));
    process.exit(1);
  }
  if (scenario === "signed-out") {
    console.log(JSON.stringify({ type: "error", message: "ChatGPT login is required; no credentials are configured" }));
    process.exit(1);
  }
  if (scenario === "network") {
    console.error("stream disconnected before completion: connection refused (ECONNREFUSED 127.0.0.1:1)");
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "unexpected daemon diagnostic" } }));
  process.exit(1);
}
process.exit(9);
`,
    );
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
    const probe = async (scenario: string) => {
      writeFileSync(
        authFile,
        JSON.stringify({ tokens: { refresh_token: `${fakeToken}:${scenario}`, access_token: `${fakeToken}-access` } }),
      );
      const readiness = await store.authStatus("codex-auth-diagnostics");
      assert.doesNotMatch(
        JSON.stringify(readiness),
        new RegExp(fakeToken, "u"),
        "a credential value must never be echoed",
      );
      return readiness;
    };

    const revoked = await probe("revoked");
    assert.equal(revoked.code, "runtime_refresh_token_invalid", JSON.stringify(revoked));
    assert.match(revoked.hint ?? "", /invalid, revoked, or has expired/u);
    assert.match(revoked.hint ?? "", /ha runtime instance login/u);

    const expired = await probe("expired");
    assert.equal(expired.code, "runtime_refresh_token_invalid", JSON.stringify(expired));
    assert.match(expired.hint ?? "", /ha runtime instance login/u);

    const signedOut = await probe("signed-out");
    assert.equal(signedOut.code, "runtime_subscription_required", JSON.stringify(signedOut));
    assert.match(signedOut.hint ?? "", /not signed in/u);
    assert.match(signedOut.hint ?? "", /ha runtime instance login/u);

    const network = await probe("network");
    assert.equal(network.code, "runtime_provider_unreachable", JSON.stringify(network));
    assert.match(network.hint ?? "", /network/u);
    assert.doesNotMatch(network.hint ?? "", /instance login/u);

    const unknown = await probe("unknown");
    assert.equal(unknown.code, "runtime_auth_probe_failed", JSON.stringify(unknown));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
