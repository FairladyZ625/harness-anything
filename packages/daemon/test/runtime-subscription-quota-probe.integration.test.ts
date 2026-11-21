// harness-test-tier: integration
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/daemon-host/agent-runtime-instances.ts";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instance-types.ts";
import { parseClientRpcResponse } from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { resolveRuntimeInstanceCandidates } from "../src/daemon-host/runtime-spawn-mission.ts";
import { openRuntimeProviderHealthStore } from "../src/runtime-engine/runtime-provider-health.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

interface HttpStub {
  readonly baseUrl: string;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string | string[] | undefined>;
  }>;
  close(): Promise<void>;
}

async function startLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<HttpStub> {
  const requests: HttpStub["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: { ...req.headers },
    });
    void Promise.resolve(handler(req, res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Routes pinned HTTPS provider URLs to the local loopback server while recording the exact requested URL. */
function pinnedLoopbackFetch(server: HttpStub, requestedUrls: string[]): typeof fetch {
  return (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(rawUrl);
    const parsed = new URL(rawUrl);
    return fetch(`${server.baseUrl}${parsed.pathname}${parsed.search}`, init);
  };
}

function witness(
  kindId: RuntimeInstallationWitness["kindId"],
  executablePath: string,
  version = "2.2.0",
): RuntimeInstallationWitness {
  return {
    installationId: `${kindId}-install`,
    kindId,
    executablePath,
    version,
    observedAt: "2026-11-21T10:00:00.000Z",
    models: ["default-model"],
    defaultModel: "default-model",
  };
}

test("AGY quota probe parses multi-group buckets, caches for O(1) list/show, cools down on 0% and recovers on >0%", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-agy-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    modeFile = path.join(root, "mode.txt"),
    traceFile = path.join(root, "trace.log"),
    resetFuture = "2026-11-22T06:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  writeFileSync(modeFile, "exhausted");
  writeFileSync(traceFile, "");
  const agyBin = writeProviderExecutable(
    path.join(bin, "agy"),
    `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(traceFile)}, args.join(" ") + "\\n");
      if (args[0] === "models") {
        console.log("gemini-4-hydrogen-low\\tmodel");
        process.exit(0);
      }
      if (args[0] === "-p" && args[1] === "/quota") {
        const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
        console.log(JSON.stringify({
          command: {
            data: {
              plan: "Ultra",
              groups: [
                {
                  group_id: "gemini",
                  display_name: "Gemini",
                  buckets: [
                    { bucket_id: "gemini-5h", display_name: "5h", remaining_fraction: mode === "exhausted" ? 0 : 0.85, reset_time: ${JSON.stringify(resetFuture)} },
                    { bucket_id: "disabled-bucket", display_name: "Disabled", remaining_fraction: 0, disabled: true, reset_time: "2026-11-30T00:00:00.000Z" }
                  ]
                },
                {
                  group_id: "claude",
                  display_name: "Claude/GPT",
                  buckets: [
                    { bucket_id: "claude-7d", display_name: "7d", remaining_fraction: 0.62, reset_time: "2026-11-28T00:00:00.000Z" }
                  ]
                }
              ]
            }
          }
        }));
        process.exit(0);
      }
      process.exit(1);
    `,
  );
  try {
    let clock = "2026-11-21T10:00:00.000Z";
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(root, "home") },
        discover: () => [witness("agy", agyBin, "1.2.2")],
        providerHealth: health,
        now: () => clock,
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-main",
      name: "AGY Main",
      kindId: "agy",
      installationId: "agy-install",
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
      credentialSource: "instance",
    });

    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main", probe: true });
    const instance = probed.instance as Record<string, unknown>;
    assert.equal((instance.authReadiness as Record<string, unknown>).status, "ready");
    const quota = instance.quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly remainingFraction: number;
        readonly resetsAt: string | null;
      }>;
    };
    assert.equal(quota.source, "agy-cli");
    assert.equal(quota.plan, "Ultra");
    assert.equal(quota.windows.length, 2);
    assert.equal(quota.windows[0]?.remainingFraction, 0);
    assert.equal(quota.windows[1]?.remainingFraction, 0.62);
    assert.equal(health.get("agy-main").quotaExhaustedUntil, resetFuture);
    assert.equal(health.get("agy-main").failureStreak, 0);

    // Non-probe list and show read cached quota in O(1) with ZERO subprocess calls.
    const traceBeforeRead = readFileSync(traceFile, "utf8");
    const listed = await store.command({ kind: "runtime-instance-list" });
    const shown = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main" });
    assert.equal(readFileSync(traceFile, "utf8"), traceBeforeRead);
    assert.match(String(listed.summary), /\tQUOTA\n/u);
    assert.match(String(listed.summary), /Ultra/u);
    assert.match(String(shown.summary), /quota: \[Ultra\] Gemini · 5h 0%/u);
    assert.match(String(shown.summary), /Claude\/GPT · 7d 62%/u);

    // Real dispatch candidate selection avoids the exhausted instance even after repeated probes.
    for (let repeat = 0; repeat < 3; repeat += 1) {
      clock = `2026-11-21T10:0${repeat + 1}:00.000Z`;
      await store.command({ kind: "runtime-instance-show", instanceId: "agy-main", probe: true });
    }
    assert.equal(health.get("agy-main").failureStreak, 0);
    assert.equal(health.get("agy-main").frozenUntil, null);
    assert.equal(health.get("agy-main").quotaExhaustedUntil, resetFuture);
    assert.throws(
      () =>
        resolveRuntimeInstanceCandidates({
          agent: null,
          sessions: [],
          allowedInstanceIds: ["agy-main"],
          instances: store.listPublic(),
          health: health.list(),
          now: "2026-11-21T12:00:00.000Z",
          runtimeKind: "agy",
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_model_not_ready",
    );

    // When quota recovers > 0%, providerHealth quotaExhaustedUntil clears cleanly and dispatch admits it again.
    writeFileSync(modeFile, "healthy");
    clock = "2026-11-21T10:05:00.000Z";
    const recovered = await store.command({ kind: "runtime-instance-show", instanceId: "agy-main", probe: true });
    assert.equal(health.get("agy-main").quotaExhaustedUntil, null);
    assert.equal(health.get("agy-main").failureStreak, 0);
    assert.equal(
      ((recovered.instance as Record<string, unknown>).quota as typeof quota).windows[0]?.remainingFraction,
      0.85,
    );
    const candidates = resolveRuntimeInstanceCandidates({
      agent: null,
      sessions: [],
      allowedInstanceIds: ["agy-main"],
      instances: store.listPublic(),
      health: health.list(),
      now: "2026-11-21T10:06:00.000Z",
      runtimeKind: "agy",
    });
    assert.equal(candidates[0], "agy-main");

    // Mixed-model AGY instance: exhausted Argon/unknown Imagen/Claude buckets never block Gemini dispatch,
    // while Claude dispatch skips the instance when Claude/GPT is 0%.
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-mixed",
      name: "AGY Mixed",
      kindId: "agy",
      installationId: "agy-install",
      providerId: "google",
      models: ["gemini-4-hydrogen-low", "claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "instance",
    });
    const mixedWindow = (id: string, label: string, remainingFraction: number) => ({
      id,
      label,
      kind: "weekly" as const,
      scope: "primary" as const,
      remainingFraction,
      usedPercent: Math.round((1 - remainingFraction) * 1000) / 10,
      resetsAt: "2026-11-28T00:00:00.000Z",
    });
    const mixedInstance = {
      ...store.listPublic().find((entry) => entry.instanceId === "agy-mixed")!,
      availableModels: ["gemini-4-hydrogen-low", "claude-opus-5-5"],
      authReadiness: { status: "ready" as const, code: null, hint: null, basis: "provider" as const },
      quota: {
        schemaVersion: 1 as const,
        observedAt: "2026-11-21T10:00:00.000Z",
        source: "agy-cli",
        plan: "Pro",
        windows: [
          mixedWindow("gemini-weekly", "Gemini · Weekly", 0.835),
          mixedWindow("argon-weekly", "Argon · Weekly", 0),
          mixedWindow("imagen-weekly", "Imagen · Weekly", 0),
          mixedWindow("claude-weekly", "Claude/GPT · Weekly", 0),
        ],
      },
    };
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: null,
        sessions: [],
        allowedInstanceIds: ["agy-mixed"],
        instances: [mixedInstance],
        health: [],
        now: "2026-11-21T12:00:00.000Z",
        runtimeKind: "agy",
        model: "gemini-4-hydrogen-low",
      }),
      ["agy-mixed"],
    );
    assert.throws(
      () =>
        resolveRuntimeInstanceCandidates({
          agent: null,
          sessions: [],
          allowedInstanceIds: ["agy-mixed"],
          instances: [mixedInstance],
          health: [],
          now: "2026-11-21T12:00:00.000Z",
          runtimeKind: "agy",
          model: "claude-opus-5-5",
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_model_not_ready",
    );

    // QUOTA-08: When --model and Agent inline model are omitted, candidate selection enforces
    // per-model quota exhaustion against each instance's effective defaultModel (e.g. exhausted
    // Argon defaultModel skips to healthy candidate even when Hydrogen still has quota).
    const defaultArgonExhausted = {
      ...mixedInstance,
      instanceId: "agy-default-argon",
      models: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
      defaultModel: "gemini-4-argon-high",
      availableModels: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
    };
    const healthyArgonFallback = {
      ...mixedInstance,
      instanceId: "agy-healthy-argon",
      models: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
      defaultModel: "gemini-4-argon-high",
      availableModels: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
      quota: {
        schemaVersion: 1 as const,
        observedAt: "2026-11-21T10:00:00.000Z",
        source: "agy-cli",
        plan: "Pro",
        windows: [
          mixedWindow("gemini-weekly", "Gemini · Weekly", 0.9),
          mixedWindow("argon-weekly", "Argon · Weekly", 0.7),
        ],
      },
    };
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: null,
        sessions: [],
        allowedInstanceIds: ["agy-default-argon", "agy-healthy-argon"],
        instances: [defaultArgonExhausted, healthyArgonFallback],
        health: [],
        now: "2026-11-21T12:00:00.000Z",
        runtimeKind: "agy",
      }),
      ["agy-healthy-argon"],
    );
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: {
          id: "agy-default-agent",
          role: "worker",
          runtimes: [{ type: "agy" }],
        } as unknown as Parameters<typeof resolveRuntimeInstanceCandidates>[0]["agent"],
        sessions: [],
        allowedInstanceIds: ["agy-default-argon", "agy-healthy-argon"],
        instances: [defaultArgonExhausted, healthyArgonFallback],
        health: [],
        now: "2026-11-21T12:00:00.000Z",
      }),
      ["agy-healthy-argon"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex read-only quota probe via app-server RPC never invokes codex exec inference, keeps authReadiness ready, and auto-recovers after resetAt expiry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-codex-rpc-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    modeFile = path.join(root, "mode.txt"),
    execMarker = path.join(root, "exec-called"),
    resetPrimary = "2026-11-21T15:00:00.000Z",
    resetWeekly = "2026-11-28T00:00:00.000Z";
  mkdirSync(bin, { recursive: true });
  writeFileSync(modeFile, "exhausted");
  const codexBin = writeProviderExecutable(
    path.join(bin, "codex"),
    `
      const fs = require("node:fs");
      const readline = require("node:readline");
      const args = process.argv.slice(2);
      const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
      if (args[0] === "login" && args[1] === "status") {
        console.log("Logged in");
        process.exit(0);
      }
      if (args[0] === "exec") {
        fs.writeFileSync(${JSON.stringify(execMarker)}, "called");
        process.exit(99);
      }
      if (args[0] === "app-server") {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "codex-stub" } } }));
          } else if (msg.method === "model/list") {
            console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [{ model: "gpt-6-sol", isDefault: true }], nextCursor: null } }));
          } else if (msg.method === "account/rateLimits/read") {
            console.log(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                rateLimits: {
                  planType: "plus",
                  primary: {
                    usedPercent: mode === "exhausted" ? 100 : 99.6,
                    windowDurationMins: 300,
                    resetsAt: ${JSON.stringify(resetPrimary)}
                  },
                  secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: ${JSON.stringify(resetWeekly)} },
                  code_review_rate_limit: {
                    primary_window: { used_percent: 100, reset_at: ${JSON.stringify(resetWeekly)} }
                  },
                  credits: { hasCredits: true, unlimited: false, balance: "42.5" }
                }
              }
            }));
          }
        });
        return;
      }
      process.exit(1);
    `,
  );
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(root, "home") },
        discover: () => [witness("codex", codexBin, "0.165.0")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-rpc",
      name: "Codex RPC",
      kindId: "codex",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-6-sol"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    // Explicit probe reads app-server quota WITHOUT invoking `codex exec` inference; authReadiness stays ready.
    const probed = await store.command({ kind: "runtime-instance-show", instanceId: "codex-rpc", probe: true });
    const probedInstance = probed.instance as Record<string, unknown>;
    assert.deepEqual(probedInstance.authReadiness, { status: "ready", code: null, hint: null, basis: "provider" });
    assert.throws(
      () => readFileSync(execMarker, "utf8"),
      /ENOENT/u,
      "codex exec must never run for read-only quota probe",
    );
    const quota = probedInstance.quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly scope?: string;
        readonly remainingFraction: number;
        readonly resetsAt: string | null;
      }>;
      readonly credits?: { readonly remaining: number | null; readonly unlimited: boolean };
    };
    assert.equal(quota.source, "codex-app-server");
    assert.equal(quota.plan, "plus");
    assert.equal(quota.windows.length, 3);
    assert.equal(quota.windows[0]?.remainingFraction, 0);
    assert.equal(quota.windows[2]?.id, "code-review");
    assert.equal(quota.windows[2]?.scope, "auxiliary");
    assert.equal(quota.credits?.remaining, 42.5);
    assert.equal(health.get("codex-rpc").quotaExhaustedUntil, resetPrimary);

    // Excluded before resetPrimary, and AUTOMATICALLY re-admitted after resetPrimary expires without another probe!
    assert.throws(
      () =>
        resolveRuntimeInstanceCandidates({
          agent: null,
          sessions: [],
          allowedInstanceIds: ["codex-rpc"],
          instances: store.listPublic(),
          health: health.list(),
          now: "2026-11-21T14:00:00.000Z",
          runtimeKind: "codex",
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_model_not_ready",
    );
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: null,
        sessions: [],
        allowedInstanceIds: ["codex-rpc"],
        instances: store.listPublic(),
        health: health.list(),
        now: "2026-11-21T15:01:00.000Z",
        runtimeKind: "codex",
      }),
      ["codex-rpc"],
    );

    // When primary has 0.4% remaining (99.6% used) and auxiliary code_review is still 0%, quota exhaustion clears!
    writeFileSync(modeFile, "tiny-positive");
    const recovered = await store.command({ kind: "runtime-instance-show", instanceId: "codex-rpc", probe: true });
    const recoveredQuota = (recovered.instance as Record<string, unknown>).quota as typeof quota;
    assert.equal(recoveredQuota.windows[0]?.remainingFraction, 0.004);
    assert.equal(health.get("codex-rpc").quotaExhaustedUntil, null);
    assert.throws(() => readFileSync(execMarker, "utf8"), /ENOENT/u);

    // QUOTA-05: When local `codex login status` is ready and BOTH read-only routes (RPC & OAuth)
    // fail / return 429, NEVER fall through to active `codex exec` inference and NEVER overwrite
    // ready authReadiness with runtime_quota_unavailable; preserve ready status + cached quota.
    const failingCodexBin = writeProviderExecutable(
      path.join(bin, "codex-both-fail"),
      `
        const fs = require("node:fs");
        const args = process.argv.slice(2);
        if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
        if (args[0] === "exec") {
          fs.writeFileSync(${JSON.stringify(execMarker)}, "called");
          console.log(JSON.stringify({ type: "turn.failed", error: { http_status: 429, code: "insufficient_quota", message: "quota exceeded" } }));
          process.exit(1);
        }
        process.exit(2);
      `,
    );
    const failHome = path.join(root, "fail-home");
    mkdirSync(path.join(failHome, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(failHome, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "codex_fake_429_token" } }),
      { mode: 0o600 },
    );
    let quotaFetchCalls = 0;
    const storeBothFail = openRuntimeInstanceStore({
      userRoot: path.join(root, "user-both-fail"),
      platform: "darwin",
      env: { PATH: bin, HOME: failHome },
      discover: () => [witness("codex", failingCodexBin, "0.165.0")],
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: async () => {
        quotaFetchCalls += 1;
        if (quotaFetchCalls === 1) {
          return new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1795273200 },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      },
    });
    storeBothFail.command({
      kind: "runtime-instance-create",
      instanceId: "codex-readonly-429",
      name: "Codex ReadOnly 429",
      kindId: "codex",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-6-sol"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });
    const seeded = await storeBothFail.command({
      kind: "runtime-instance-show",
      instanceId: "codex-readonly-429",
      probe: true,
    });
    const seededQuota = (seeded.instance as Record<string, unknown>).quota;
    assert.ok(seededQuota);
    const afterBothFail = await storeBothFail.command({
      kind: "runtime-instance-show",
      instanceId: "codex-readonly-429",
      probe: true,
    });
    const failedInstance = afterBothFail.instance as Record<string, unknown>;
    assert.deepEqual(failedInstance.authReadiness, { status: "ready", code: null, hint: null, basis: "metadata" });
    assert.deepEqual(failedInstance.quota, seededQuota);
    assert.throws(
      () => readFileSync(execMarker, "utf8"),
      /ENOENT/u,
      "codex exec must NEVER be invoked on 429/RPC failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex OAuth wham/usage preserves isolated config.toml chatgpt_base_url, rejects unsafe origins, and never mutates auth.json", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-codex-oauth-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    secretToken = "codex_fake_oauth_secret_token_999",
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  const server = await startLoopbackServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1795273200 },
          secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 1795860000 },
        },
        credits: { has_credits: true, unlimited: true, balance: null },
      }),
    );
  });
  const codexBin = writeProviderExecutable(
    path.join(bin, "codex"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "login" && args[1] === "status") { console.log("ok"); process.exit(0); }
      if (args[0] === "exec") { console.log(JSON.stringify({ type: "turn.completed" })); process.exit(0); }
      process.exit(2);
    `,
  );
  const codexAcpBin = writeProviderExecutable(path.join(bin, "codex-acp"), `process.exit(0);\n`);
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: path.join(root, "home") },
      discover: () => [witness("codex", codexBin, "0.165.0"), witness("codex-acp", codexAcpBin, "0.165.0")],
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    for (const [instanceId, kindId] of [
      ["codex-isolated", "codex"],
      ["codex-acp-isolated", "codex-acp"],
    ] as const) {
      store.command({
        kind: "runtime-instance-create",
        instanceId,
        name: instanceId,
        kindId,
        installationId: `${kindId}-install`,
        providerId: "openai",
        models: ["gpt-6-sol"],
        authMode: "subscription",
        credentialSource: "instance",
        isolationState: "enforced",
      });
      const instanceCodexDir = path.join(userRoot, "runtime-instances", instanceId, "home", ".codex");
      const authPath = path.join(instanceCodexDir, "auth.json"),
        authRaw = JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: secretToken, account_id: "acct_codex_123" },
        });
      writeFileSync(authPath, authRaw, { mode: 0o600 });
      writeFileSync(
        path.join(instanceCodexDir, "config.toml"),
        [
          '# chatgpt_base_url = "https://commented.out.invalid/backend-api"',
          'chatgpt_base_url = "https://chat.openai.com/backend-api" # inline comment',
          "",
          "[model_providers.other]",
          'chatgpt_base_url = "https://inside-table.invalid"',
        ].join("\n"),
        { mode: 0o600 },
      );
      const statBefore = statSync(authPath);
      const probed = await store.command({ kind: "runtime-instance-show", instanceId, probe: true });
      assert.equal(requestedUrls.at(-1), "https://chat.openai.com/backend-api/wham/usage");
      assert.equal(server.requests.at(-1)?.headers.authorization, `Bearer ${secretToken}`);
      assert.equal(server.requests.at(-1)?.headers["chatgpt-account-id"], "acct_codex_123");
      const persistedToml = readFileSync(path.join(instanceCodexDir, "config.toml"), "utf8");
      assert.match(persistedToml, /chatgpt_base_url = "https:\/\/chat\.openai\.com\/backend-api"/u);
      const quota = (probed.instance as Record<string, unknown>).quota as {
        readonly source: string;
        readonly plan: string | null;
        readonly windows: ReadonlyArray<{ readonly remainingFraction: number }>;
        readonly credits?: { readonly unlimited: boolean };
      };
      assert.equal(quota.source, "codex-oauth");
      assert.equal(quota.plan, "pro");
      assert.equal(quota.windows[0]?.remainingFraction, 0.75);
      assert.equal(quota.credits?.unlimited, true);
      assert.equal(readFileSync(authPath, "utf8"), authRaw);
      assert.equal(statSync(authPath).mtimeMs, statBefore.mtimeMs);
      assert.doesNotMatch(JSON.stringify(probed), new RegExp(secretToken, "u"));
    }

    // Plaintext HTTP and untrusted HTTPS origins in config.toml MUST be rejected with zero outbound requests.
    const isolatedDir = path.join(userRoot, "runtime-instances", "codex-isolated", "home", ".codex");
    for (const unsafeUrl of ["http://chatgpt.com/backend-api", "https://evil.example/backend-api"]) {
      const beforeRequests = requestedUrls.length;
      writeFileSync(path.join(isolatedDir, "config.toml"), `chatgpt_base_url = "${unsafeUrl}"\n`, { mode: 0o600 });
      const res = await store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated", probe: true });
      assert.equal(requestedUrls.length, beforeRequests);
      assert.equal(
        ((res.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
        "ready",
      );
    }

    // Truncated auth.json degrades cleanly after bounded read retries without mutating the file.
    const authPath = path.join(isolatedDir, "auth.json"),
      partialBody = '{"auth_mode":';
    writeFileSync(path.join(isolatedDir, "config.toml"), 'chatgpt_base_url = "https://chatgpt.com/backend-api"\n', {
      mode: 0o600,
    });
    writeFileSync(authPath, partialBody, { mode: 0o600 });
    const truncated = await store.command({ kind: "runtime-instance-show", instanceId: "codex-isolated", probe: true });
    assert.equal(readFileSync(authPath, "utf8"), partialBody);
    assert.equal(
      ((truncated.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "ready",
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude OAuth pins https://api.anthropic.com, supports macOS Keychain fallback & file precedence, and degrades on 429", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-claude-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    claudeConfigDir = path.join(root, "claude-config"),
    fileToken = "sk-ant-oat01-fake-claude-file-token-777",
    keychainToken = "sk-ant-oat01-fake-claude-keychain-token-888",
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  const credsPath = path.join(claudeConfigDir, ".credentials.json"),
    credsRaw = JSON.stringify({
      claudeAiOauth: { accessToken: fileToken, subscriptionType: "max" },
    });
  let mode: "ok" | "rate-limit" | "sonnet-zero" = "ok";
  let keychainMode: "unlocked" | "locked" = "unlocked";
  let keychainCalls = 0;
  const server = await startLoopbackServer((_req, res) => {
    if (mode === "rate-limit") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
      res.end(JSON.stringify({ error: { message: `Rate limited for token ${fileToken}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        five_hour: { utilization: 18, resets_at: "2026-11-21T15:00:00.000Z" },
        seven_day: { utilization: 45, resets_at: "2026-11-27T00:00:00.000Z" },
        seven_day_sonnet: { utilization: mode === "sonnet-zero" ? 100 : 10, resets_at: "2026-11-27T00:00:00.000Z" },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 23.5, utilization: 23.5 },
      }),
    );
  });
  const claudeBin = writeProviderExecutable(
    path.join(bin, "claude"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "auth" && args[1] === "status") {
        console.log(JSON.stringify({ loggedIn: true }));
        process.exit(0);
      }
      if (args.includes("--print")) {
        console.log(JSON.stringify({
          type: "control_response",
          response: { request_id: "models", subtype: "success", response: { models: [{ value: "claude-opus-5-5" }] } }
        }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: {
          PATH: bin,
          HOME: path.join(root, "home"),
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          // Mutated inference base URL MUST NEVER receive the OAuth token!
          ANTHROPIC_BASE_URL: "https://untrusted-proxy.example",
        },
        discover: () => [witness("claude", claudeBin, "2.1.300")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
        quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
        quotaKeychainLookup: async (request) => {
          keychainCalls += 1;
          assert.equal(request.service, "Claude Code-credentials");
          assert.equal(request.authenticationUI, "fail");
          assert.equal(request.userInteractionAllowed, false);
          if (keychainMode === "locked") {
            // Simulates the exact macOS ACL case where item metadata exists, but secret read requires UI (-25308).
            return { status: "interaction_not_allowed", osStatus: -25308 };
          }
          const payload = JSON.stringify({ claudeAiOauth: { accessToken: keychainToken, subscriptionType: "pro" } });
          return { status: "ok", secret: Buffer.from(payload, "utf8").toString("hex") };
        },
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "claude-pro",
      name: "Claude Pro",
      kindId: "claude",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    });

    // 1. Without .credentials.json, locked Keychain degrades cleanly without breaking authReadiness.
    keychainMode = "locked";
    const lockedRes = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    assert.equal(
      ((lockedRes.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "ready",
    );
    assert.equal((lockedRes.instance as Record<string, unknown>).quota, undefined);
    assert.ok(keychainCalls > 0);

    // 2. Without .credentials.json, unlocked Keychain (hex-encoded JSON) succeeds and sends to pinned issuer URL.
    keychainMode = "unlocked";
    const keychainRes = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    assert.equal(requestedUrls.at(-1), "https://api.anthropic.com/api/oauth/usage");
    assert.equal(server.requests.at(-1)?.headers.authorization, `Bearer ${keychainToken}`);
    assert.equal(server.requests.at(-1)?.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(((keychainRes.instance as Record<string, unknown>).quota as { plan: string }).plan, "pro");

    // 3. When .credentials.json exists, it takes precedence over Keychain (Keychain is NOT called).
    writeFileSync(credsPath, credsRaw, { mode: 0o600 });
    const callsBeforeFile = keychainCalls;
    mode = "sonnet-zero";
    const first = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    assert.equal(keychainCalls, callsBeforeFile);
    assert.equal(requestedUrls.at(-1), "https://api.anthropic.com/api/oauth/usage");
    assert.equal(server.requests.at(-1)?.headers.authorization, `Bearer ${fileToken}`);
    const firstQuota = (first.instance as Record<string, unknown>).quota as {
      readonly source: string;
      readonly plan: string | null;
      readonly windows: ReadonlyArray<{ readonly id: string; readonly remainingFraction: number }>;
      readonly credits?: { readonly remaining: number | null; readonly limit: number | null };
    };
    assert.equal(firstQuota.plan, "max");
    assert.equal(firstQuota.windows[0]?.remainingFraction, 0.82);
    assert.equal(firstQuota.credits?.remaining, 76.5);
    assert.equal(readFileSync(credsPath, "utf8"), credsRaw);
    // Sonnet sub-bucket hitting 0% does NOT exhaust an Opus instance!
    assert.equal(health.get("claude-pro").cooldownUntil, null);

    // 4. HTTP 429 keeps authReadiness === ready, preserves prior cached quota, and never leaks token.
    mode = "rate-limit";
    const rateLimited = await store.command({ kind: "runtime-instance-show", instanceId: "claude-pro", probe: true });
    const instance = rateLimited.instance as Record<string, unknown>;
    assert.equal((instance.authReadiness as Record<string, unknown>).status, "ready");
    assert.deepEqual(instance.quota, firstQuota);
    assert.doesNotMatch(JSON.stringify(rateLimited), new RegExp(`${fileToken}|${keychainToken}`, "u"));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot quota pins https://api.github.com, aligns account precedence, and refuses ambiguous multi-account files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-copilot-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    home = path.join(root, "home"),
    copilotEnvToken = "gho_copilot_env_highest_111111111",
    ghEnvToken = "gho_gh_env_second_222222222",
    userAToken = "gho_hosts_user_a_333333333",
    userBToken = "gho_hosts_user_b_444444444",
    resetDate = "2026-12-01T00:00:00.000Z",
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, ".copilot"), { recursive: true, mode: 0o700 });
  // Two distinct github.com accounts in hosts.json (ambiguous without config.json active user).
  writeFileSync(
    path.join(home, ".copilot", "hosts.json"),
    JSON.stringify({
      "github.com:appA": { user: "alice", oauth_token: userAToken },
      "github.com:appB": { user: "bob", oauth_token: userBToken },
    }),
    { mode: 0o600 },
  );
  const server = await startLoopbackServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        copilot_plan: "individual_pro",
        quota_reset_date_utc: resetDate,
        quota_snapshots: {
          premium_interactions: { percent_remaining: 0, remaining: 0, entitlement: 300, unlimited: false },
          chat: { percent_remaining: 100, unlimited: true },
        },
      }),
    );
  });
  const copilotBin = writeProviderExecutable(path.join(bin, "copilot"), `console.log("copilot 1.0.0");\n`);
  try {
    // 1. Multiple accounts in hosts.json with NO active user and NO env token -> unavailable (no guessing!).
    const storeAmbiguous = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "ambiguous"),
      platform: "darwin",
      env: { PATH: bin, HOME: home, GITHUB_API_URL: "https://untrusted-gh.example" },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    const copilotBase = {
      kind: "runtime-instance-create",
      kindId: "copilot",
      installationId: "copilot-install",
      providerId: "github",
      models: ["gpt-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    };
    storeAmbiguous.command({ ...copilotBase, instanceId: "copilot-ambiguous", name: "Copilot Ambiguous" });
    const ambiguous = await storeAmbiguous.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-ambiguous",
      probe: true,
    });
    assert.equal((ambiguous.instance as Record<string, unknown>).quota, undefined);
    assert.equal(requestedUrls.length, 0);

    // 1b. Editor-only ~/.config/github-copilot/hosts.json is NEVER treated as CLI account credentials.
    const editorOnlyHome = path.join(root, "editor-only-home");
    mkdirSync(path.join(editorOnlyHome, ".config", "github-copilot"), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(editorOnlyHome, ".config", "github-copilot", "hosts.json"),
      JSON.stringify({ "github.com": { user: "ide-user", oauth_token: "gho_editor_only_token_999" } }),
      { mode: 0o600 },
    );
    const storeEditorOnly = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "editor-only"),
      platform: "darwin",
      env: { PATH: bin, HOME: editorOnlyHome },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    storeEditorOnly.command({ ...copilotBase, instanceId: "copilot-editor-only", name: "Copilot Editor Only" });
    const editorRes = await storeEditorOnly.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-editor-only",
      probe: true,
    });
    assert.equal((editorRes.instance as Record<string, unknown>).quota, undefined);
    assert.equal(requestedUrls.length, 0);

    // 2. Setting active user in ~/.copilot/config.json resolves exact matching account (bob -> userBToken).
    writeFileSync(
      path.join(home, ".copilot", "config.json"),
      JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "bob" } }),
      { mode: 0o600 },
    );
    const activeMatch = await storeAmbiguous.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-ambiguous",
      probe: true,
    });
    assert.equal(requestedUrls.at(-1), "https://api.github.com/copilot_internal/user");
    assert.equal(server.requests.at(-1)?.headers.authorization, `token ${userBToken}`);
    assert.equal(((activeMatch.instance as Record<string, unknown>).quota as { plan: string }).plan, "individual_pro");

    // 3. COPILOT_GITHUB_TOKEN takes precedence over GH_TOKEN, GITHUB_TOKEN, and hosts.json.
    const health = openRuntimeProviderHealthStore(path.join(userRoot, "env-precedence"));
    const storeEnv = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "env-precedence"),
      platform: "darwin",
      env: {
        PATH: bin,
        HOME: home,
        COPILOT_GITHUB_TOKEN: copilotEnvToken,
        GH_TOKEN: ghEnvToken,
        GITHUB_API_URL: "https://untrusted-gh.example",
      },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      providerHealth: health,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    storeEnv.command({ ...copilotBase, instanceId: "copilot-main", name: "Copilot Main" });
    const probed = await storeEnv.command({ kind: "runtime-instance-show", instanceId: "copilot-main", probe: true });
    assert.equal(requestedUrls.at(-1), "https://api.github.com/copilot_internal/user");
    assert.equal(server.requests.at(-1)?.headers.authorization, `token ${copilotEnvToken}`);
    assert.equal(health.get("copilot-main").quotaExhaustedUntil, resetDate);
    assert.doesNotMatch(JSON.stringify(probed), new RegExp(`${copilotEnvToken}|${ghEnvToken}|${userBToken}`, "u"));

    // 4. Conflicting credentials: empty GH_TOKEN="" + GITHUB_TOKEN="other" + launch resolver gh token
    //    MUST align with launch (`applyGithubLaunchCredential` injects GH_TOKEN from resolver, winning over GITHUB_TOKEN).
    const ghResolvedToken = "gho_launch_resolved_gh_token_555555555";
    const otherGithubToken = "gho_conflicting_github_env_666666666";
    const storeConflict = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "conflict"),
      platform: "darwin",
      env: { PATH: bin, HOME: home, GH_TOKEN: "", GITHUB_TOKEN: otherGithubToken },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => ghResolvedToken,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    storeConflict.command({ ...copilotBase, instanceId: "copilot-conflict", name: "Copilot Conflict" });
    await storeConflict.command({ kind: "runtime-instance-show", instanceId: "copilot-conflict", probe: true });
    assert.equal(server.requests.at(-1)?.headers.authorization, `token ${ghResolvedToken}`);

    // 5. QUOTA-04 dual-dir COPILOT_HOME alignment:
    //    When default ~/.copilot has stale account A (alice) and COPILOT_HOME has active account B (bob)
    //    with an empty launch resolver, probe MUST read COPILOT_HOME (bob) and NEVER hang alice's quota onto bob.
    const dualHome = path.join(root, "dual-default-home");
    const customCopilotHome = path.join(root, "custom-copilot-home");
    const customCopilotEmptyTokens = path.join(root, "custom-copilot-no-tokens");
    mkdirSync(path.join(dualHome, ".copilot"), { recursive: true, mode: 0o700 });
    mkdirSync(customCopilotHome, { recursive: true, mode: 0o700 });
    mkdirSync(customCopilotEmptyTokens, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dualHome, ".copilot", "config.json"),
      JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "alice" } }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(dualHome, ".copilot", "hosts.json"),
      JSON.stringify({ "github.com": { user: "alice", oauth_token: userAToken } }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(customCopilotHome, "config.json"),
      JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "bob" } }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(customCopilotHome, "hosts.json"),
      JSON.stringify({ "github.com": { user: "bob", oauth_token: userBToken } }),
      { mode: 0o600 },
    );
    const storeCopilotHome = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "copilot-home-b"),
      platform: "darwin",
      env: { PATH: bin, HOME: dualHome, COPILOT_HOME: customCopilotHome },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => null,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    storeCopilotHome.command({ ...copilotBase, instanceId: "copilot-home-b", name: "Copilot Home B" });
    await storeCopilotHome.command({ kind: "runtime-instance-show", instanceId: "copilot-home-b", probe: true });
    assert.equal(server.requests.at(-1)?.headers.authorization, `token ${userBToken}`);

    // When COPILOT_HOME specifies active account bob without a matching local token, fail closed to unavailable
    // (0 outbound requests) instead of falling back to stale ~/.copilot account alice!
    writeFileSync(
      path.join(customCopilotEmptyTokens, "config.json"),
      JSON.stringify({ last_logged_in_user: { host: "https://github.com", login: "bob" } }),
      { mode: 0o600 },
    );
    const requestsBeforeFailClosed = requestedUrls.length;
    const storeCopilotFailClosed = openRuntimeInstanceStore({
      userRoot: path.join(userRoot, "copilot-home-fail-closed"),
      platform: "darwin",
      env: { PATH: bin, HOME: dualHome, COPILOT_HOME: customCopilotEmptyTokens },
      discover: () => [witness("copilot", copilotBin, "1.0.0")],
      resolveGithubToken: async () => null,
      now: () => "2026-11-21T10:00:00.000Z",
      quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
    });
    storeCopilotFailClosed.command({
      ...copilotBase,
      instanceId: "copilot-home-unaligned",
      name: "Copilot Home Unaligned",
    });
    const unaligned = await storeCopilotFailClosed.command({
      kind: "runtime-instance-show",
      instanceId: "copilot-home-unaligned",
      probe: true,
    });
    assert.equal((unaligned.instance as Record<string, unknown>).quota, undefined);
    assert.equal(requestedUrls.length, requestsBeforeFailClosed);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Security, sanitization, same-instance re-login, out-of-order probes, health scoping, and IPC validation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-quota-security-")),
    userRoot = path.join(root, "user"),
    bin = path.join(root, "bin"),
    claudeDir = path.join(root, "claude-dir"),
    secretToken = "sk-ant-oat01-must-never-leak-anywhere-888",
    requestedUrls: string[] = [];
  mkdirSync(bin, { recursive: true });
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: secretToken } }),
    { mode: 0o600 },
  );
  let redirectTargetHit = false;
  const redirectTarget = await startLoopbackServer((_req, res) => {
    redirectTargetHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  let serverMode:
    | "redirect"
    | "error-leak"
    | "tainted-fields"
    | "credits-only"
    | "zero-no-reset"
    | "seven-day-zero"
    | "partial-5h-healthy"
    | "both-healthy"
    | "race-1"
    | "race-2"
    | "slow-relogin" = "redirect";
  let releaseFirst: (() => void) | null = null;
  let firstStarted: (() => void) | null = null;
  let firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let requestCounter = 0;
  const server = await startLoopbackServer(async (_req, res) => {
    requestCounter += 1;
    if (serverMode === "redirect") {
      res.writeHead(302, { location: `${redirectTarget.baseUrl}/steal` });
      res.end();
      return;
    }
    if (serverMode === "error-leak") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`upstream failed with Authorization: Bearer ${secretToken}`);
      return;
    }
    if (serverMode === "tainted-fields") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          plan: `Bearer ${secretToken}\n\t${"x".repeat(200)}`,
          five_hour: { utilization: 20, resets_at: "2026-11-22T00:00:00.000Z" },
        }),
      );
      return;
    }
    if (serverMode === "credits-only") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 10 } }));
      return;
    }
    if (serverMode === "zero-no-reset") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 100, resets_at: null } }));
      return;
    }
    if (serverMode === "seven-day-zero") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 30, resets_at: "2026-11-21T15:00:00.000Z" },
          seven_day: { utilization: 100, resets_at: "2026-11-28T00:00:00.000Z" },
        }),
      );
      return;
    }
    if (serverMode === "partial-5h-healthy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 10, resets_at: "2026-11-21T15:00:00.000Z" } }));
      return;
    }
    if (serverMode === "both-healthy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: "2026-11-21T15:00:00.000Z" },
          seven_day: { utilization: 20, resets_at: "2026-11-28T00:00:00.000Z" },
        }),
      );
      return;
    }
    if (serverMode === "race-1") {
      // First request parks until released, then returns exhausted (0%)!
      serverMode = "race-2";
      firstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 100, resets_at: "2026-11-22T00:00:00.000Z" } }));
      return;
    }
    if (serverMode === "race-2") {
      // Second request finishes immediately with 90% remaining!
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 10, resets_at: "2026-11-22T00:00:00.000Z" } }));
      return;
    }
    firstStarted?.();
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 100, resets_at: "2026-11-22T00:00:00.000Z" } }));
  });
  const claudeBin = writeProviderExecutable(
    path.join(bin, "claude"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
      if (args.includes("--print")) {
        console.log(JSON.stringify({
          type: "control_response",
          response: { request_id: "models", subtype: "success", response: { models: [{ value: "claude-opus-5-5" }] } }
        }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  try {
    const health = openRuntimeProviderHealthStore(userRoot),
      store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: claudeDir },
        discover: () => [witness("claude", claudeBin, "2.1.300")],
        providerHealth: health,
        now: () => "2026-11-21T10:00:00.000Z",
        quotaFetch: pinnedLoopbackFetch(server, requestedUrls),
      });
    const createPayload = {
      kind: "runtime-instance-create",
      instanceId: "claude-sec",
      name: "Claude Sec",
      kindId: "claude",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["claude-opus-5-5"],
      authMode: "subscription",
      credentialSource: "operator",
      isolationState: "operator-environment",
    };
    store.command(createPayload);

    // 1. HTTP 302 redirect is refused without following redirectTarget.
    const redirected = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(redirectTargetHit, false);
    assert.equal(
      ((redirected.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "ready",
    );
    assert.equal((redirected.instance as Record<string, unknown>).quota, undefined);

    // 2. Upstream error body with secret token never leaks.
    serverMode = "error-leak";
    const errored = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    const persistedAfterErr = readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8");
    assert.doesNotMatch(
      `${JSON.stringify(errored)}\n${String(errored.summary)}\n${persistedAfterErr}`,
      new RegExp(secretToken, "u"),
    );

    // 3. Successful response with tainted/secret/control-char plan field is dropped before DTO/disk/CLI.
    serverMode = "tainted-fields";
    const sanitized = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    const sanitizedQuota = (sanitized.instance as Record<string, unknown>).quota as { readonly plan: string | null };
    assert.equal(sanitizedQuota.plan, null);
    const persistedSanitized = readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8");
    assert.doesNotMatch(
      `${JSON.stringify(sanitized)}\n${String(sanitized.summary)}\n${persistedSanitized}`,
      new RegExp(secretToken, "u"),
    );

    // 4. Credits-only and 0%-without-resetAt NEVER clear quota exhaustion, and healthy quota NEVER clears 503 or freeze.
    health.recordQuotaExhausted({
      instanceId: "claude-sec",
      occurredAt: "2026-11-21T10:00:00.000Z",
      resetAt: "2026-11-22T00:00:00.000Z",
    });
    serverMode = "credits-only";
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-22T00:00:00.000Z");

    serverMode = "zero-no-reset";
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-22T00:00:00.000Z");

    health.recordFailure({
      instanceId: "claude-sec",
      reason: "HTTP 503",
      occurredAt: "2026-11-21T10:00:00.000Z",
      cooldownBaseSeconds: 3600,
    });
    serverMode = "tainted-fields";
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, null);
    assert.equal(health.get("claude-sec").reason, "HTTP 503");
    assert.equal(health.get("claude-sec").cooldownUntil, "2026-11-21T11:00:00.000Z");
    health.reset("claude-sec", "2026-11-21T10:01:00.000Z");

    // 4b. QUOTA-09: Observed 7d=0 (future reset) is NOT wiped when a subsequent partial response
    //     only reports a healthy 5h window; recovery only clears once 7d itself is confirmed healthy.
    serverMode = "seven-day-zero";
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");
    serverMode = "partial-5h-healthy";
    const afterPartial = (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true }))
      .instance as {
      readonly quota?: { readonly windows: ReadonlyArray<{ readonly id: string; readonly remainingFraction: number }> };
    };
    assert.equal(afterPartial.quota?.windows.find((w) => w.id === "five_hour")?.remainingFraction, 0.9);
    assert.equal(afterPartial.quota?.windows.find((w) => w.id === "seven_day")?.remainingFraction, 0);
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");
    serverMode = "both-healthy";
    await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, null);

    // 5. Two concurrent probes finishing out of order: older probe (1) cannot overwrite newer probe (2).
    serverMode = "race-1";
    const olderProbe = store.authStatus("claude-sec");
    await firstStartedPromise;
    const newerProbe = store.authStatus("claude-sec");
    assert.equal((await newerProbe).status, "ready");
    releaseFirst?.();
    await assert.rejects(
      olderProbe,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_instance_probe_stale",
    );
    const afterRace = (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec" })).instance as {
      readonly quota?: { readonly windows: ReadonlyArray<{ readonly remainingFraction: number }> };
    };
    assert.equal(afterRace.quota?.windows[0]?.remainingFraction, 0.9);
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, null);

    // 6. Mid-login credential swap & settlement fencing:
    //    - Cancelled login (exit 1) preserves existing health cooldown.
    //    - Probe started AFTER prepareAuthCommand (while old creds are on disk) cannot commit after new creds land!
    health.recordFailure({
      instanceId: "claude-sec",
      reason: "HTTP 503",
      occurredAt: "2026-11-21T10:00:00.000Z",
      cooldownBaseSeconds: 3600,
    });
    const cancelCmd = store.prepareAuthCommand("claude-sec", "login");
    const cancelCut = store.beginAuthSession("claude-sec", "login-cancelled", cancelCmd.accountCut)!;
    assert.ok(cancelCut);
    assert.equal((await store.authStatus("claude-sec")).code, "runtime_auth_in_progress");
    store.completeAuthSession("claude-sec", "login-cancelled", "login", 1, cancelCut);
    assert.equal(health.get("claude-sec").reason, "HTTP 503");
    assert.equal(health.get("claude-sec").cooldownUntil, "2026-11-21T11:00:00.000Z");

    // Probe started between prepareAuthCommand and credential swap is fenced by credential generation!
    firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    serverMode = "slow-relogin";
    const reloginCmd = store.prepareAuthCommand("claude-sec", "login");
    const midLoginOldProbe = store.authStatus("claude-sec");
    await firstStartedPromise;
    // New account credentials land on disk before the slow old-account probe finishes.
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-brand-new-account-token-999" } }),
      { mode: 0o600 },
    );
    store.completeAuthSession("claude-sec", "login-succeeded", "login", 0, reloginCmd.accountCut);
    releaseFirst?.();
    await assert.rejects(
      midLoginOldProbe,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_instance_probe_stale",
    );
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, null);
    assert.equal(
      (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec" })).instance?.quota,
      undefined,
    );

    // 6b. QUOTA-07: Interleaved login-A + rebind-B (and delete/recreate-B):
    //     When login-A's stale terminal later exits 0, completeAuthSession MUST verify the exact
    //     account cut/generation and act as a complete no-op without clearing B's quota/readiness/health!
    const loginA = store.prepareAuthCommand("claude-sec", "login");
    const loginACut = store.beginAuthSession("claude-sec", "stale-login-a", loginA.accountCut)!;
    assert.ok(loginACut);
    // Rebind the instance from operator -> instance credentialSource (account B) while login-A is still open.
    store.command({
      kind: "runtime-instance-update",
      instanceId: "claude-sec",
      credentialSource: "instance",
    });
    const instanceBClaudeDir = path.join(userRoot, "runtime-instances", "claude-sec", "home", ".claude");
    mkdirSync(instanceBClaudeDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(instanceBClaudeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-account-b-token-123" } }),
      { mode: 0o600 },
    );
    serverMode = "seven-day-zero";
    const probedB = await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec", probe: true });
    const quotaB = (probedB.instance as Record<string, unknown>).quota;
    assert.ok(quotaB);
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");
    // Now stale login-A terminal exits 0 -> MUST be a complete NO-OP!
    store.completeAuthSession("claude-sec", "stale-login-a", "login", 0, loginACut);
    const afterStaleExit = (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec" }))
      .instance as Record<string, unknown>;
    assert.equal((afterStaleExit.authReadiness as Record<string, unknown>).status, "ready");
    assert.deepEqual(afterStaleExit.quota, quotaB);
    assert.equal(health.get("claude-sec").quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");

    // Same check for delete + recreate with same instanceId while login-B is running:
    const loginB = store.prepareAuthCommand("claude-sec", "login");
    const loginBCut = store.beginAuthSession("claude-sec", "stale-login-b", loginB.accountCut)!;
    assert.ok(loginBCut);
    store.command({ kind: "runtime-instance-delete", instanceId: "claude-sec" });
    store.command(createPayload);
    serverMode = "both-healthy";
    const probedRecreated = await store.command({
      kind: "runtime-instance-show",
      instanceId: "claude-sec",
      probe: true,
    });
    const quotaRecreated = (probedRecreated.instance as Record<string, unknown>).quota;
    assert.ok(quotaRecreated);
    store.completeAuthSession("claude-sec", "stale-login-b", "login", 0, loginBCut);
    const afterRecreateExit = (await store.command({ kind: "runtime-instance-show", instanceId: "claude-sec" }))
      .instance as Record<string, unknown>;
    assert.equal((afterRecreateExit.authReadiness as Record<string, unknown>).status, "ready");
    assert.deepEqual(afterRecreateExit.quota, quotaRecreated);

    // 7. Daemon client RPC result validation rejects malformed quota WITHOUT echoing untrusted secret strings.
    let listError: unknown;
    try {
      parseClientRpcResponse("daemon.runtimeInstance.list", {
        schema: "command-receipt/v2",
        ok: true,
        instances: [
          {
            instanceId: "x",
            authReadiness: { status: "ready" },
            quota: { plan: secretToken, [secretToken]: "bad", windows: "bad" },
          },
        ],
      });
    } catch (error) {
      listError = error;
    }
    assert.ok(listError instanceof Error);
    assert.match(listError.message, /instances\[0\]\.quota/u);
    assert.doesNotMatch(listError.message, new RegExp(secretToken, "u"));
    assert.throws(
      () =>
        parseClientRpcResponse("daemon.runtimeInstance.show", {
          schema: "command-receipt/v2",
          ok: true,
          instance: {
            instanceId: "x",
            authReadiness: { status: "ready" },
            quota: {
              schemaVersion: 1,
              observedAt: "2026-11-21T10:00:00.000Z",
              source: "claude-oauth",
              plan: null,
              windows: [
                {
                  id: "five_hour",
                  label: "5h",
                  kind: ["session"],
                  remainingFraction: 0.5,
                  usedPercent: 50,
                  resetsAt: null,
                },
              ],
            },
          },
        }),
      /invalid_result|RuntimeSubscriptionQuotaV1/u,
    );
    assert.ok(requestCounter > 0);
  } finally {
    await Promise.all([server.close(), redirectTarget.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});
