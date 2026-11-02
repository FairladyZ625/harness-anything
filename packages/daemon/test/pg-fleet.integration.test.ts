// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { makeTaskEventReader, openFleetStorage } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { fleetReplicationFixture, replicationRepoId, waitForState } from "./fleet-replication.fixture.ts";
import { runFleetReplicaSync } from "../src/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { applyFleetMirrorCut, locateFleetMirrorView, revokeFleetMirrorTree } from "../src/fleet-edge-mirror.ts";

for (const gitFollower of [undefined, { branch: "main" }])
  test(
    `PG daemon replicates, fences two nodes, submits, and withdraws revoked files (Git ${gitFollower ? "configured" : "unconfigured"})`,
    { timeout: 240_000 },
    async (t) => {
      const pg = await pgRuntimeFixture();
      const storage = {
        backend: "postgres" as const,
        connectionString: pg.connectionString,
        authorityConnectionString: pg.managementConnectionString,
        ...(gitFollower ? { gitFollower } : {}),
        scope: { tenantId: "tenant", projectId: "project", readers: ["person-owner", "person-local"], policyEpoch: 1 },
      };
      const fixture = await fleetReplicationFixture(t, { storage, replicationKeepaliveMs: 100 }),
        source = openFleetStorage({ rootDir: fixture.repo, repoId: replicationRepoId, storage }),
        failures: unknown[] = [],
        streams: { stop: () => Promise<void> }[] = [];
      t.after(async () => {
        await pg.pool.end();
        await pg.close();
      });
      const applied = async (action: Record<string, unknown>) => {
        const result = await fixture.centerRun(action);
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        await fixture.host.settleMaterialization(replicationRepoId, "PG fixture publication");
        return result;
      };
      const start = (nodeId: "edge-one" | "edge-two") => {
        const workspaceRoot = path.join(fixture.root, `${nodeId}-workspace`),
          viewRoot = path.join(fixture.root, `${nodeId}-views`),
          viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", nodeId),
          controller = new AbortController();
        if (!existsSync(path.join(viewDir, "current.json"))) {
          mkdirSync(viewDir, { recursive: true });
          writeFileSync(
            path.join(viewDir, "current.json"),
            JSON.stringify({
              id: "old-v2",
              metadata: {
                schema: "fleet-basebackup/v2",
                repoId: replicationRepoId,
                position: { history: "old-history", sequence: 1, revision: 1 },
                ledgerGeneration: 3,
                projectionSchema: 38,
                readerProfile: { personId: "person-owner", nodeId },
              },
            }),
          );
          assert.equal(readReplicaGeneration(viewDir), null, "a frozen v2 cache is refused before resnapshot");
        }
        const running = runFleetReplicaSync({
            hostname: "127.0.0.1",
            port: fixture.centerPort(),
            ca: fixture.cert,
            servername: "localhost",
            nodeId,
            credential: `secret-${nodeId}`,
            readAccessToken: async () => `device-token-${nodeId}`,
            repoId: replicationRepoId,
            viewRoot,
            diskQuotaBytes: 64 * 1024 * 1024,
            signal: controller.signal,
            onConfirmed: (changedPaths) => {
              applyFleetMirrorCut(viewRoot, replicationRepoId, workspaceRoot, "sync", { viewId: nodeId, changedPaths });
            },
            onRevoked: () => revokeFleetMirrorTree(workspaceRoot),
            onFailure: (error) => failures.push(error),
            onConfirmedFailure: (error) => failures.push(error),
          }),
          stop = async () => {
            controller.abort();
            await running;
          };
        streams.push({ stop });
        return { workspaceRoot, viewRoot, viewDir, stop };
      };
      const converge = async (edge: ReturnType<typeof start>) =>
        waitForState(
          () =>
            readReplicaGeneration(edge.viewDir)?.metadata.position.sequence === source.replicationPosition().sequence,
          () => `PG edge convergence; failures=${JSON.stringify(failures.map(String))}`,
          60_000,
        );
      try {
        const created = await applied({
            kind: "task-create",
            taskId: "task-pg-race",
            title: "PG two-node claim",
            presetId: "docs-task",
            riskTier: "low",
          }),
          packagePath = String(created.packagePath);
        await realizeTaskPlanFixture(
          fixture.repo,
          packagePath,
          (plan) => applied({ kind: "doc-submit", paths: [plan] }),
          "PG two-node claim",
        );
        await fixture.openCenter();
        const one = start("edge-one"),
          two = start("edge-two");
        await Promise.all([converge(one), converge(two)]);
        const authoritative = makeTaskEventReader({
          rootDir: fixture.repo,
          repoId: replicationRepoId,
          storage,
        });
        try {
          for (const edge of [one, two]) {
            const view = locateFleetMirrorView(edge.viewRoot, replicationRepoId)!;
            assert.equal(view.headDigest, authoritative.currentCut().headDigest);
            assert.equal(view.revision, authoritative.currentCut().revision);
          }
        } finally {
          await authoritative.drain();
        }
        await waitForState(
          () => existsSync(path.join(one.workspaceRoot, "harness", packagePath, "task_plan.md")),
          "complete agent harness tree",
        );
        const results = await Promise.all(
          ["edge-one", "edge-two"].map((nodeId) =>
            fixture.edgeTaskCommand(nodeId as "edge-one" | "edge-two", { kind: "task-start", taskId: "task-pg-race" }),
          ),
        );
        assert.equal(results.filter((result) => result.outcome === "applied").length, 1, JSON.stringify(results));
        assert.equal(results.filter((result) => result.code === "lease_conflict").length, 1, JSON.stringify(results));
        console.log("PG_FLEET_TWO_NODE_CLAIM accepted=1 rejected=1 code=lease_conflict");

        const generationBeforeDisconnect = readReplicaGeneration(one.viewDir)!.id;
        await one.stop();
        const note = Buffer.from("# PG outage catchup\n\nAn edge authored this while the other node was offline.\n"),
          submitted = await fixture.edgeDocSubmit("edge-two", "notes/pg.md", note);
        assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
        const documents = fixture.centerReader();
        try {
          assert.equal(
            documents.withSession((queries) => queries.readDocument("notes/pg.md")).document?.body,
            note.toString(),
          );
        } finally {
          documents.close();
        }
        const restarted = start("edge-one");
        await converge(restarted);
        assert.equal(
          readReplicaGeneration(restarted.viewDir)!.id,
          generationBeforeDisconnect,
          "an in-window restart resumes the existing generation",
        );
        await waitForState(
          () => existsSync(path.join(restarted.workspaceRoot, "harness/notes/pg.md")),
          "offline commit materialized after edge restart",
        );
        assert.equal(readFileSync(path.join(restarted.workspaceRoot, "harness/notes/pg.md"), "utf8"), note.toString());

        const docs = await applied({
            kind: "task-create",
            taskId: "task-pg-docs",
            title: "PG artifact delivery",
            presetId: "docs-task",
            riskTier: "low",
          }),
          docsPackage = String(docs.packagePath);
        await realizeTaskPlanFixture(
          fixture.repo,
          docsPackage,
          (plan) => applied({ kind: "doc-submit", paths: [plan] }),
          "PG artifact delivery",
        );
        await applied({ kind: "task-start", taskId: "task-pg-docs", executionId: "execution-pg-docs" });
        const artifact = `${docsPackage}/artifacts/report.md`;
        mkdirSync(path.dirname(path.join(fixture.repo, "harness", artifact)), { recursive: true });
        writeFileSync(path.join(fixture.repo, "harness", artifact), "PG artifact delivery evidence.\n");
        writeFileSync(
          path.join(fixture.repo, "harness", docsPackage, "closeout.md"),
          "## Summary\nDelivered an accepted report.\n## Verification\nTrue PG with two TLS nodes.\n## Residual Risk\nNone in the fixture.\n## Same Mechanism Elsewhere\nExisting artifact delivery.\n",
        );
        const cut = await applied({ kind: "task-submit", taskId: "task-pg-docs", executionId: "execution-pg-docs" });
        assert.equal(cut.commitSha, null);
        await applied({ kind: "task-complete", taskId: "task-pg-docs" });
        const reader = fixture.centerReader();
        try {
          assert.equal(reader.withSession((queries) => queries.read("task-pg-docs").snapshot).task?.status, "done");
        } finally {
          reader.close();
        }
        assert.equal(existsSync(path.join(fixture.repo, ".git")), gitFollower !== undefined);
        for (const root of [fixture.repo, fixture.userRoot, fixture.stateRoot])
          assert.deepEqual(
            existsSync(root)
              ? readdirSync(root, { recursive: true })
                  .map(String)
                  .filter((name) => /\.sqlite(?:$|-)/u.test(name))
              : [],
            [],
          );
        console.log(
          `PG_DAEMON_LIFECYCLE status=done Git=${gitFollower ? "configured" : "unconfigured"} centerSQLiteFiles=0`,
        );

        await converge(restarted);
        // Even a locally edited copy is withdrawn when repository-read is removed.
        const revokedFile = path.join(restarted.workspaceRoot, "harness/notes/pg.md");
        writeFileSync(revokedFile, "local edit of revoked content\n");
        fixture.owners.keycloak.revoke("person-owner", replicationRepoId, ["repository-read"]);
        await waitForState(
          () => readReplicaGeneration(restarted.viewDir) === null && !existsSync(revokedFile),
          "live permission narrowing removes generation and authored files",
          60_000,
        );
        assert.ok(failures.some((error) => (error as { code?: string }).code === "authorization_denied"));
        console.log("PG_EDGE restart=converged disconnect=chased permissionNarrowing=filesWithdrawn");
      } finally {
        await Promise.all(streams.map((stream) => stream.stop()));
        source.close();
      }
    },
  );
