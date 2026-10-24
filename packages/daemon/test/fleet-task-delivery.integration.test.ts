// harness-test-tier: integration
import assert from "node:assert/strict";
import { sha256Text } from "@harness-anything/kernel";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonTaskRuntimeContextResult } from "../src/protocol/daemon-protocol-runtime-context.ts";
import { readEdgeRuntimeRepository } from "../src/fleet-edge-runtime-read.ts";
import { runFleetTaskCommandClient } from "../src/fleet/peer.ts";
import { dualSyncFixture, ledgerRevision } from "./fleet-dual-sync.fixture.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { renderCliReceipt } from "@harness-anything/cli/internal/cli/receipt-render-registry";

test("edge Fleet document rejection is normalized for CLI rendering", { timeout: 60_000 }, async (t) => {
  const fixture = await dualSyncFixture();
  t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task-edge-doc-rejection", "Edge document rejection");
  fixture.writeWorktree("node-one", `${created.packagePath}/closeout.md`, "# Edge change\n");
  const rejected = await fixture.edgeTask("node-one", { kind: "doc-submit", taskId: created.taskId });
  assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
  assert.equal(rejected.taskId, created.taskId, JSON.stringify(rejected));
  assert.equal(typeof rejected.rejectionExplanation, "string", JSON.stringify(rejected));
  const detail = rejected.detail as { readonly unresolvedTouches?: readonly { readonly path?: string }[] };
  assert.ok(
    detail.unresolvedTouches?.some((touch) => touch.path?.endsWith("/closeout.md")),
    JSON.stringify(rejected),
  );
  const rendered = renderCliReceipt(rejected);
  assert.equal(rendered.stream, "stderr");
  assert.match(rendered.text, /canonical lease-checked task command/u);
  assert.match(rendered.text, /closeout\.md/u);
  assert.match(rendered.text, /ha task start task-edge-doc-rejection/u);
  assert.doesNotMatch(rendered.text, /No remediation was recorded/u);
});

