// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonRegistry } from "../packages/kernel/src/daemon/registry.ts";
import { readFleetCenterConfig } from "../packages/daemon/src/daemon-host/fleet-center-config.ts";
import { openDaemonHost } from "../packages/daemon/src/daemon-host/daemon-host.ts";
import { createIdentityReadinessController } from "../packages/daemon/src/daemon-host/daemon-host-lifecycle-api.ts";
import { startDaemonMetricsServer } from "../packages/daemon/src/daemon-host/metrics-http-server.ts";
import { signInPolicyTestUser } from "../packages/daemon/test/keycloak-policy.fixtures.ts";
import { sqliteLedgerPath } from "../packages/storage/src/store/sqlite-ledger-layout.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const chartRoot = path.join(repoRoot, "deploy/helm/harness-center");
const templatesRoot = path.join(chartRoot, "templates");

function extractEntrypointScript() {
  const template = readFileSync(path.join(templatesRoot, "entrypoint-configmap.yaml"), "utf8");
  const marker = "  start-center.sh: |\n";
  const index = template.indexOf(marker);
  assert.ok(index >= 0, "entrypoint-configmap.yaml must define data.start-center.sh");
  const scriptLines = template
    .slice(index + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("    ") ? line.slice(4) : line));
  return `${scriptLines.join("\n").trimEnd()}\n`;
}

