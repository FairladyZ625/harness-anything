// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { fleetFixture, git } from "./fleet-tls-session.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { signInAt } from "./keycloak.fixtures.ts";

test(
  "remote-edge CLI completes a baseline lifecycle with independent review and interactive consent",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "strict"),
      center = await fixture.center();
    const { repoId, taskId, executionId } = fixture.subject;
    const edgeRoot = path.join(fixture.root, "cli-edge"),
      edgeUser = path.join(fixture.root, "cli-user"),
      remote = path.join(fixture.root, "origin.git"),
      daemonId = "s9-edge";
    git(fixture.root, "clone", "--bare", "--no-local", fixture.repo, remote);
    git(fixture.repo, "remote", "add", "origin", remote);
    git(fixture.repo, "fetch", "origin");
    git(fixture.root, "clone", "--no-local", remote, edgeRoot);
    git(edgeRoot, "config", "user.name", "Fleet lifecycle fixture");
    git(edgeRoot, "config", "user.email", "fleet@example.invalid");
    fixture.owners.reassign("node-two", "person-reviewer");
    const configureNode = (nodeId: string) =>
      writeFileSync(
        path.join(edgeRoot, "fleet-edge.json"),
        JSON.stringify({
          schema: "fleet-edge-config/v1",
          repoId,
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          servername: "localhost",
          nodeId,
          credential: "machine-secret",
          viewRoot: path.join(fixture.root, "cli-view"),
          quotaBytes: 64 * 1024 * 1024,
        }),
      );
    configureNode("node-one");
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId,
      mode: "remote-edge",
      userRoot: edgeUser,
      createConvenienceLinks: false,
    });
    const edge = await openDaemonHost({ daemonId, userRoot: edgeUser });
    t.after(() => edge.close());
    await edge.attachmentsSettled();
    const transport = createUnixSocketTransportServer({
      daemonId,
      socketPath: localUserDaemonEndpoint(edgeUser, daemonId),
      createProtocolServer: (authContext, emit) =>
        createJsonRpcProtocolServer({ host: edge, build: { commit: null }, authContext, emit }),
    });
    await transport.start();
    t.after(() => transport.stop());
    const invoke = async (args: string[], expectedCode = 0) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", edgeRoot, "--json", ...args],
        {
          env: { ...env, HARNESS_DAEMON_USER_ROOT: edgeUser, HARNESS_DAEMON_ID: daemonId },
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
      assert.equal(code, expectedCode, JSON.stringify({ args, stdout, stderr }));
      t.diagnostic(`${args.slice(0, 3).join(" ")}: exit=${code}`);
      return JSON.parse(stdout) as Record<string, unknown>;
    };
    await invoke(["task", "start", taskId, "--execution-id", executionId]);
    const shown = await invoke(["task", "show", taskId]);
    const snapshot = JSON.parse(String(shown.evidence)) as { workspace: { path: string } };
    const cwd = path.join(edgeRoot, snapshot.workspace.path);
    mkdirSync(path.dirname(cwd), { recursive: true });
    git(edgeRoot, "worktree", "add", "-b", taskId, cwd, "HEAD");
    writeFileSync(path.join(cwd, "delivery.ts"), "export const complete = true;\n");
    git(cwd, "add", "delivery.ts");
    git(cwd, "commit", "-qm", "feat: exercise fleet delivery");
    const delivery = git(cwd, "rev-parse", "HEAD");
    await invoke([
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "A real edge CLI reaches the center. ".repeat(30),
      "--source",
      "test:remote-edge-lifecycle",
      "--confidence",
      "high",
    ]);
    const packageDir = path.join(edgeRoot, "harness", fixture.packagePath);
    writeFileSync(
      path.join(packageDir, "closeout.md"),
      `# Closeout\n\n## Summary\n\nDelivery ${delivery}.\n\n## Verification\n\nThe isolated remote-edge CLI lifecycle reaches complete.\n\n## Residual Risk\n\nReal Keycloak deployment unverified.\n\n## Same Mechanism Elsewhere\n\nTransport consumes command declarations.\n`,
    );
    await invoke(["task", "submit", taskId, "--commit", delivery]);
    await invoke(["task", "code-doc", "reconcile", taskId, "--path", "delivery.ts"]);
    await invoke(["task", "adjudicate", taskId, "--forward", "--note", "Owner forwards the submitted cut."]);
    configureNode("node-two");
    await invoke(["task", "show", taskId]);
    mkdirSync(path.join(packageDir, "artifacts", "reports"), { recursive: true });
    writeFileSync(
      path.join(packageDir, "artifacts", "reports", "edge-cli.md"),
      "# Independent Review\n\nThe real CLI flow and its negative controls were checked.\n",
    );
    writeFileSync(
      path.join(edgeRoot, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent CLI verification passed.",
        evidenceChecked: ["test:remote-edge-lifecycle"],
      }),
    );
    const review = ["task", "review-execution", taskId, "--review-id", "review-edge-cli", "--from-file", "review.json"];
    await invoke(review);
    configureNode("node-one");
    const selfReview = await invoke(review, 1);
    assert.match(JSON.stringify(selfReview), /actor_unauthorized/u);
    const consent = ["task", "review-consent", taskId, "--review-id", "review-edge-cli"];
    const machineConsent = await invoke(consent, 1);
    assert.match(JSON.stringify(machineConsent), /human_confirmation_required/u);
    fixture.owners.keycloak.interactiveSession("person-owner", "node-one", fixture.owners.url);
    signInAt(edgeUser, "person-owner");
    await invoke(consent);
    await invoke(["task", "complete", taskId]);
    const completed = await fixture.host.run(repoId, { kind: "task-show", taskId }, fixture.auth);
    assert.equal(JSON.parse(String(completed.evidence)).task.status, "done");
  },
);