for (const explicit of [false, true])
  test(
    `separate clones: real CLI ${explicit ? "explicit" : "default"} task submit publishes its exact cut`,
    { timeout: 90_000 },
    async (t) => {
      const fixture = await dualSyncFixture();
      t.after(() => fixture.close());
      const config = fixture.channel("node-one"),
        edgeRoot = config.workspaceRoot,
        remote = path.join(fixture.root, "origin.git"),
        edgeUser = path.join(fixture.root, "edge-user");
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
      for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
        delete gitEnv[name];
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe", env: gitEnv }).trim();
      git(fixture.root, "clone", "--bare", "--no-local", fixture.repo, remote);
      fixture.git("remote", "add", "origin", remote);
      fixture.git("fetch", "origin");
      // The clone exists independently of the center's object store and shares only origin.
      git(fixture.root, "clone", "--no-local", remote, edgeRoot);
      git(edgeRoot, "config", "user.name", "person-node-one");
      git(edgeRoot, "config", "user.email", "person-node-one@users.noreply.github.com");
      const created = await fixture.createTask("node-one", "task-seeded", "CLI repository delivery");
      const started = await fixture.edgeTask("node-one", {
        kind: "task-start",
        taskId: created.taskId,
        executionId: "exe-seeded",
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      await fixture.waitPublished(String(started.opId));
      const snapshot = readEdgeRuntimeRepository(config, "repo.tasks.runtimeContext.read", { taskId: created.taskId })
        .snapshot as { workspace: { path: string } };
      const cwd = path.join(edgeRoot, snapshot.workspace.path);
      mkdirSync(path.dirname(cwd), { recursive: true });
      git(edgeRoot, "worktree", "add", "-b", created.taskId, cwd, "origin/main");
      // Create the edge delivery commit under the identity bound to this task dispatch.
      git(cwd, "config", "user.name", "person-node-one");
      git(cwd, "config", "user.email", "person-node-one@users.noreply.github.com");
      writeFileSync(path.join(cwd, "delivery.ts"), "export const delivered = true;\n");
      git(cwd, "add", "delivery.ts");
      git(cwd, "commit", "-qm", "feat: deliver repository change");
      const commitSha = git(cwd, "rev-parse", "HEAD");
      if (explicit) {
        const centerWorktree = path.join(fixture.repo, snapshot.workspace.path);
        mkdirSync(path.dirname(centerWorktree), { recursive: true });
        fixture.git("worktree", "add", "--detach", centerWorktree, "origin/main");
      }
      assert.throws(() => fixture.git("cat-file", "-e", commitSha));
      const closeout = `${created.packagePath}/closeout.md`,
        body =
          "## Summary\nRepository delivery.\n## Verification\nReal isolated CLI tested.\n## Residual Risk\nReal provider unverified.\n## Same Mechanism Elsewhere\nSubmission precedes runtime exit.\n";
      fixture.writeWorktree("node-one", closeout, body);
      const reportPath = `${created.packagePath}/artifacts/report.md`,
        reportBody = "# Edge report\n";
      fixture.writeWorktree("node-one", reportPath, reportBody);
      registerDaemonRepo({
        canonicalRoot: edgeRoot,
        repoId: "dual-repo",
        mode: "remote-edge",
        userRoot: edgeUser,
        createConvenienceLinks: false,
      });
      writeFileSync(
        path.join(edgeRoot, "fleet-edge.json"),
        JSON.stringify({ schema: "fleet-edge-config/v1", ...config }),
      );
      fixture.owners.signIn(edgeUser, "node-one");
      // The delivery daemon claims node-one's replication slot when it attaches; the fixture's own
      // resident stream must stop first, or the two keep fencing each other for the slot and every
      // replica-dependent wait below races a stream that is repeatedly reset mid-batch.
      await fixture.stopResidentSync("node-one");
      const oidc = new OidcSessionService(edgeUser, { fetch: fixture.owners.keycloak.fetch });
      const edge = await openDaemonHost({
        daemonId: "delivery-edge",
        userRoot: edgeUser,
        oidc,
      });
      t.after(() => edge.close());
      await edge.attachmentsSettled();
      const transport = createUnixSocketTransportServer({
        daemonId: "delivery-edge",
        socketPath: localUserDaemonEndpoint(edgeUser, "delivery-edge"),
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host: edge,
            build: { commit: null },
            authContext,
            emit,
            sessionPrincipal: async () => (await oidc.bind({ transportKind: "unix-socket" })).oidcPrincipal,
          }),
      });
      await transport.start();
      t.after(() => transport.stop());
      const invoke = async (args: string[]) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
        const child = spawn(
          process.execPath,
          [
            path.resolve("packages/cli/src/index.ts"),
            "--root",
            edgeRoot,
            "--json",
            "task",
            "submit",
            created.taskId,
            ...args,
          ],
          {
            env: { ...env, HARNESS_DAEMON_USER_ROOT: edgeUser, HARNESS_DAEMON_ID: "delivery-edge" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        return { code, stdout, stderr };
      };
      const before = ledgerRevision(fixture);
      const originalCloseout = readFileSync(path.join(fixture.repo, "harness", closeout), "utf8");
      const wrong = await invoke(["--commit", "f".repeat(40)]);
      assert.equal(wrong.code, 1, JSON.stringify(wrong));
      assert.equal(ledgerRevision(fixture), before);
      if (explicit) {
        // dec_E369B8616F50A6208B293997E7 CH2: a Summary-only body with prose is a valid closeout,
        // so the rejected fixture carries headings without any prose — it derives no claim.
        fixture.writeWorktree("node-one", closeout, "# Closeout\n\n## Summary\n\n## Verification\n");
        const incomplete = await invoke(["--commit", commitSha]);
        assert.equal(incomplete.code, 1, JSON.stringify(incomplete));
        assert.equal(
          git(remote, "rev-parse", `refs/heads/${created.taskId}`),
          commitSha,
          "failed submission leaves diagnostic code published",
        );
        assert.equal(ledgerRevision(fixture), before, "documents and submission reject atomically");
        assert.equal(readFileSync(path.join(fixture.repo, "harness", closeout), "utf8"), originalCloseout);
        fixture.writeWorktree("node-one", closeout, body);
        for (const action of [
          { kind: "task-submit", taskId: created.taskId, commitSha: fixture.git("rev-parse", "HEAD") },
          { kind: "task-submit", taskId: created.taskId, executionId: "exe-other", commitSha },
          { kind: "task-submit", taskId: "task-other", commitSha },
        ]) {
          const denied = await runFleetTaskCommandClient({
            readAccessToken: async () => `device-token-${config.nodeId}`,
            hostname: config.host,
            port: config.port,
            ca: readFileSync(config.caPath),
            servername: config.servername,
            nodeId: config.nodeId,
            credential: config.credential,
            repoId: config.repoId,
            taskId: action.taskId,
            action,
            opId: `negative-${action.taskId}-${action.executionId ?? "sha"}`,
            waitMs: 1000,
            timeoutMs: 5000,
          }).catch((error: unknown) => {
            assert.ok(error instanceof Error && "code" in error, String(error));
            return { outcome: "op_rejected", code: error.code };
          });
          assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
          assert.ok(
            ["delivery_fetch_failed", "lease_holder_mismatch", "entity_not_found", "task_read_failed"].includes(
              String(denied.code),
            ),
            JSON.stringify(denied),
          );
          assert.equal(ledgerRevision(fixture), before);
        }
      }
      const submitted = await invoke(explicit ? ["--commit", commitSha] : []);
      assert.equal(submitted.code, 0, JSON.stringify(submitted));
      await catchUpReplica({
        host: config.host,
        port: config.port,
        ca: readFileSync(config.caPath),
        servername: config.servername,
        nodeId: config.nodeId,
        credential: config.credential,
        repoId: config.repoId,
        viewRoot: config.viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
        readAccessToken: fixture.owners.readAccessToken(config.nodeId),
      });
      const accepted = readEdgeRuntimeRepository(config, "repo.tasks.runtimeContext.read", { taskId: created.taskId })
        .snapshot as unknown as DaemonTaskRuntimeContextResult["snapshot"];
      assert.equal(accepted.executions[0].submission.commitSha, commitSha);
      assert.deepEqual(accepted.executions[0].submission.deliverables, ["delivery.ts"]);
      assert.equal(
        accepted.executions[0].submission.artifacts?.find((artifact) => artifact.path === reportPath)?.blobSha256,
        sha256Text(reportBody),
      );
      assert.equal(accepted.lease, null, "submission atomically releases the lease");
      assert.equal(git(remote, "rev-parse", `refs/heads/${created.taskId}`), commitSha);
      assert.equal(readFileSync(fixture.worktree("node-one", closeout), "utf8"), body);
      const duplicate = await invoke(explicit ? ["--commit", commitSha] : []);
      assert.equal(duplicate.code, 0, JSON.stringify(duplicate));
      fixture.owners.keycloak.revoke("person-node-one", "dual-repo", ["task-submit"]);
      const stale = await invoke([]);
      assert.equal(stale.code, 1, JSON.stringify(stale));
      assert.match(stale.stdout, /authorization_denied|access_denied/u);
      assert.equal(git(remote, "rev-parse", `refs/heads/${created.taskId}`), commitSha);
    },
  );