function waitForFile(filePath, timeoutMs = 10_000) {
  if (existsSync(filePath)) return Promise.resolve();
  const dir = path.dirname(filePath);
  const targetName = path.basename(filePath);
  return new Promise((resolve, reject) => {
    const watcher = watch(dir, (_eventType, filename) => {
      if ((filename === null || filename === targetName) && existsSync(filePath)) {
        clearTimeout(guard);
        watcher.close();
        resolve();
      }
    });
    const guard = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for file: ${filePath}`));
    }, timeoutMs);
    if (existsSync(filePath)) {
      clearTimeout(guard);
      watcher.close();
      resolve();
    }
  });
}

test("start-center.sh enforces PG storage, reconciles Fleet upgrades/disable, rejects OIDC drift, and preserves signal-safe PID 1 drain", async () => {
  const configmap = readFileSync(path.join(templatesRoot, "configmap.yaml"), "utf8");
  const deployment = readFileSync(path.join(templatesRoot, "deployment.yaml"), "utf8");
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  const entrypointScript = extractEntrypointScript();

  const daemonConsumers = [
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/metrics-http-server.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/runtime-relay-target.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/daemon-host-open.ts"), "utf8"),
    readFileSync(path.join(repoRoot, "packages/daemon/src/daemon-host/daemon-host-lifecycle-api.ts"), "utf8"),
  ].join("\n");

  // Every env key emitted by the chart has a real consumer
  const emittedEnvKeys = new Set([
    ...[...configmap.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gmu)].map((match) => match[1]),
    ...[...deployment.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
    ...[...statefulset.matchAll(/-\s*name:\s*([A-Z][A-Z0-9_]+)/gu)].map((match) => match[1]),
  ]);
  const nodeBuiltinEnvs = new Set(["NODE_EXTRA_CA_CERTS"]);
  assert.ok(emittedEnvKeys.size >= 12, "expected chart env keys to be checked");
  for (const key of emittedEnvKeys) {
    const consumed = nodeBuiltinEnvs.has(key) || daemonConsumers.includes(key) || entrypointScript.includes(key);
    assert.ok(consumed, `Helm chart emits unconsumed environment variable: ${key}`);
  }

  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-entrypoint-"));
  try {
    const scriptPath = path.join(sandbox, "start-center.sh");
    const userRoot = path.join(sandbox, "user");
    const repoRootDir = path.join(sandbox, "repos", "center");
    const repoRootV2Dir = path.join(sandbox, "repos", "center-v2");
    const oidcDir = path.join(sandbox, "oidc");
    const tlsDir = path.join(sandbox, "fleet-tls");
    const daemonLog = path.join(sandbox, "daemon-calls.jsonl");
    const cliLog = path.join(sandbox, "cli-calls.jsonl");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(oidcDir, { recursive: true });
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(scriptPath, entrypointScript, { mode: 0o755 });
    writeFileSync(path.join(oidcDir, "client-secret"), "oidc-secret-value-42\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.crt"), "DUMMY-CERT\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.key"), "DUMMY-KEY\n", { mode: 0o600 });

    // Deterministic event-driven stub daemon (zero fixed wall-clock shutdown timers):
    // - If STUB_WAIT_FOR_TERM=1 (or when rbac/config.json is absent during bootstrap), stays alive until SIGTERM,
    //   then drains (optionally waiting for a drain gate file) and exits cleanly.
    // - In exec steady-state mode (rbac/config.json already present), records its launch and exits immediately.
    const stubDaemon = path.join(sandbox, "stub-daemon.cjs");
    const stubCli = path.join(sandbox, "stub-cli.cjs");
    // Mirror real `ha daemon status`: only exit 0 after stubDaemon has observed initial hasRbac,
    // recorded its launch, installed its SIGTERM handler, and published its live PID marker.
    const stubDaemonStatusCheck = `
if (args[0] === "daemon" && args[1] === "status") {
  const readyMarker = path.join(process.env.HARNESS_DAEMON_USER_ROOT, ".stub-daemon-ready");
  if (!fs.existsSync(readyMarker)) process.exit(1);
  const pid = Number(fs.readFileSync(readyMarker, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) process.exit(1);
  try {
    process.kill(pid, 0);
  } catch {
    process.exit(1);
  }
  process.exit(0);
}
`;
    writeFileSync(
      stubDaemon,
      `
const fs = require("node:fs");
const path = require("node:path");
const userRoot = process.env.HARNESS_DAEMON_USER_ROOT;
const readyMarker = path.join(userRoot, ".stub-daemon-ready");
const readyFlag = process.env.STUB_READY_FILE;
const drainStarted = process.env.STUB_DRAIN_STARTED_FILE;
const drainMarker = process.env.STUB_DRAIN_COMPLETE_FILE;
const drainGate = process.env.STUB_DRAIN_GATE_FILE;
const writeAtomic = (targetPath, content) => {
  const tmpPath = targetPath + "." + String(process.pid) + ".tmp";
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, targetPath);
};
const cleanupReadyMarker = () => {
  try {
    if (fs.existsSync(readyMarker) && fs.readFileSync(readyMarker, "utf8").trim() === String(process.pid)) {
      fs.rmSync(readyMarker, { force: true });
    }
  } catch {
    // Best-effort cleanup during stub daemon shutdown.
  }
};
const hasRbac = fs.existsSync(path.join(userRoot, "rbac", "config.json"));
fs.appendFileSync(${JSON.stringify(daemonLog)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), hasRbac }) + "\\n");
if (hasRbac && process.env.STUB_WAIT_FOR_TERM !== "1") {
  if (readyFlag) writeAtomic(readyFlag, String(process.pid) + "\\n");
  process.exit(0);
}
// Register SIGTERM handler and event-loop keeper BEFORE writing readiness markers so callers cannot race startup or signals.
const keeper = fs.watch(userRoot, () => {});
let draining = false;
process.on("SIGTERM", () => {
  if (draining) return;
  draining = true;
  const finish = () => {
    keeper.close();
    cleanupReadyMarker();
    if (drainMarker) writeAtomic(drainMarker, "drained\\n");
    process.exit(0);
  };
  if (!drainGate || fs.existsSync(drainGate)) {
    if (drainStarted) writeAtomic(drainStarted, "draining\\n");
    finish();
    return;
  }
  // Register drainGate watcher BEFORE publishing drainStarted so callers cannot race creating drainGate.
  const watcher = fs.watch(path.dirname(drainGate), () => {
    if (fs.existsSync(drainGate)) {
      watcher.close();
      finish();
    }
  });
  if (drainStarted) writeAtomic(drainStarted, "draining\\n");
  if (fs.existsSync(drainGate)) {
    watcher.close();
    finish();
  }
});
writeAtomic(readyMarker, String(process.pid) + "\\n");
if (readyFlag) writeAtomic(readyFlag, String(process.pid) + "\\n");
`,
    );
    writeFileSync(
      stubCli,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stdin = args.includes("--client-secret-stdin") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify({ args, stdin }) + "\\n");
${stubDaemonStatusCheck}
if (args[0] === "bootstrap") {
  const rbacDir = path.join(process.env.HARNESS_DAEMON_USER_ROOT, "rbac");
  fs.mkdirSync(rbacDir, { recursive: true });
  const url = args[args.indexOf("--url") + 1].replace(/\\/$/, "");
  const realm = args[args.indexOf("--realm") + 1];
  const clientId = args[args.indexOf("--client-id") + 1];
  fs.writeFileSync(path.join(rbacDir, "config.json"), JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external", url, realm, clientId }) + "\\n");
  fs.writeFileSync(path.join(rbacDir, "center-client-secret"), (stdin || "").trim(), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, mode: "external" }) + "\\n");
}
`,
    );

    const sharedEnv = {
      ...process.env,
      HARNESS_DAEMON_ENTRY: stubDaemon,
      HARNESS_CLI_ENTRY: stubCli,
      HARNESS_DAEMON_ID: "center",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_STORAGE_BACKEND: "postgres",
      HARNESS_FLEET_ENABLED: "true",
      HARNESS_OIDC_ISSUER_URL: "https://idp.example.org",
      HARNESS_OIDC_REALM: "fleet",
      HARNESS_OIDC_CLIENT_ID: "harness-center",
      HARNESS_OIDC_CLIENT_SECRET_FILE: path.join(oidcDir, "client-secret"),
      HARNESS_FLEET_BIND: "0.0.0.0",
      HARNESS_FLEET_PORT: "7545",
      HARNESS_FLEET_EXTERNAL_URL: "https://center.example.org:7545",
      HARNESS_FLEET_AUTHORITY_REPO_ID: "org-center",
      HARNESS_FLEET_AUTHORITY_REPO_ROOT: repoRootDir,
      HARNESS_FLEET_QUOTA_BYTES: "1073741824",
      HARNESS_FLEET_TLS_CERT_FILE: path.join(tlsDir, "tls.crt"),
      HARNESS_FLEET_TLS_KEY_FILE: path.join(tlsDir, "tls.key"),
      HARNESS_BOOTSTRAP_WAIT_ATTEMPTS: "200",
      HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "0.05",
    };

    // F-G7-11: postgres backend without daemon-storage.json must fail closed (never silently fall back to SQLite)
    const missingPgRes = spawnSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });
    assert.notEqual(missingPgRes.status, 0, "postgres backend without daemon-storage.json must fail closed");
    assert.match(missingPgRes.stderr, /daemon-storage\.json/u);

    // Mount valid PostgreSQL daemon-storage.json
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
        "org-center-v2": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
      { mode: 0o600 },
    );

    // First boot: seeds registry + center.json, boots temporary daemon, runs external bootstrap, drains it, then execs steady-state daemon
    execFileSync("/bin/sh", [scriptPath], { env: sharedEnv, encoding: "utf8" });

    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.invalidRepos.length, 0);
    assert.equal(registry.repos[0]?.repoId, "org-center");
    assert.equal(registry.repos[0]?.canonicalRoot, path.resolve(repoRootDir));

    const fleetConfig = readFleetCenterConfig(userRoot, "center");
    assert.ok(fleetConfig);
    assert.equal(fleetConfig.port, 7545);
    assert.equal(fleetConfig.bind, "0.0.0.0");
    assert.equal(fleetConfig.externalUrl, "https://center.example.org:7545");
    assert.equal(fleetConfig.repoId, "org-center");

    const daemonCalls = readFileSync(daemonLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      daemonCalls.length,
      2,
      "first boot runs bootstrap daemon then hands off via exec to steady-state daemon",
    );
    assert.equal(daemonCalls[0].hasRbac, false);
    assert.equal(daemonCalls[1].hasRbac, true);

    const cliCalls = readFileSync(cliLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bootstrapCall = cliCalls.find((call) => call.args[0] === "bootstrap");
    assert.ok(bootstrapCall);
    assert.equal(bootstrapCall.stdin, "oidc-secret-value-42\n");

    // F-G7-09: Helm upgrade changes Fleet port, bind, externalUrl, and authorityRepoId -> persisted center.json & registry update!
    const upgradedEnv = {
      ...sharedEnv,
      HARNESS_FLEET_BIND: "127.0.0.1",
      HARNESS_FLEET_PORT: "8443",
      HARNESS_FLEET_EXTERNAL_URL: "https://upgraded.example.org:8443",
      HARNESS_FLEET_AUTHORITY_REPO_ID: "org-center-v2",
      HARNESS_FLEET_AUTHORITY_REPO_ROOT: repoRootV2Dir,
    };
    execFileSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    const upgradedFleet = readFleetCenterConfig(userRoot, "center");
    assert.ok(upgradedFleet);
    assert.equal(upgradedFleet.port, 8443);
    assert.equal(upgradedFleet.bind, "127.0.0.1");
    assert.equal(upgradedFleet.externalUrl, "https://upgraded.example.org:8443");
    assert.equal(upgradedFleet.repoId, "org-center-v2");
    assert.ok(
      readDaemonRegistry({ userRoot }).repos.some(
        (repo) => repo.repoId === "org-center-v2" && repo.canonicalRoot === path.resolve(repoRootV2Dir),
      ),
    );
    // Still only 1 bootstrap call (idempotent fast path when OIDC values match)
    assert.equal(
      readFileSync(cliLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((call) => call.args[0] === "bootstrap").length,
      1,
    );

    // F-G7-09: Disabling Fleet cleans up stale persisted center.json so openDaemonHost does not restore old listener
    execFileSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_FLEET_ENABLED: "false" },
      encoding: "utf8",
    });
    assert.equal(readFleetCenterConfig(userRoot, "center"), null, "fleet.enabled=false must remove stale center.json");

    // F-G7-09 & F-G7-20: OIDC issuer or secret drift fails closed with actionable rotate-before-upgrade / rollback instructions
    // (never telling operators to exec into the exited pod's unstarted daemon socket) and never prints secret values
    const driftedUrlRes = spawnSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_OIDC_ISSUER_URL: "https://new-idp.example.org" },
      encoding: "utf8",
    });
    assert.notEqual(driftedUrlRes.status, 0, "OIDC issuerUrl drift must fail closed");
    assert.match(driftedUrlRes.stderr, /issuerUrl/u);
    assert.match(driftedUrlRes.stderr, /roll back/iu);
    assert.match(driftedUrlRes.stderr, /ha bootstrap --operation login/u);
    assert.doesNotMatch(
      driftedUrlRes.stderr,
      /against the pod daemon socket/iu,
      "drift message must not instruct operators to connect to the exited pod's unstarted daemon socket",
    );
    const opsDoc = readFileSync(path.join(repoRoot, "docs-release/observability-and-deployment.md"), "utf8");
    assert.match(opsDoc, /Rotating or changing external OIDC/u);
    assert.match(opsDoc, /helm rollback/u);

    const rotatedSecretFile = path.join(oidcDir, "rotated-secret");
    writeFileSync(rotatedSecretFile, "super-sensitive-rotated-secret-999\n", { mode: 0o600 });
    const driftedSecretRes = spawnSync("/bin/sh", [scriptPath], {
      env: { ...upgradedEnv, HARNESS_OIDC_CLIENT_SECRET_FILE: rotatedSecretFile },
      encoding: "utf8",
    });
    assert.notEqual(driftedSecretRes.status, 0, "OIDC client secret drift must fail closed");
    assert.match(driftedSecretRes.stderr, /clientSecret/u);
    assert.ok(
      !driftedSecretRes.stderr.includes("super-sensitive-rotated-secret-999"),
      "OIDC drift diagnostic must never print secret values",
    );

    // F-G7-17: 2-repo upgrade / Secret removal — org-center and org-center-v2 are both enabled in registry.json;
    // removing org-center from daemon-storage.json must fail closed BEFORE invoking daemon (never opening SQLite for org-center)
    const daemonLinesBefore = readFileSync(daemonLog, "utf8").trim().split("\n").length;
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center-v2": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
      { mode: 0o600 },
    );
    const missingSecondRepoPg = spawnSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    assert.notEqual(
      missingSecondRepoPg.status,
      0,
      "removing a registered enabled repo from PG Secret must fail closed before daemon launch",
    );
    assert.match(missingSecondRepoPg.stderr, /org-center/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT be started (and no SQLite ledger opened) when any enabled registered repo lacks PG config",
    );

    // F-G7-22: Malformed PG Secret containing a synthetic credential must fail closed with redacted error (zero secret leakage)
    const secretToken = "SYNTHETIC_PG_SECRET_TOKEN_778899";
    writeFileSync(
      path.join(userRoot, "daemon-storage.json"),
      `{"org-center": {"connectionString": "postgresql://admin:${secretToken}@db.internal/ha" INVALID_JSON`,
      { mode: 0o600 },
    );
    const badJsonRes = spawnSync("/bin/sh", [scriptPath], { env: upgradedEnv, encoding: "utf8" });
    assert.notEqual(badJsonRes.status, 0, "malformed daemon-storage.json must fail closed");
    assert.match(badJsonRes.stderr, /not valid JSON \(parse details redacted\)/u);
    assert.ok(
      !badJsonRes.stdout.includes(secretToken) && !badJsonRes.stderr.includes(secretToken),
      "malformed PG Secret parse diagnostic must never leak secret contents",
    );

    // F-G7-22: Empty/whitespace metrics bearer token when HARNESS_DAEMON_METRICS_REQUIRE_AUTH=1 fails closed before daemon start
    const emptyBearerRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_DAEMON_METRICS_REQUIRE_AUTH: "1",
        HARNESS_DAEMON_METRICS_BEARER_TOKEN: "   ",
      },
      encoding: "utf8",
    });
    assert.notEqual(emptyBearerRes.status, 0, "empty metrics bearer token must fail closed");
    assert.match(emptyBearerRes.stderr, /HARNESS_DAEMON_METRICS_BEARER_TOKEN/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT start when configured metrics bearer token is empty",
    );

    // F-G7-27: Overlapping HARNESS_FLEET_PORT and HARNESS_DAEMON_METRICS_PORT fails closed before daemon start
    const overlapPortRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_FLEET_ENABLED: "true",
        HARNESS_FLEET_PORT: "9090",
        HARNESS_DAEMON_METRICS_PORT: "9090",
      },
      encoding: "utf8",
    });
    assert.notEqual(
      overlapPortRes.status,
      0,
      "overlapping Fleet and metrics ports must fail closed in start-center.sh",
    );
    assert.match(overlapPortRes.stderr, /HARNESS_FLEET_PORT.*HARNESS_DAEMON_METRICS_PORT/u);
    assert.equal(
      readFileSync(daemonLog, "utf8").trim().split("\n").length,
      daemonLinesBefore,
      "daemon must NOT start when Fleet and metrics share the same container port",
    );

    // F-G7-31 & F-G7-36: First-time bootstrap returning exit 0 with authoritySync.pending=true, empty stdout,
    // malformed JSON, or ok:false MUST fail closed AND persist .oidc-bootstrap-pending so container restart
    // re-runs authoritative bootstrap instead of skipping to steady-state serve!
    const pendingBootRoot = path.join(sandbox, "pending-boot-user");
    mkdirSync(pendingBootRoot, { recursive: true });
    writeFileSync(
      path.join(pendingBootRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
    );
    const pendingBootstrapAttemptsLog = path.join(sandbox, "pending-bootstrap-attempts.jsonl");
    const pendingBootstrapCli = path.join(sandbox, "pending-bootstrap-cli.cjs");
    writeFileSync(
      pendingBootstrapCli,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
${stubDaemonStatusCheck}
if (args[0] === "bootstrap") {
  const mode = process.env.STUB_BOOTSTRAP_MODE || "pending";
  fs.appendFileSync(${JSON.stringify(pendingBootstrapAttemptsLog)}, JSON.stringify({ mode, args }) + "\\n");
  // Mirror real OidcSessionService: rbac/config.json is persisted BEFORE discovery runs
  const rbacDir = path.join(process.env.HARNESS_DAEMON_USER_ROOT, "rbac");
  fs.mkdirSync(rbacDir, { recursive: true });
  const stdin = fs.readFileSync(0, "utf8").trim();
  const url = args[args.indexOf("--url") + 1].replace(/\\/$/, "");
  const realm = args[args.indexOf("--realm") + 1];
  const clientId = args[args.indexOf("--client-id") + 1];
  fs.writeFileSync(path.join(rbacDir, "config.json"), JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external", url, realm, clientId }) + "\\n");
  fs.writeFileSync(path.join(rbacDir, "center-client-secret"), stdin, { mode: 0o600 });
  if (mode === "pending") {
    process.stdout.write(JSON.stringify({ ok: true, mode: "external", authoritySync: { ok: false, pending: true, code: "oidc_discovery_unavailable" } }) + "\\n");
  } else if (mode === "empty") {
    // empty stdout
  } else if (mode === "malformed") {
    process.stdout.write("not-json\\n");
  } else if (mode === "ok-false") {
    process.stdout.write(JSON.stringify({ ok: false, code: "oidc_failed" }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, mode: "external" }) + "\\n");
  }
}
process.exit(0);
`,
    );
    for (const [mode, expectedErr] of [
      ["empty", /empty receipt/u],
      ["malformed", /not valid JSON/u],
      ["ok-false", /did not report ok=true/u],
      ["pending", /authoritySync\.pending=true/u],
    ]) {
      const badRes = spawnSync("/bin/sh", [scriptPath], {
        env: {
          ...sharedEnv,
          HARNESS_DAEMON_USER_ROOT: pendingBootRoot,
          HARNESS_CLI_ENTRY: pendingBootstrapCli,
          STUB_BOOTSTRAP_MODE: mode,
        },
        encoding: "utf8",
      });
      assert.notEqual(badRes.status, 0, `bootstrap mode=${mode} must fail closed in start-center.sh`);
      assert.match(badRes.stderr, expectedErr);
      assert.equal(
        existsSync(path.join(pendingBootRoot, "rbac", ".oidc-bootstrap-pending")),
        true,
        `bootstrap mode=${mode} must preserve .oidc-bootstrap-pending marker across restart`,
      );
    }
    // Restart after pending/malformed failure with IdP now healthy: start-center.sh MUST detect .oidc-bootstrap-pending,
    // re-run bootstrap (NOT skip to serve even though rbac/config.json already matched), and clear the marker once ok=true!
    const attemptsBeforeRecovery = readFileSync(pendingBootstrapAttemptsLog, "utf8").trim().split("\n").length;
    assert.equal(attemptsBeforeRecovery, 4);
    const recoveredRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: pendingBootRoot,
        HARNESS_CLI_ENTRY: pendingBootstrapCli,
        STUB_BOOTSTRAP_MODE: "ok",
      },
      encoding: "utf8",
    });
    assert.equal(recoveredRes.status, 0, `restart recovery bootstrap must succeed: ${recoveredRes.stderr}`);
    assert.equal(
      readFileSync(pendingBootstrapAttemptsLog, "utf8").trim().split("\n").length,
      5,
      "restart after pending bootstrap must re-invoke bootstrap rather than skipping straight to serve",
    );
    assert.equal(
      existsSync(path.join(pendingBootRoot, "rbac", ".oidc-bootstrap-pending")),
      false,
      "successful authoritative bootstrap must remove .oidc-bootstrap-pending marker",
    );

    // F-G7-38: Entrypoint rejects normalized mount path collisions (e.g. userRoot/../user) and half-configured env pairs
    const normalizedCollisionRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_FLEET_AUTHORITY_REPO_ROOT: `${userRoot}/../${path.basename(userRoot)}`,
      },
      encoding: "utf8",
    });
    assert.notEqual(
      normalizedCollisionRes.status,
      0,
      "entrypoint must reject normalized userRoot/authorityRepoRoot collision",
    );
    assert.match(normalizedCollisionRes.stderr, /disjoint normalized absolute paths/u);

    const halfOidcRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_OIDC_ISSUER_URL: "",
        HARNESS_OIDC_CLIENT_SECRET_FILE: path.join(oidcDir, "client-secret"),
      },
      encoding: "utf8",
    });
    assert.notEqual(halfOidcRes.status, 0, "entrypoint must reject OIDC client secret file without issuer URL");
    assert.match(halfOidcRes.stderr, /HARNESS_OIDC_ISSUER_URL/u);

    const halfFleetRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...upgradedEnv,
        HARNESS_FLEET_AUTHORITY_REPO_ID: "",
        HARNESS_FLEET_TLS_CERT_FILE: path.join(tlsDir, "tls.crt"),
      },
      encoding: "utf8",
    });
    assert.notEqual(halfFleetRes.status, 0, "entrypoint must reject Fleet TLS cert without authority repo ID");
    assert.match(halfFleetRes.stderr, /HARNESS_FLEET_AUTHORITY_REPO_ID/u);

    // F-G7-14 & F-G7-21: SIGTERM during blocked bootstrap CLI (not just wait-loop sleep) interrupts immediately,
    // triggers daemon drain, waits for drain completion, and preserves real child exit codes on crashes/failures
    const drainRoot = path.join(sandbox, "drain-user");
    mkdirSync(drainRoot, { recursive: true });
    writeFileSync(
      path.join(drainRoot, "daemon-storage.json"),
      JSON.stringify({
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
    );
    const readyFile = path.join(sandbox, "drain-ready");
    const bootstrapStartedFile = path.join(sandbox, "bootstrap-started");
    const drainStartedFile = path.join(sandbox, "drain-started");
    const drainGateFile = path.join(sandbox, "drain-gate");
    const drainCompleteFile = path.join(sandbox, "drain-complete");
    const blockingBootstrapCli = path.join(sandbox, "blocking-bootstrap-cli.cjs");
    // daemon status waits until stubDaemon is ready, then `bootstrap` installs SIGTERM handler before publishing bootstrapStartedFile
    writeFileSync(
      blockingBootstrapCli,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
${stubDaemonStatusCheck}
if (args[0] === "bootstrap") {
  const keeper = fs.watch(${JSON.stringify(sandbox)}, () => {});
  process.on("SIGTERM", () => {
    keeper.close();
    process.exit(143);
  });
  const tmpFile = ${JSON.stringify(bootstrapStartedFile)} + "." + String(process.pid) + ".tmp";
  fs.writeFileSync(tmpFile, String(process.pid) + "\\n");
  fs.renameSync(tmpFile, ${JSON.stringify(bootstrapStartedFile)});
}
`,
    );

    const shellChild = spawn("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: drainRoot,
        HARNESS_CLI_ENTRY: blockingBootstrapCli,
        HARNESS_BOOTSTRAP_WAIT_ATTEMPTS: "200",
        HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "0.05",
        STUB_READY_FILE: readyFile,
        STUB_DRAIN_STARTED_FILE: drainStartedFile,
        STUB_DRAIN_GATE_FILE: drainGateFile,
        STUB_DRAIN_COMPLETE_FILE: drainCompleteFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await waitForFile(readyFile);
    await waitForFile(bootstrapStartedFile);
    let shellExited = false;
    const shellExitPromise = new Promise((resolve) => {
      shellChild.once("exit", (code, signal) => {
        shellExited = true;
        resolve({ code, signal });
      });
    });

    // Send SIGTERM to start-center.sh WHILE `ha bootstrap` CLI is blocked indefinitely
    shellChild.kill("SIGTERM");
    // Must interrupt blocked bootstrap CLI and forward SIGTERM to daemon promptly
    await waitForFile(drainStartedFile);
    assert.equal(shellExited, false, "PID 1 shell must not exit before background daemon completes drain");
    assert.equal(existsSync(drainCompleteFile), false);

    // Release daemon drain gate; daemon finishes drain, writes drainCompleteFile, then PID 1 exits 143
    writeFileSync(drainGateFile, "go\n");
    const exitResult = await shellExitPromise;
    assert.equal(existsSync(drainCompleteFile), true, "daemon must have finished draining before PID 1 exited");
    assert.equal(exitResult.code, 143);

    // F-G7-21: Real non-zero child exit codes are preserved (both crashed daemon and failed bootstrap CLI)
    const crashDaemon = path.join(sandbox, "crash-daemon.cjs");
    writeFileSync(crashDaemon, "process.exit(42);\n");
    const unavailableStatusCli = path.join(sandbox, "unavailable-status-cli.cjs");
    writeFileSync(unavailableStatusCli, "process.exit(1);\n");
    const crashRoot = path.join(sandbox, "crash-user");
    mkdirSync(crashRoot, { recursive: true });
    writeFileSync(
      path.join(crashRoot, "daemon-storage.json"),
      readFileSync(path.join(drainRoot, "daemon-storage.json")),
    );
    const crashRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: crashRoot,
        HARNESS_DAEMON_ENTRY: crashDaemon,
        HARNESS_CLI_ENTRY: unavailableStatusCli,
        HARNESS_BOOTSTRAP_WAIT_INTERVAL_SECONDS: "0",
      },
      encoding: "utf8",
    });
    assert.equal(crashRes.status, 42, "start-center.sh must preserve real exit code of an already-exited daemon child");

    const failBootRoot = path.join(sandbox, "fail-boot-user");
    mkdirSync(failBootRoot, { recursive: true });
    writeFileSync(
      path.join(failBootRoot, "daemon-storage.json"),
      readFileSync(path.join(drainRoot, "daemon-storage.json")),
    );
    const failBootstrapCli = path.join(sandbox, "fail-bootstrap-cli.cjs");
    writeFileSync(
      failBootstrapCli,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
${stubDaemonStatusCheck}
process.exit(args[0] === "bootstrap" ? 7 : 0);
`,
    );
    const failBootRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...sharedEnv,
        HARNESS_DAEMON_USER_ROOT: failBootRoot,
        HARNESS_CLI_ENTRY: failBootstrapCli,
      },
      encoding: "utf8",
    });
    assert.equal(failBootRes.status, 7, "start-center.sh must preserve real exit code of failed bootstrap CLI");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("container /readyz tracks live OIDC revocation/recovery and per-target authoritySync.pending (F-G7-20, F-G7-31)", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-helm-oidc-readyz-"));
  const rbacDir = path.join(userRoot, "rbac");
  const workspaceA = path.join(userRoot, "ws-a");
  const workspaceB = path.join(userRoot, "ws-b");
  mkdirSync(rbacDir, { recursive: true });
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });

  let centerHealthy = false;
  let defaultStatusHealthy = false;
  let workspaceAStatusHealthy = false;
  let centerTokenCounter = 0;
  const rejectedTokensSeen = [];
  const statusTargetsSeen = [];
  let configureOutcome = {
    ok: true,
    mode: "external",
    authoritySync: { ok: false, pending: true, code: "oidc_discovery_unavailable", message: "Keycloak down" },
  };
  let configureShouldThrow = true;

  const fakeOidc = {
    configured: () => existsSync(path.join(rbacDir, "config.json")),
    centerConfigured: () =>
      existsSync(path.join(rbacDir, "config.json")) && existsSync(path.join(rbacDir, "center-client-secret")),
    center: async (rejectedAccessToken) => {
      if (rejectedAccessToken !== undefined) rejectedTokensSeen.push(rejectedAccessToken);
      if (!centerHealthy) throw new Error("OIDC client credentials revoked or unreachable");
      centerTokenCounter += 1;
      return {
        url: "https://idp.example.org",
        realm: "fleet",
        accessToken: `tok-${centerTokenCounter}`,
        provider: {},
      };
    },
    status: async (loginTarget) => {
      statusTargetsSeen.push(loginTarget ?? "<default>");
      if (loginTarget === workspaceA) {
        if (!workspaceAStatusHealthy) throw new Error("workspaceA OIDC discovery unavailable");
        return { ok: true, authenticated: false };
      }
      if (!defaultStatusHealthy) throw new Error("default OIDC discovery unavailable");
      return { ok: true, authenticated: false };
    },
    configureAuthority: async (operation) => {
      await operation();
      return configureOutcome;
    },
    bind: async (auth) => auth,
    discovery: () => null,
    begin: async () => ({}),
    complete: async () => ({}),
    beginDevice: async () => ({}),
    deviceApproval: async () => ({}),
    pollDevice: async () => ({}),
    bindingHealth: async () => ({ ok: centerHealthy }),
    logout: async () => ({ ok: true }),
    bootstrapStatus: async () => ({ ok: true, required: false }),
    interactiveAuthority: async () => ({ url: "https://idp.example.org", realm: "fleet", clientId: "harness-center" }),
    requireAccessManagement: async () => {
      throw new Error("not used");
    },
    requireSession: async () => {
      throw new Error("not used");
    },
    serialize: async (op) => op(),
    bootstrapAdmin: async () => ({ ok: true }),
    invite: async () => ({ ok: true }),
  };

  const fakeManagedRbac = {
    run: async () => {
      if (configureShouldThrow) throw new Error("external OIDC endpoint refused connection");
      writeFileSync(
        path.join(rbacDir, "config.json"),
        JSON.stringify({
          schema: "harness-managed-rbac/v1",
          mode: "external",
          url: "https://idp.example.org",
          realm: "fleet",
          clientId: "harness-center",
        }),
      );
      writeFileSync(path.join(rbacDir, "center-client-secret"), "secret-value");
      return { ok: true, mode: "external" };
    },
    resume: async () => undefined,
    stop: async () => undefined,
    loginListenerCertificate: () => null,
  };

  const host = await openDaemonHost({
    daemonId: "helm-oidc-readyz",
    userRoot,
    requireIdentityReady: true,
    identityReadyReverifyIntervalMs: 0,
    oidc: fakeOidc,
    managedRbac: fakeManagedRbac,
  });
  const server = await startDaemonMetricsServer({
    config: { bind: "127.0.0.1", port: 0, path: "/metrics", bearerToken: null },
    daemonId: "helm-oidc-readyz",
    collectSnapshot: () => ({
      daemonId: "helm-oidc-readyz",
      version: "0.1.0",
      commit: "test",
      uptimeSeconds: 1,
      processResidentMemoryBytes: 1_000,
      processHeapUsedBytes: 500,
      activeRuntimeSessions: 0,
      rpc: {
        requestsOk: 0,
        requestsError: 0,
        inflight: 0,
        durationBuckets: [],
        durationSumSeconds: 0,
        durationCount: 0,
        quantiles: { p50: 0, p95: 0, p99: 0 },
      },
      fleet: host.observabilitySnapshot().fleet,
      repos: host.observabilitySnapshot().repos,
    }),
    isLive: () => true,
    isReady: () => host.probeSnapshot(),
  });
  const origin = new URL(server.endpoint).origin;
  const settleAsync = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    // 1. Before configuration: /readyz is 503 identity_not_configured
    let res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);
    assert.ok((await res.json()).reasons.includes("identity_not_configured"));

    // 2. External OIDC initialization throws -> /readyz stays 503
    await assert.rejects(
      () =>
        host.manageRbac(
          { mode: "external", operation: "bootstrap", rootDir: workspaceA },
          { transportKind: "unix-socket" },
        ),
      /refused connection/u,
    );
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);

    // 3. configureAuthority on workspaceA returns authoritySync.pending === true ->
    //    default scope status(undefined) succeeding MUST NOT clear workspaceA's pending sync!
    configureShouldThrow = false;
    const pendingRes = await host.manageRbac(
      { mode: "external", operation: "bootstrap", rootDir: workspaceA },
      { transportKind: "unix-socket" },
    );
    assert.equal(pendingRes.ok, true);
    assert.equal(pendingRes.authoritySync.pending, true);

    defaultStatusHealthy = true;
    centerHealthy = true;
    workspaceAStatusHealthy = false;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503, "default scope recovery must not clear workspaceA pending authoritySync");
    const stillPending = await res.json();
    assert.ok(
      stillPending.reasons.includes("identity_authority_sync_pending"),
      `expected identity_authority_sync_pending while workspaceA is still failing, got ${JSON.stringify(stillPending)}`,
    );
    assert.ok(
      statusTargetsSeen.includes(workspaceA),
      `expected oidc.status to be invoked with workspaceA target, saw ${JSON.stringify(statusTargetsSeen)}`,
    );

    // 4. Even if workspaceB configures cleanly, workspaceA's pending target remains pending until workspaceA recovers
    configureOutcome = { ok: true, mode: "external" };
    await host.manageRbac(
      { mode: "external", operation: "bootstrap", rootDir: workspaceB },
      { transportKind: "unix-socket" },
    );
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503);
    assert.ok((await res.json()).reasons.includes("identity_authority_sync_pending"));

    // 5. workspaceA discovery recovers -> /readyz transitions to 200 ready
    workspaceAStatusHealthy = true;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");

    // 6. F-G7-31: Upstream service credential is later revoked -> /readyz re-verifies with rejectedAccessToken and transitions to 503 identity_unavailable!
    centerHealthy = false;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 503, "revoked upstream credential must transition /readyz from 200 back to 503");
    const revokedBody = await res.json();
    assert.ok(
      revokedBody.reasons.includes("identity_unavailable"),
      `expected identity_unavailable after revocation, got ${JSON.stringify(revokedBody)}`,
    );
    assert.ok(
      rejectedTokensSeen.length >= 1,
      "live re-verification must pass previous accessToken to invalidate cached center token",
    );

    // 7. Upstream recovers -> /readyz transitions back from 503 to 200 ready
    centerHealthy = true;
    await fetch(`${origin}/readyz`);
    await settleAsync();
    res = await fetch(`${origin}/readyz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ready");

    // Direct controller check: verify throttling respects readyReverifyIntervalMs via injected clock
    let clockMs = 1_000;
    let directCenterCalls = 0;
    const controller = createIdentityReadinessController({
      requireIdentityReady: true,
      hasConfiguredIdentity: () => true,
      ensureRbacResumed: async () => undefined,
      checkOidcStatus: async () => ({ ok: true }),
      checkOidcCenter: async () => {
        directCenterCalls += 1;
        return { accessToken: `direct-${directCenterCalls}` };
      },
      isClosing: () => false,
      nowMs: () => clockMs,
      readyReverifyIntervalMs: 10_000,
    });
    controller.start();
    await settleAsync();
    assert.equal(controller.currentState(), "ready");
    assert.equal(directCenterCalls, 1);
    clockMs += 5_000;
    assert.equal(controller.currentState(), "ready");
    await settleAsync();
    assert.equal(directCenterCalls, 1, "re-verification must stay throttled within readyReverifyIntervalMs");
    clockMs += 5_000;
    assert.equal(controller.currentState(), "ready");
    await settleAsync();
    assert.equal(directCenterCalls, 2, "re-verification must run once readyReverifyIntervalMs elapses");

    // F-G7-36: Stale in-flight verification for the SAME target must NEVER clear a newer pending mark on that target
    let sameTargetStatusCalls = 0;
    let sameTargetCenterCalls = 0;
    const firstCheck = Promise.withResolvers();
    const secondCheck = Promise.withResolvers();
    const raceController = createIdentityReadinessController({
      requireIdentityReady: true,
      hasConfiguredIdentity: () => true,
      ensureRbacResumed: async () => undefined,
      checkOidcStatus: async (target) => {
        if (target === "/workspace") {
          sameTargetStatusCalls += 1;
          if (sameTargetStatusCalls === 1) await firstCheck.promise;
          else await secondCheck.promise;
        }
        return { ok: true };
      },
      checkOidcCenter: async () => {
        sameTargetCenterCalls += 1;
        return { accessToken: `race-${sameTargetCenterCalls}` };
      },
      isClosing: () => false,
    });
    await raceController.observeConfigured({ ok: true, authoritySync: { pending: true } }, "/workspace");
    assert.equal(raceController.currentState(), "identity_authority_sync_pending");
    await settleAsync();
    assert.equal(sameTargetStatusCalls, 1, "first check must have entered checkOidcStatus('/workspace')");
    // Re-mark the SAME target pending while first check is still paused
    await raceController.observeConfigured({ ok: true, authoritySync: { pending: true } }, "/workspace");
    // Release stale first check -> MUST NOT clear /workspace or transition to ready!
    firstCheck.resolve();
    await settleAsync();
    assert.equal(
      raceController.currentState(),
      "identity_authority_sync_pending",
      "stale verification completion must not clear newer pending sync for same target",
    );
    await settleAsync();
    assert.equal(
      sameTargetStatusCalls,
      2,
      "controller must launch a fresh check for /workspace after stale one finishes",
    );
    assert.equal(raceController.currentState(), "identity_authority_sync_pending");
    secondCheck.resolve();
    await settleAsync();
    assert.equal(raceController.currentState(), "ready");
    assert.equal(sameTargetCenterCalls, 1);

    // F-G7-36: Persisted .oidc-bootstrap-pending workspace target is reloaded on daemon restart
    const restartRoot = mkdtempSync(path.join(tmpdir(), "ha-helm-oidc-restart-"));
    try {
      mkdirSync(path.join(restartRoot, "rbac"), { recursive: true });
      writeFileSync(
        path.join(restartRoot, "rbac", "config.json"),
        JSON.stringify({
          schema: "harness-managed-rbac/v1",
          mode: "external",
          url: "https://idp.example.org",
          realm: "fleet",
          clientId: "harness-center",
        }),
      );
      writeFileSync(path.join(restartRoot, "rbac", "center-client-secret"), "secret-value");
      writeFileSync(path.join(restartRoot, "rbac", ".oidc-bootstrap-pending"), `${workspaceA}\n`);
      let wsAHealthyAfterRestart = false;
      const seenTargetsAfterRestart = [];
      const restartedHost = await openDaemonHost({
        daemonId: "helm-oidc-restart",
        userRoot: restartRoot,
        requireIdentityReady: true,
        oidc: {
          ...fakeOidc,
          configured: () => true,
          centerConfigured: () => true,
          status: async (loginTarget) => {
            seenTargetsAfterRestart.push(loginTarget ?? "<default>");
            if (loginTarget === workspaceA && !wsAHealthyAfterRestart) {
              throw new Error("workspaceA discovery still down after restart");
            }
            return { ok: true, authenticated: false };
          },
          center: async () => ({
            url: "https://idp.example.org",
            realm: "fleet",
            accessToken: "restart-tok",
            provider: {},
          }),
        },
        managedRbac: fakeManagedRbac,
      });
      try {
        await settleAsync();
        const probeDown = restartedHost.probeSnapshot();
        assert.equal(probeDown.ready, false);
        assert.ok(probeDown.reasons.includes("identity_authority_sync_pending"));
        assert.ok(
          seenTargetsAfterRestart.includes(workspaceA),
          `restarted daemon must verify persisted pending workspace target, saw ${JSON.stringify(seenTargetsAfterRestart)}`,
        );
        wsAHealthyAfterRestart = true;
        restartedHost.probeSnapshot();
        await settleAsync();
        assert.equal(restartedHost.probeSnapshot().ready, true);
      } finally {
        await restartedHost.close();
      }
    } finally {
      rmSync(restartRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  } finally {
    await server.close();
    await host.close();
    rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("StatefulSet PVC root + authority-repo subPath persist SQLite ledger across Pod replacement and preserve pre-release PVC upgrades (F-G7-29, F-G7-40)", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-pod-replace-"));
  const pvcRoot = path.join(sandbox, "pvc-daemon-state");
  const pvcAuthorityRepoSubPath = path.join(pvcRoot, "authority-repo");
  mkdirSync(pvcRoot, { recursive: true });
  mkdirSync(pvcAuthorityRepoSubPath, { recursive: true });

  // Verify the rendered StatefulSet mounts daemon.userRoot at PVC root (no subPath: user) and fleet.authorityRepoRoot at subPath: authority-repo
  const statefulset = readFileSync(path.join(templatesRoot, "statefulset.yaml"), "utf8");
  assert.ok(!statefulset.includes("subPath: user") && statefulset.includes("subPath: authority-repo"));

  const pod1Ephemeral = path.join(sandbox, "pod-1-rootfs");
  const pod2Ephemeral = path.join(sandbox, "pod-2-rootfs");
  mkdirSync(pod1Ephemeral, { recursive: true });
  mkdirSync(pod2Ephemeral, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const runGit = (cwd, args) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  };
  try {
    // Initialize a clean Git repo inside the PVC's authority-repo subPath (mounted at fleet.authorityRepoRoot)
    runGit(pvcAuthorityRepoSubPath, ["init", "-q", "-b", "main"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "user.name", "Helm Pod Replacement Test"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "user.email", "helm-test@example.invalid"]);
    runGit(pvcAuthorityRepoSubPath, ["config", "gc.auto", "0"]);
    runGit(pvcAuthorityRepoSubPath, ["commit", "--allow-empty", "-q", "-m", "init"]);

    // Sign in test owner into the PVC root (daemon.userRoot) so Pod 1 and Pod 2 share the persisted identity session
    signInPolicyTestUser(pvcRoot, "writer", ["center-sqlite"], "admin");

    // Pod 1: boots with PVC root (userRoot) + authority-repo subPath, bootstraps SQLite authority repo, and writes a canonical fact revision
    const pod1Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pvcRoot,
      requiredStorageBackend: "sqlite",
    });
    let revisionAfterPod1 = 0;
    let recordedFactId = "";
    const localOwnerAuth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary",
      },
    };
    try {
      const bootstrapped = await pod1Host.bootstrap(
        {
          rootDir: pvcAuthorityRepoSubPath,
          repoId: "center-sqlite",
          personId: "writer",
          displayName: "Writer",
        },
        localOwnerAuth,
      );
      assert.equal(bootstrapped.outcome, "applied", `Pod 1 bootstrap failed: ${JSON.stringify(bootstrapped)}`);
      const createdTask = await pod1Host.run(
        "center-sqlite",
        {
          kind: "task-create",
          taskId: "task_pvc_persist",
          title: "Verify StatefulSet PVC SQLite persistence",
        },
        localOwnerAuth,
      );
      assert.equal(createdTask.outcome, "applied", `Pod 1 task-create failed: ${JSON.stringify(createdTask)}`);
      const recorded = await pod1Host.run(
        "center-sqlite",
        {
          kind: "fact-record",
          taskId: "task_pvc_persist",
          statement: "StatefulSet PVC authority-repo subPath persists SQLite ledger across Pod replacement.",
          evidenceSource: "test:helm-pod-replacement",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
        },
        localOwnerAuth,
      );
      assert.equal(recorded.outcome, "applied", `Pod 1 fact-record failed: ${JSON.stringify(recorded)}`);
      recordedFactId = String(recorded.factId ?? "");
      assert.ok(recordedFactId.startsWith("F-"), `expected canonical factId, got ${JSON.stringify(recorded)}`);
      const status1 = pod1Host.observabilitySnapshot().repos.find((r) => r.repoId === "center-sqlite");
      assert.ok(status1, "Pod 1 must attach center-sqlite");
      assert.ok(
        typeof status1.ledgerRevision === "number" && status1.ledgerRevision > 0,
        `expected positive ledgerRevision after Pod 1 write, got ${JSON.stringify(status1)}`,
      );
      revisionAfterPod1 = status1.ledgerRevision;
      const ledgerFile = sqliteLedgerPath(pvcAuthorityRepoSubPath);
      assert.equal(
        existsSync(ledgerFile),
        true,
        `SQLite ledger must reside inside PVC authority-repo subPath: ${ledgerFile}`,
      );
    } finally {
      await pod1Host.close();
    }

    // Simulate Pod 1 termination & replacement: delete Pod 1 ephemeral rootfs completely; Pod 2 sees ONLY the PVC
    rmSync(pod1Ephemeral, { recursive: true, force: true });

    const pod2Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pvcRoot,
      requiredStorageBackend: "sqlite",
    });
    try {
      await pod2Host.attachmentsSettled();
      const status2 = pod2Host.observabilitySnapshot().repos.find((r) => r.repoId === "center-sqlite");
      assert.ok(status2, "Pod 2 must re-attach center-sqlite from persisted PVC registry");
      assert.equal(status2.state, "attached");
      assert.equal(
        status2.ledgerRevision,
        revisionAfterPod1,
        "Pod 2 must read back the exact same SQLite ledgerRevision persisted by Pod 1",
      );
      const readBack = await pod2Host.run(
        "center-sqlite",
        { kind: "fact-show", factId: recordedFactId },
        localOwnerAuth,
      );
      assert.equal(readBack.outcome, "applied", `Pod 2 must read back persisted fact: ${JSON.stringify(readBack)}`);
      assert.match(String(readBack.evidence ?? ""), /StatefulSet PVC authority-repo subPath persists SQLite ledger/u);
    } finally {
      await pod2Host.close();
    }

    // F-G7-40: Pre-release PVC (populated at PVC root with registry.json, rbac/config.json, fleet/state.json)
    // upgraded in-place with fullnameOverride keeps the EXACT same userRoot mount at PVC root without re-bootstrapping or losing state!
    const legacyPvcRoot = path.join(sandbox, "legacy-pvc-root");
    const legacyRepoRoot = path.join(sandbox, "legacy-extra-repo");
    const upgradedAuthorityRoot = path.join(sandbox, "upgraded-authority-repo");
    const oidcDir = path.join(sandbox, "upgrade-oidc");
    const tlsDir = path.join(sandbox, "upgrade-tls");
    mkdirSync(path.join(legacyPvcRoot, "rbac"), { recursive: true });
    mkdirSync(path.join(legacyPvcRoot, "fleet"), { recursive: true });
    mkdirSync(legacyRepoRoot, { recursive: true });
    mkdirSync(oidcDir, { recursive: true });
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(
      path.join(legacyPvcRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "Local daemon", state: "enabled" }],
        repos: [
          {
            repoId: "legacy-nondefault",
            canonicalRoot: legacyRepoRoot,
            displayName: "Legacy Repo",
            authoredBranch: null,
            mode: "local",
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      path.join(legacyPvcRoot, "rbac", "config.json"),
      JSON.stringify({
        schema: "harness-managed-rbac/v1",
        mode: "external",
        url: "https://idp.example.org",
        realm: "fleet",
        clientId: "harness-center",
      }),
    );
    writeFileSync(path.join(legacyPvcRoot, "rbac", "center-client-secret"), "legacy-secret-77", { mode: 0o600 });
    writeFileSync(
      path.join(legacyPvcRoot, "fleet", "state.json"),
      JSON.stringify({
        uploads: {
          "upload-legacy-1": {
            nodeId: "edge-1",
            repoId: "org-center",
            content: { sha256: "0".repeat(64), size: 12, mediaType: "text/plain" },
            descriptor: null,
          },
        },
      }),
    );
    writeFileSync(
      path.join(legacyPvcRoot, "daemon-storage.json"),
      JSON.stringify({
        "legacy-nondefault": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
        "org-center": {
          backend: "postgres",
          connectionString: "postgresql://runtime@db.internal/harness",
          authorityConnectionString: "postgresql://authority@db.internal/harness",
          materialize: false,
        },
      }),
    );
    writeFileSync(path.join(oidcDir, "client-secret"), "legacy-secret-77\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.crt"), "DUMMY-CERT\n", { mode: 0o600 });
    writeFileSync(path.join(tlsDir, "tls.key"), "DUMMY-KEY\n", { mode: 0o600 });
    const upgradeScript = path.join(sandbox, "upgrade-start-center.sh");
    writeFileSync(upgradeScript, extractEntrypointScript(), { mode: 0o755 });
    const upgradeDaemon = path.join(sandbox, "upgrade-stub-daemon.cjs");
    writeFileSync(upgradeDaemon, "process.exit(0);\n");
    const upgradeCli = path.join(sandbox, "upgrade-stub-cli.cjs");
    writeFileSync(
      upgradeCli,
      'console.error("CLI bootstrap must NOT run on an already-initialized pre-release PVC!"); process.exit(99);\n',
    );
    const upgradeRes = spawnSync("/bin/sh", [upgradeScript], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: upgradeDaemon,
        HARNESS_CLI_ENTRY: upgradeCli,
        HARNESS_DAEMON_ID: "center",
        HARNESS_DAEMON_USER_ROOT: legacyPvcRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "true",
        HARNESS_FLEET_BIND: "0.0.0.0",
        HARNESS_FLEET_PORT: "7545",
        HARNESS_FLEET_AUTHORITY_REPO_ID: "org-center",
        HARNESS_FLEET_AUTHORITY_REPO_ROOT: upgradedAuthorityRoot,
        HARNESS_FLEET_QUOTA_BYTES: "1073741824",
        HARNESS_FLEET_TLS_CERT_FILE: path.join(tlsDir, "tls.crt"),
        HARNESS_FLEET_TLS_KEY_FILE: path.join(tlsDir, "tls.key"),
        HARNESS_OIDC_ISSUER_URL: "https://idp.example.org",
        HARNESS_OIDC_REALM: "fleet",
        HARNESS_OIDC_CLIENT_ID: "harness-center",
        HARNESS_OIDC_CLIENT_SECRET_FILE: path.join(oidcDir, "client-secret"),
      },
      encoding: "utf8",
    });
    assert.equal(
      upgradeRes.status,
      0,
      `in-place PVC upgrade must preserve existing state without re-bootstrap: ${upgradeRes.stderr}`,
    );
    const upgradedRegistry = readDaemonRegistry({ userRoot: legacyPvcRoot });
    assert.ok(
      upgradedRegistry.repos.some((r) => r.repoId === "legacy-nondefault" && r.canonicalRoot === legacyRepoRoot),
      "pre-release non-default registered repository must survive in-place upgrade",
    );
    assert.ok(
      upgradedRegistry.repos.some((r) => r.repoId === "org-center"),
      "Fleet authority repo must be reconciled alongside legacy registered repositories",
    );
    const persistedFleetState = JSON.parse(readFileSync(path.join(legacyPvcRoot, "fleet", "state.json"), "utf8"));
    assert.equal(
      persistedFleetState.uploads["upload-legacy-1"]?.nodeId,
      "edge-1",
      "persisted fleet/state.json upload state at PVC root must survive in-place upgrade",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("start-center.sh reconciles declared PostgreSQL repos into registry.json for stateless Deployment while preserving disabled rows and rejecting traversal IDs (F-G7-43)", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ha-helm-pg-reconcile-"));
  const freshUserRoot = path.join(sandbox, "fresh-user");
  const pvcUserRoot = path.join(sandbox, "pvc-user");
  const badUserRoot = path.join(sandbox, "bad-user");
  const scriptPath = path.join(sandbox, "start-center.sh");
  const stubDaemon = path.join(sandbox, "stub-daemon.cjs");
  mkdirSync(freshUserRoot, { recursive: true });
  mkdirSync(pvcUserRoot, { recursive: true });
  mkdirSync(badUserRoot, { recursive: true });
  writeFileSync(scriptPath, extractEntrypointScript(), { mode: 0o755 });
  writeFileSync(stubDaemon, "process.exit(0);\n");

  try {
    const validPg = {
      backend: "postgres",
      connectionString: "postgresql://runtime@db.internal/harness",
      authorityConnectionString: "postgresql://authority@db.internal/harness",
      materialize: false,
    };

    // 1. Fresh emptyDir userRoot (fleet.enabled=false): reconciles declared PG repos into registry.json
    writeFileSync(
      path.join(freshUserRoot, "daemon-storage.json"),
      JSON.stringify({ "repo-alpha": validPg, "repo-beta": { ...validPg, gitFollower: { branch: "main" } } }),
    );
    const freshRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: stubDaemon,
        HARNESS_DAEMON_USER_ROOT: freshUserRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.equal(freshRes.status, 0, `fresh stateless PG reconciliation failed: ${freshRes.stderr}`);
    const freshRegistry = readDaemonRegistry({ userRoot: freshUserRoot });
    assert.deepEqual(
      freshRegistry.repos.map((r) => ({ repoId: r.repoId, state: r.state, authoredBranch: r.authoredBranch })),
      [
        { repoId: "repo-alpha", state: "enabled", authoredBranch: null },
        { repoId: "repo-beta", state: "enabled", authoredBranch: "main" },
      ],
    );

    // 2. Existing PVC userRoot with an intentionally disabled repo row: preserves disabled state without re-enabling
    writeFileSync(
      path.join(pvcUserRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "Local daemon", state: "enabled" }],
        repos: [
          {
            repoId: "repo-disabled",
            canonicalRoot: path.join(sandbox, "disabled-root"),
            displayName: "repo-disabled",
            authoredBranch: null,
            mode: "local",
            connectionId: "local",
            state: "disabled",
            registeredAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      path.join(pvcUserRoot, "daemon-storage.json"),
      JSON.stringify({ "repo-disabled": validPg, "repo-active": validPg }),
    );
    const pvcRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: stubDaemon,
        HARNESS_DAEMON_USER_ROOT: pvcUserRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.equal(pvcRes.status, 0, `PVC PG reconciliation failed: ${pvcRes.stderr}`);
    const pvcRegistry = readDaemonRegistry({ userRoot: pvcUserRoot });
    assert.equal(pvcRegistry.repos.find((r) => r.repoId === "repo-disabled")?.state, "disabled");
    assert.equal(pvcRegistry.repos.find((r) => r.repoId === "repo-active")?.state, "enabled");

    // 3. Unsafe traversal repoId in daemon-storage.json fails closed
    writeFileSync(path.join(badUserRoot, "daemon-storage.json"), JSON.stringify({ "../escape": validPg }));
    const badRes = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: stubDaemon,
        HARNESS_DAEMON_USER_ROOT: badUserRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.notEqual(badRes.status, 0);
    assert.match(badRes.stderr, /refusing unsafe repository ID/u);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
