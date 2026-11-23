// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const entrypointTemplatePath = path.join(repoRoot, "deploy/helm/harness-center/templates/entrypoint-configmap.yaml");

function extractEntrypointScript(): string {
  const template = readFileSync(entrypointTemplatePath, "utf8");
  const marker = "  start-center.sh: |\n";
  const index = template.indexOf(marker);
  assert.ok(index >= 0, "entrypoint-configmap.yaml must define data.start-center.sh");
  const scriptLines = template
    .slice(index + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("    ") ? line.slice(4) : line));
  return `${scriptLines.join("\n").trimEnd()}\n`;
}

test(
  "Stateless PostgreSQL Deployment (emptyDir userRoot, fleet.enabled=false) reconciles declared repos on Pod replacement before /readyz returns Ready and reads back facts (F-G7-43)",
  { timeout: 180_000 },
  async (t) => {
    const pg = await pgRuntimeFixture();
    const sandbox = mkdtempSync(path.join(tmpdir(), "ha-stateless-pg-pod-replace-"));
    const pod1UserRoot = path.join(sandbox, "pod-1-empty-dir");
    const pod2UserRoot = path.join(sandbox, "pod-2-empty-dir");
    const scriptPath = path.join(sandbox, "start-center.sh");
    const stubDaemonPath = path.join(sandbox, "stub-daemon.cjs");
    const repoId = "center-stateless-pg";

    t.after(async () => {
      await pg.pool.end();
      await pg.close();
      removeTempRepository(sandbox);
    });

    mkdirSync(pod1UserRoot, { recursive: true });
    mkdirSync(pod2UserRoot, { recursive: true });
    writeFileSync(scriptPath, extractEntrypointScript(), { mode: 0o755 });
    writeFileSync(stubDaemonPath, "process.exit(0);\n");

    const storageEntry = {
      backend: "postgres" as const,
      connectionString: pg.connectionString,
      authorityConnectionString: pg.managementConnectionString,
      materialize: false,
      scope: {
        tenantId: "tenant-stateless",
        projectId: "project-stateless",
        readers: ["writer"],
        policyEpoch: 1,
      },
    };
    const storageConfig = { [repoId]: storageEntry };
    const localOwnerAuth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
    };

    // Pod 1: fresh emptyDir userRoot with mounted daemon-storage.json Secret and fleet.enabled=false
    writeFileSync(path.join(pod1UserRoot, "daemon-storage.json"), JSON.stringify(storageConfig, null, 2));
    const pod1Entrypoint = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: stubDaemonPath,
        HARNESS_DAEMON_ID: "center",
        HARNESS_DAEMON_USER_ROOT: pod1UserRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.equal(pod1Entrypoint.status, 0, `Pod 1 start-center.sh failed:\n${pod1Entrypoint.stderr}`);

    const pod1Registry = readDaemonRegistry({ userRoot: pod1UserRoot });
    const pod1Registered = pod1Registry.repos.find((entry) => entry.repoId === repoId);
    assert.ok(pod1Registered && pod1Registered.canonicalRoot, "Pod 1 start-center.sh must register declared PG repo");
    assert.equal(pod1Registered.state, "enabled");
    assert.equal(existsSync(pod1Registered.canonicalRoot), true);

    signInPolicyTestUser(pod1UserRoot, "writer", [repoId], "admin");
    const pod1Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pod1UserRoot,
      storage: storageConfig,
      requiredStorageBackend: "postgres",
    });
    let revisionAfterPod1: number;
    let recordedFactId: string;
    try {
      const bootstrapped = await pod1Host.bootstrap(
        {
          rootDir: pod1Registered.canonicalRoot,
          repoId,
          personId: "writer",
          displayName: "Writer",
        },
        localOwnerAuth,
      );
      assert.equal(bootstrapped.outcome, "applied", `Pod 1 PG bootstrap failed: ${JSON.stringify(bootstrapped)}`);

      const createdTask = await pod1Host.run(
        repoId,
        {
          kind: "task-create",
          taskId: "task_stateless_pg_pod",
          title: "Verify stateless PostgreSQL Pod replacement recovery",
        },
        localOwnerAuth,
      );
      assert.equal(createdTask.outcome, "applied", `Pod 1 task-create failed: ${JSON.stringify(createdTask)}`);

      const recorded = await pod1Host.run(
        repoId,
        {
          kind: "fact-record",
          taskId: "task_stateless_pg_pod",
          statement: "Stateless PG Deployment reconciles repository registration before Ready on replacement Pod.",
          evidenceSource: "test:helm-stateless-pg-recovery",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
        },
        localOwnerAuth,
      );
      assert.equal(recorded.outcome, "applied", `Pod 1 fact-record failed: ${JSON.stringify(recorded)}`);
      recordedFactId = String(recorded.factId ?? "");
      assert.ok(recordedFactId.startsWith("F-"), `expected canonical factId, got ${JSON.stringify(recorded)}`);

      const pod1Status = pod1Host.observabilitySnapshot().repos.find((entry) => entry.repoId === repoId);
      assert.ok(pod1Status && typeof pod1Status.ledgerRevision === "number" && pod1Status.ledgerRevision > 0);
      revisionAfterPod1 = pod1Status.ledgerRevision;
    } finally {
      await pod1Host.close();
    }

    // Simulate Kubernetes Pod replacement: completely destroy Pod 1's emptyDir userRoot.
    removeTempRepository(pod1UserRoot);

    // Pod 2: completely separate fresh emptyDir userRoot, mounting ONLY the same daemon-storage.json Secret.
    writeFileSync(path.join(pod2UserRoot, "daemon-storage.json"), JSON.stringify(storageConfig, null, 2));
    const pod2Entrypoint = spawnSync("/bin/sh", [scriptPath], {
      env: {
        ...process.env,
        HARNESS_DAEMON_ENTRY: stubDaemonPath,
        HARNESS_DAEMON_ID: "center",
        HARNESS_DAEMON_USER_ROOT: pod2UserRoot,
        HARNESS_STORAGE_BACKEND: "postgres",
        HARNESS_FLEET_ENABLED: "false",
      },
      encoding: "utf8",
    });
    assert.equal(pod2Entrypoint.status, 0, `Pod 2 start-center.sh failed:\n${pod2Entrypoint.stderr}`);

    const pod2Registry = readDaemonRegistry({ userRoot: pod2UserRoot });
    const pod2Registered = pod2Registry.repos.find((entry) => entry.repoId === repoId);
    assert.ok(pod2Registered && pod2Registered.canonicalRoot, "Pod 2 start-center.sh must restore declared PG repo");
    assert.notEqual(pod2Registered.canonicalRoot, pod1Registered.canonicalRoot);

    signInPolicyTestUser(pod2UserRoot, "writer", [repoId], "admin");
    const pod2Host = await openDaemonHost({
      daemonId: "center",
      userRoot: pod2UserRoot,
      storage: storageConfig,
      requiredStorageBackend: "postgres",
    });
    try {
      // Before initial attachment completes, /readyz MUST NOT report Ready!
      const preAttachProbe = pod2Host.probeSnapshot();
      assert.equal(
        preAttachProbe.ready,
        false,
        `Pod 2 must stay NotReady while re-attaching declared PG repo, got ${JSON.stringify(preAttachProbe)}`,
      );
      assert.ok(
        preAttachProbe.reasons.includes("initial_attachments_pending") ||
          preAttachProbe.reasons.includes("repos_warming"),
        `expected initial attachment/warming readiness gate, got ${JSON.stringify(preAttachProbe)}`,
      );

      await pod2Host.attachmentsSettled();
      const postAttachProbe = pod2Host.probeSnapshot();
      assert.equal(
        postAttachProbe.ready,
        true,
        `Pod 2 must report Ready once declared PG repo attached: ${JSON.stringify(postAttachProbe)}`,
      );

      const pod2Status = pod2Host.observabilitySnapshot().repos.find((entry) => entry.repoId === repoId);
      assert.ok(pod2Status, "Pod 2 observabilitySnapshot must expose re-attached PG repo");
      assert.equal(pod2Status.state, "attached");
      assert.equal(
        pod2Status.ledgerRevision,
        revisionAfterPod1,
        "Pod 2 must observe the exact PostgreSQL ledgerRevision written by Pod 1",
      );

      const readBack = await pod2Host.run(repoId, { kind: "fact-show", factId: recordedFactId }, localOwnerAuth);
      assert.equal(
        readBack.outcome,
        "applied",
        `Pod 2 must read back fact written by Pod 1: ${JSON.stringify(readBack)}`,
      );
      assert.match(
        String(readBack.evidence ?? ""),
        /Stateless PG Deployment reconciles repository registration before Ready/u,
      );
    } finally {
      await pod2Host.close();
    }
  },
);
