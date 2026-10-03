// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runFleetTaskCommandClient } from "../src/fleet/edge.ts";
import { dualSyncFixture, ledgerRevision } from "./fleet-dual-sync.fixture.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";

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
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
      git(fixture.root, "clone", "--bare", "--no-local", fixture.repo, remote);
      fixture.git("remote", "add", "origin", remote);
      fixture.git("fetch", "origin");
      // The clone exists independently of the center's object store and shares only origin.
      git(fixture.root, "clone", "--no-local", remote, edgeRoot);
      git(edgeRoot, "config", "user.name", "Dual Sync Test");
      git(edgeRoot, "config", "user.email", "dual@example.invalid");
      const created = await fixture.createTask("node-one", "task-seeded", "CLI repository delivery");
      const started = await fixture.edgeTask("node-one", {
        kind: "task-start",
        taskId: created.taskId,
        executionId: "exe-seeded",
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      await fixture.waitPublished(String(started.opId));
      const shown = await fixture.edgeTask("node-one", { kind: "task-show", taskId: created.taskId });
      const snapshot = JSON.parse(String(shown.evidence));
      const cwd = path.join(edgeRoot, snapshot.workspace.path);
      mkdirSync(path.dirname(cwd), { recursive: true });
      git(edgeRoot, "worktree", "add", "-b", created.taskId, cwd, "origin/main");
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
      const edge = await openDaemonHost({ daemonId: "delivery-edge", userRoot: edgeUser });
      t.after(() => edge.close());
      await edge.attachmentsSettled();
      const transport = createUnixSocketTransportServer({
        daemonId: "delivery-edge",
        socketPath: localUserDaemonEndpoint(edgeUser, "delivery-edge"),
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({ host: edge, build: { commit: null }, authContext, emit }),
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
        fixture.writeWorktree("node-one", closeout, "## Summary\nTODO\n");
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
      const accepted = JSON.parse(
        String((await fixture.edgeTask("node-one", { kind: "task-show", taskId: created.taskId })).evidence),
      );
      assert.equal(accepted.executions[0].submission.commitSha, commitSha);
      assert.deepEqual(accepted.executions[0].submission.deliverables, ["delivery.ts"]);
      assert.deepEqual(accepted.executions[0].submission.outputs, []);
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
