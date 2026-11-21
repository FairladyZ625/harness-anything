// harness-test-tier: integration
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/daemon-host/agent-runtime-instances.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instance-types.ts";
import { resolveRuntimeInstanceCandidates } from "../src/daemon-host/runtime-spawn-mission.ts";
import { openRuntimeProviderHealthStore } from "../src/runtime-engine/runtime-provider-health.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

interface LoopbackStub {
  readonly baseUrl: string;
  readonly requests: Array<{
    readonly url: string;
    readonly headers: Record<string, string | string[] | undefined>;
  }>;
  close(): Promise<void>;
}

async function startLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<LoopbackStub> {
  const requests: LoopbackStub["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "/", headers: req.headers });
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function pinnedFetch(server: LoopbackStub, requestedUrls: string[]): typeof fetch {
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(raw);
    const parsed = new URL(raw);
    return fetch(`${server.baseUrl}${parsed.pathname}${parsed.search}`, init);
  };
}

function witness(
  kindId: RuntimeInstallationWitness["kindId"],
  executablePath: string,
  version: string,
): RuntimeInstallationWitness {
  return {
    installationId: `${kindId}-install`,
    kindId,
    executablePath,
    version,
    observedAt: "2026-11-21T00:00:00.000Z",
  };
}

test("QUOTA-09 & QUOTA-16: Codex app-server stages ephemeral CODEX_HOME (zero auth.json mutation) and authoritative recovery of 7d shortens block to 5h for immediate re-entry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-09-16-codex-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    modeFile = path.join(root, "mode.txt"),
    stagedDirLog = path.join(root, "staged-dirs.jsonl"),
    reset5h = "2026-11-21T15:00:00.000Z",
    reset7d = "2026-11-28T00:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  writeFileSync(modeFile, "expired");
  let refreshConsumed = false;
  const server = await startLoopback((req, res) => {
    if (req.method === "POST" && req.url === "/oauth/token") {
      res.writeHead(refreshConsumed ? 401 : 200);
      refreshConsumed = true;
    } else {
      res.writeHead(401);
    }
    res.end();
  });
  const codexBin = writeProviderExecutable(
    path.join(bin, "codex"),
    `
      const fs = require("node:fs");
      const path = require("node:path");
      const readline = require("node:readline");
      const args = process.argv.slice(2);
      const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
      if (args[0] === "login" && args[1] === "status") {
        console.log("Logged in");
        process.exit(0);
      }
      if (args[0] === "app-server") {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", async (line) => {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "codex-stub" } } }));
          } else if (msg.method === "model/list") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [{ model: "gpt-6-sol", isDefault: true }], nextCursor: null } }));
          } else if (msg.method === "account/rateLimits/read") {
            const codexHome = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
            const authPath = path.join(codexHome, "auth.json");
            const existing = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : null;
            if (!existing || existing.tokens?.access_token !== "codex-real-unmutated-token") {
              process.exit(41);
            }
            if (mode === "expired") {
              if (existing.tokens.refresh_token) {
                await fetch(${JSON.stringify(server.baseUrl + "/oauth/token")}, {
                  method: "POST", body: existing.tokens.refresh_token
                });
              }
              console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "expired" } }));
              return;
            }
            fs.writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "MUTATED-BY-APP-SERVER" } }));
            fs.appendFileSync(${JSON.stringify(stagedDirLog)}, JSON.stringify({ home: process.env.HOME, codexHome }) + "\\n");
            console.log(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                rateLimits: {
                  planType: "plus",
                  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: ${JSON.stringify(reset5h)} },
                  secondary: {
                    usedPercent: mode === "both-zero" ? 100 : 40,
                    windowDurationMins: 10080,
                    resetsAt: ${JSON.stringify(reset7d)}
                  }
                }
              }
            }));
          }
        });
        return;
      }
      process.exit(2);
    `,
  );
  try {
    let clock = "2026-11-21T10:00:00.000Z";
    const health = openRuntimeProviderHealthStore(userRoot);
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: path.join(root, "operator-home") },
      discover: () => [witness("codex", codexBin, "0.165.0")],
      providerHealth: health,
      now: () => clock,
      quotaFetch: pinnedFetch(server, []),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-isolated",
      name: "Codex Isolated",
      kindId: "codex",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-6-sol"],
      authMode: "subscription",
      credentialSource: "instance",
      isolationState: "enforced",
    });
    const realCodexHome = path.join(userRoot, "runtime-instances", "codex-isolated", "home", ".codex");
    const realAuthPath = path.join(realCodexHome, "auth.json");
    const originalAuthBody = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-real-unmutated-token", refresh_token: "codex-refresh-v1" },
    });
    writeFileSync(realAuthPath, originalAuthBody, { mode: 0o600 });
    const statBefore = statSync(realAuthPath);

    const expired = await store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated", probe: true });
    const expiredInstance = expired.instance as {
      readonly quota?: unknown;
      readonly authReadiness: { readonly status: string };
    };
    assert.equal(refreshConsumed, false, "background probing consumed the issuer's one-time refresh token");
    assert.equal(expiredInstance.quota, undefined);
    assert.equal(expiredInstance.authReadiness.status, "ready");

    // 1. Both 5h and 7d are exhausted -> quotaExhaustedUntil is the later 7d reset.
    writeFileSync(modeFile, "both-zero");
    await store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated", probe: true });
    assert.equal(health.get("codex-isolated").quotaExhaustedUntil, reset7d);

    // QUOTA-16: Real auth.json contents, mtime, and inode stayed completely untouched despite app-server write!
    assert.equal(readFileSync(realAuthPath, "utf8"), originalAuthBody);
    const statAfter1 = statSync(realAuthPath);
    assert.equal(statAfter1.mtimeMs, statBefore.mtimeMs);
    assert.equal(statAfter1.ino, statBefore.ino);

    // Also add an independent transport 503 cooldown (12:00) to confirm it is preserved independently.
    health.recordFailure({
      instanceId: "codex-isolated",
      reason: "HTTP 503",
      occurredAt: "2026-11-21T10:05:00.000Z",
      cooldownBaseSeconds: 7200,
    });
    assert.equal(health.get("codex-isolated").cooldownUntil, "2026-11-21T12:05:00.000Z");

    // 2. QUOTA-09: Full authoritative probe reports 7d recovered (60% remaining) while 5h is still 0% (15:00).
    //    quotaExhaustedUntil MUST shorten to 15:00 while preserving transport cooldownUntil (12:05)!
    clock = "2026-11-21T10:10:00.000Z";
    writeFileSync(modeFile, "7d-recovered");
    await store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated", probe: true });
    assert.equal(health.get("codex-isolated").quotaExhaustedUntil, reset5h);
    assert.equal(health.get("codex-isolated").cooldownUntil, "2026-11-21T12:05:00.000Z");
    assert.equal(health.get("codex-isolated").reason, "HTTP 503");

    // Before 15:00 -> still excluded; at 15:01 (right after 5h reset, long before old 7d reset!) -> IMMEDIATELY re-admitted!
    assert.throws(
      () =>
        resolveRuntimeInstanceCandidates({
          agent: null,
          sessions: [],
          allowedInstanceIds: ["codex-isolated"],
          instances: store.listPublic(),
          health: health.list(),
          now: "2026-11-21T14:59:00.000Z",
          runtimeKind: "codex",
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_model_not_ready",
    );
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: null,
        sessions: [],
        allowedInstanceIds: ["codex-isolated"],
        instances: store.listPublic(),
        health: health.list(),
        now: "2026-11-21T15:01:00.000Z",
        runtimeKind: "codex",
      }),
      ["codex-isolated"],
    );

    // Verify all staged ephemeral directories were distinct from realCodexHome and cleaned up in finally.
    const stagedRuns = readFileSync(stagedDirLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly home: string; readonly codexHome: string });
    assert.equal(stagedRuns.length, 2);
    for (const run of stagedRuns) {
      assert.notEqual(run.codexHome, realCodexHome);
      assert.equal(existsSync(run.home), false, `ephemeral Codex probe home was not cleaned up: ${run.home}`);
    }
    const statAfter2 = statSync(realAuthPath);
    assert.equal(readFileSync(realAuthPath, "utf8"), originalAuthBody);
    assert.equal(statAfter2.mtimeMs, statBefore.mtimeMs);
    assert.equal(statAfter2.ino, statBefore.ino);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("QUOTA-18: External account switch outside Harness never inherits old account 7d exhaustion (Claude file swap & Copilot gh token swap)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-18-switch-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    claudeDir = path.join(root, "claude-config"),
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  let claudeResponseMode: "account-a-7d-zero" | "partial-5h-healthy" = "account-a-7d-zero";
  let copilotMode: "account-a-exhausted" | "account-b-partial-healthy" | "mid-probe-swap" = "account-a-exhausted";
  let copilotGhToken = "gho_copilot_account_a_111111111";
  let releaseMidProbe: (() => void) | null = null;
  let midProbeStarted: (() => void) | null = null;
  const midProbeStartedPromise = new Promise<void>((resolve) => {
    midProbeStarted = resolve;
  });

  const server = await startLoopback(async (req, res) => {
    if (req.url === "/api/oauth/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      if (claudeResponseMode === "account-a-7d-zero") {
        res.end(
          JSON.stringify({
            five_hour: { utilization: 25, resets_at: "2026-11-21T15:00:00.000Z" },
            seven_day: { utilization: 100, resets_at: "2026-11-28T00:00:00.000Z" },
          }),
        );
      } else {
        // Partial response containing ONLY healthy 5h (7d omitted).
        res.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: "2026-11-21T15:00:00.000Z" },
          }),
        );
      }
      return;
    }
    if (req.url === "/copilot_internal/user") {
      if (copilotMode === "mid-probe-swap") {
        midProbeStarted?.();
        await new Promise<void>((resolve) => {
          releaseMidProbe = resolve;
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (copilotMode === "account-a-exhausted" || copilotMode === "mid-probe-swap") {
        res.end(
          JSON.stringify({
            copilot_plan: "individual_pro",
            quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: { percent_remaining: 0, remaining: 0, entitlement: 300, unlimited: false },
              chat: { percent_remaining: 100, unlimited: true },
            },
          }),
        );
      } else {
        // Account B returns only healthy chat window (omitting premium_interactions).
        res.end(
          JSON.stringify({
            copilot_plan: "individual_pro",
            quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
            quota_snapshots: {
              chat: { percent_remaining: 100, unlimited: true },
            },
          }),
        );
      }
      return;
    }
    if (req.url === "/user") {
      const id = req.headers.authorization === "token gho_copilot_account_a_111111111" ? 101 : 102;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const claudeBin = writeProviderExecutable(
    path.join(bin, "claude"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
      if (args.includes("--print")) {
        console.log(JSON.stringify({ type: "control_response", response: { request_id: "models", subtype: "success", response: { models: [{ value: "claude-opus-5-5" }] } } }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  const copilotBin = writeProviderExecutable(path.join(bin, "copilot"), `console.log("copilot 1.0.0");\n`);

  try {
    const health = openRuntimeProviderHealthStore(userRoot);
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: claudeDir },
      discover: () => [witness("claude", claudeBin, "2.1.300"), witness("copilot", copilotBin, "1.0.0")],
      providerHealth: health,
      resolveGithubToken: async () => copilotGhToken,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedFetch(server, requestedUrls),
    });

    // --- Part A: Claude external credential switch ---
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accountUuid: "account-a", accessToken: "sk-ant-oat01-account-a-token" } }),
      { mode: 0o600 },
    );
    store.command({
      kind: "runtime-instance-create",
      instanceId: "claude-ext-switch",
      name: "Claude Ext Switch",
      kindId: "claude",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    // 1. Account A probed with 7d=0 -> persisted and blocks health until Nov 28.
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-ext-switch", probe: true });
    assert.equal(health.get("claude-ext-switch").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");

    // 2. SAME account receives partial 5h-only healthy response -> MUST still preserve Account A's 7d=0!
    claudeResponseMode = "partial-5h-healthy";
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accountUuid: "account-a", accessToken: "sk-ant-oat01-account-a-refreshed" } }),
    );
    const sameAccountPartial = await store.command({
      kind: "runtime-instance-show",
      instanceId: "claude-ext-switch",
      probe: true,
    });
    const sameQuota = (sameAccountPartial.instance as Record<string, unknown>).quota as {
      readonly windows: ReadonlyArray<{ readonly id: string; readonly remainingFraction: number }>;
    };
    assert.equal(
      sameQuota.windows.some((w) => w.id === "seven_day" && w.remainingFraction === 0),
      true,
    );
    assert.equal(health.get("claude-ext-switch").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");

    // 3. Operator switches to Account B OUTSIDE Harness (no login terminal, no instance update),
    //    then runs explicit probe returning partial 5h-only healthy response -> MUST NOT inherit Account A's 7d=0!
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accountUuid: "account-b", accessToken: "sk-ant-oat01-account-b-token" } }),
      { mode: 0o600 },
    );
    const switchedAccountPartial = await store.command({
      kind: "runtime-instance-show",
      instanceId: "claude-ext-switch",
      probe: true,
    });
    const switchedQuota = (switchedAccountPartial.instance as Record<string, unknown>).quota as {
      readonly windows: ReadonlyArray<{ readonly id: string; readonly remainingFraction: number }>;
    };
    assert.deepEqual(
      switchedQuota.windows.map((w) => w.id),
      ["five_hour"],
    );
    assert.equal(health.get("claude-ext-switch").quotaExhaustedUntil, null);
    // Internal fingerprint MUST NEVER leak onto public DTO!
    assert.equal("quotaAccountFingerprint" in (switchedAccountPartial.instance as Record<string, unknown>), false);

    // --- Part B: Copilot gh resolver token switch (between probes & mid-probe!) ---
    store.command({
      kind: "runtime-instance-create",
      instanceId: "copilot-gh-switch",
      name: "Copilot GH Switch",
      kindId: "copilot",
      installationId: "copilot-install",
      providerId: "github",
      models: ["gpt-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    // 1. Copilot Account A (via gh token resolver) is exhausted until Dec 1.
    await store.command({ kind: "runtime-instance-show", instanceId: "copilot-gh-switch", probe: true });
    assert.equal(health.get("copilot-gh-switch").quotaExhaustedUntil, "2026-12-01T00:00:00.000Z");

    // 2. External `gh auth login` swaps resolved token to Account B -> partial healthy response MUST NOT inherit Account A's exhaustion!
    copilotGhToken = "gho_copilot_account_b_222222222";
    copilotMode = "account-b-partial-healthy";
    const copilotB = await store.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-gh-switch",
      probe: true,
    });
    const copilotBQuota = (copilotB.instance as Record<string, unknown>).quota as {
      readonly windows: ReadonlyArray<{ readonly id: string }>;
    };
    assert.deepEqual(
      copilotBQuota.windows.map((w) => w.id),
      ["chat"],
    );
    assert.equal(health.get("copilot-gh-switch").quotaExhaustedUntil, null);

    // 3. Mid-probe `gh` token swap MUST be fenced out by currentProbeCommit (`runtime_instance_probe_stale`)!
    copilotMode = "mid-probe-swap";
    const inFlight = store.authStatus("copilot-gh-switch");
    await midProbeStartedPromise;
    copilotGhToken = "gho_copilot_account_c_333333333";
    releaseMidProbe?.();
    await assert.rejects(
      inFlight,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_instance_probe_stale",
    );
    assert.equal(health.get("copilot-gh-switch").quotaExhaustedUntil, null);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("QUOTA-19: Copilot CLI native plaintext OAuth tokens in config.json honor account ownership and fail closed on mismatch/ambiguity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-19-copilot-config-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  const server = await startLoopback((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        copilot_plan: "individual_pro",
        quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
        quota_snapshots: {
          premium_interactions: { percent_remaining: 62, remaining: 186, entitlement: 300, unlimited: false },
        },
      }),
    );
  });
  const copilotBin = writeProviderExecutable(path.join(bin, "copilot"), `console.log("copilot 1.0.0");\n`);
  const createPayload = {
    kind: "runtime-instance-create",
    kindId: "copilot",
    installationId: "copilot-install",
    providerId: "github",
    models: ["gpt-5"],
    authMode: "subscription",
    credentialSource: "operator",
    isolationState: "operator-environment",
  };

  try {
    // 1. Positive: config.json ONLY (no env token, no gh token, no hosts.json, no apps.json).
    //    Active user `bob` selects `https://github.com:bob` token even when `alice` is also listed.
    const positiveHome = path.join(root, "copilot-config-only-positive");
    mkdirSync(positiveHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(positiveHome, "config.json"),
      JSON.stringify({
        last_logged_in_user: { host: "https://github.com", login: "bob" },
        logged_in_users: [
          { host: "https://github.com", login: "alice" },
          { host: "https://github.com", login: "bob" },
        ],
        copilot_tokens: {
          "https://github.com:alice": "gho_config_alice_token_111",
          "https://github.com:bob": "gho_config_bob_token_222",
        },
      }),
      { mode: 0o600 },
    );
    const storePos = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "pos"),
      platform: "linux",
      env: { PATH: bin, HOME: path.join(root, "empty-home"), COPILOT_HOME: positiveHome },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => null,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedFetch(server, requestedUrls),
    });
    storePos.command({ ...createPayload, instanceId: "copilot-cfg-pos", name: "Copilot Config Positive" });
    const posRes = await storePos.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-cfg-pos",
      probe: true,
    });
    assert.equal(requestedUrls.at(-1), "https://api.github.com/copilot_internal/user");
    assert.equal(server.requests.at(-1)?.headers.authorization, "token gho_config_bob_token_222");
    const posQuota = (posRes.instance as Record<string, unknown>).quota as {
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{ readonly remainingFraction: number }>;
    };
    assert.equal(posQuota.plan, "individual_pro");
    assert.equal(posQuota.windows[0]?.remainingFraction, 0.62);
    assert.doesNotMatch(JSON.stringify(posRes), /gho_config_bob_token_222|gho_config_alice_token_111/u);

    // 2. Negative (mismatched account): active user `charlie` has no token in config.json -> fail closed!
    const mismatchHome = path.join(root, "copilot-config-mismatch");
    mkdirSync(mismatchHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(mismatchHome, "config.json"),
      JSON.stringify({
        last_logged_in_user: { host: "https://github.com", login: "charlie" },
        copilot_tokens: {
          "https://github.com:alice": "gho_config_alice_token_111",
          "https://github.com:bob": "gho_config_bob_token_222",
        },
      }),
      { mode: 0o600 },
    );
    const reqsBeforeMismatch = requestedUrls.length;
    const storeMismatch = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "mismatch"),
      platform: "linux",
      env: { PATH: bin, HOME: path.join(root, "empty-home"), COPILOT_HOME: mismatchHome },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => null,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedFetch(server, requestedUrls),
    });
    storeMismatch.command({ ...createPayload, instanceId: "copilot-cfg-mismatch", name: "Copilot Config Mismatch" });
    const mismatchRes = await storeMismatch.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-cfg-mismatch",
      probe: true,
    });
    assert.equal((mismatchRes.instance as Record<string, unknown>).quota, undefined);
    assert.equal(requestedUrls.length, reqsBeforeMismatch);

    // 3. Negative (ambiguous multi-user without active user): fail closed!
    const ambiguousHome = path.join(root, "copilot-config-ambiguous");
    mkdirSync(ambiguousHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(ambiguousHome, "config.json"),
      JSON.stringify({
        copilot_tokens: {
          "https://github.com:alice": "gho_config_alice_token_111",
          "https://github.com:bob": "gho_config_bob_token_222",
        },
      }),
      { mode: 0o600 },
    );
    const storeAmbiguous = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "ambiguous"),
      platform: "linux",
      env: { PATH: bin, HOME: path.join(root, "empty-home"), COPILOT_HOME: ambiguousHome },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => null,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedFetch(server, requestedUrls),
    });
    storeAmbiguous.command({ ...createPayload, instanceId: "copilot-cfg-ambig", name: "Copilot Config Ambiguous" });
    const ambigRes = await storeAmbiguous.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-cfg-ambig",
      probe: true,
    });
    assert.equal((ambigRes.instance as Record<string, unknown>).quota, undefined);
    assert.equal(requestedUrls.length, reqsBeforeMismatch);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
