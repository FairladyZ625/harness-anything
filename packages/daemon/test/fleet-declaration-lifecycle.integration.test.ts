// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { fleetFixture, git, initRepo, rawPeer } from "./fleet-tls-session.fixture.ts";
import { fleetLedgerRevision } from "./fleet-store.fixture.ts";
import { runFleetUploadClient } from "../src/fleet/edge.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { classifyTextualArtifactPath, openSqliteEventStore, isTaskEvent, sha256Text } from "@harness-anything/kernel";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { signInAt, signOutAt } from "./keycloak.fixtures.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";

test(
  "remote-edge CLI completes a baseline lifecycle with independent review and interactive consent",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetFixture(t, undefined, "strict", false),
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
    const openEdge = async (nodeId: string, edgeRoot: string, edgeUser: string) => {
      mkdirSync(path.join(edgeUser, "rbac"), { recursive: true });
      writeFileSync(
        path.join(edgeUser, "rbac/config.json"),
        readFileSync(path.join(fixture.userRoot, "rbac/config.json")),
      );
      const oidc = new OidcSessionService(edgeUser);
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
          viewRoot: path.join(edgeUser, "view"),
          quotaBytes: 64 * 1024 * 1024,
        }),
      );
      registerDaemonRepo({
        canonicalRoot: edgeRoot,
        repoId,
        mode: "remote-edge",
        userRoot: edgeUser,
        createConvenienceLinks: false,
      });
      const edge = await openDaemonHost({ daemonId, userRoot: edgeUser, oidc });
      t.after(() => edge.close());
      await edge.attachmentsSettled();
      const transport = createUnixSocketTransportServer({
        daemonId,
        socketPath: localUserDaemonEndpoint(edgeUser, daemonId),
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host: edge,
            build: { commit: null },
            authContext,
            emit,
            sessionPrincipal: async () => (await oidc.bind({ transportKind: authContext.transportKind })).oidcPrincipal,
          }),
      });
      await transport.start();
      t.after(() => transport.stop());
    };
    await openEdge("node-one", edgeRoot, edgeUser);
    let activeRoot = edgeRoot,
      activeUser = edgeUser;
    const invoke = async (args: string[], expectedCode = 0) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", activeRoot, "--json", ...args],
        {
          env: { ...env, HARNESS_DAEMON_USER_ROOT: activeUser, HARNESS_DAEMON_ID: daemonId },
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
    // A local edge read needs the node owner's identity (dec_8DC9 CH2); edge writes stay on the machine path.
    const readAsOwner = async (userRoot: string, personId: string, args: string[]) => {
      signInAt(userRoot, personId);
      try {
        return await invoke(args);
      } finally {
        signOutAt(userRoot);
      }
    };
    await invoke(["doc", "sync", "--dry-run"]);
    const started = await invoke(["task", "start", taskId, "--execution-id", executionId]);
    assert.notEqual(started.code, "no_changes", "the edge must acquire the initial execution itself");
    const shown = await readAsOwner(edgeUser, "person-owner", ["task", "show", taskId]);
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
    const beforeSubmit = locateFleetMirrorView(path.join(edgeUser, "view"), repoId)!;
    await invoke(["task", "submit", taskId, "--commit", delivery]);
    await invoke(["task", "code-doc", "reconcile", taskId, "--path", "delivery.ts"]);
    await invoke(["task", "adjudicate", taskId, "--forward", "--note", "Owner forwards the submitted cut."]);
    const reviewerRoot = path.join(fixture.root, "reviewer-edge"),
      reviewerUser = path.join(fixture.root, "reviewer-user");
    mkdirSync(reviewerRoot);
    initRepo(reviewerRoot);
    mkdirSync(path.join(reviewerRoot, "harness"));
    writeFileSync(
      path.join(reviewerRoot, "harness/harness.yaml"),
      readFileSync(path.join(edgeRoot, "harness/harness.yaml")),
    );
    await openEdge("node-two", reviewerRoot, reviewerUser);
    activeRoot = reviewerRoot;
    activeUser = reviewerUser;
    await invoke(["doc", "sync", "--dry-run"]);
    await readAsOwner(reviewerUser, "person-reviewer", ["task", "show", taskId]);
    const reviewerView = locateFleetMirrorView(path.join(reviewerUser, "view"), repoId)!;
    fixture.owners.keycloak.account("person-denied");
    fixture.owners.keycloak.node("node-slow", "person-denied");
    for (const [negative, code] of [
      ["wrong-path", "review_report_invalid"],
      ["wrong-digest", "claim_not_owned"],
      ["stale-base", "base_blob_changed"],
      ["stale-submission", "invalid_proof"],
      ["empty-report", "review_report_invalid"],
      ["self-review", "actor_unauthorized"],
      ["unauthorized", "authorization_denied"],
    ] as const) {
      const reviewId = `review-${negative}`,
        reportPath = `${fixture.packagePath}/artifacts/reports/${negative}.md`,
        carriedPath = negative === "wrong-path" ? `${fixture.packagePath}/closeout.md` : reportPath,
        nodeId = negative === "self-review" ? "node-one" : negative === "unauthorized" ? "node-slow" : "node-two",
        descriptors = await runFleetUploadClient({
          port: center.port,
          ca: fixture.cert,
          nodeId,
          credential: "machine-secret",
          repoId,
          changes: [
            {
              path: carriedPath,
              body: Buffer.from(negative === "empty-report" ? "placeholder" : "# Review\n\nChecked this cut.\n"),
              mediaType: "text/markdown",
            },
          ],
        }),
        peer = await rawPeer(fixture.track, center.port, fixture.cert, nodeId, "machine-secret"),
        metadata = await peer.request({
          schema: "fleet.repo.metadata.get/v1",
          messageId: `metadata-${negative}`,
          repoId,
        });
      assert.equal(metadata.schema, "fleet.repo.metadata.result/v1");
      if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error("metadata missing");
      const priorRevision = fleetLedgerRevision(fixture.repo, repoId),
        cut = negative === "stale-submission" ? beforeSubmit : reviewerView,
        result = await peer.request({
          schema: "fleet.task.command/v1",
          messageId: negative,
          writerEpoch: metadata.writerEpoch,
          opId: negative,
          repoId,
          taskId,
          action: {
            kind: "task-review-execution",
            taskId,
            executionId,
            reviewId,
            verdict: "approved",
            reason: "Checked.",
            evidenceChecked: ["tests"],
          },
          docChanges: [
            {
              path: carriedPath,
              baseBlobSha256: negative === "stale-base" ? "a".repeat(64) : null,
              policyId: classifyTextualArtifactPath(reportPath)!.policyId,
              candidate: { ...descriptors[0]!, ...(negative === "wrong-digest" ? { sha256: "b".repeat(64) } : {}) },
            },
          ],
          mirrorBaseCut: { revision: cut.revision, headDigest: cut.headDigest },
        });
      assert.ok(
        result.schema === "fleet.error/v1" ||
          (result.schema === "fleet.task.result/v1" && result.outcome === "op_rejected"),
        JSON.stringify(result),
      );
      assert.equal(result.code, code, negative);
      assert.equal(fleetLedgerRevision(fixture.repo, repoId), priorRevision, negative);
      assert.equal(existsSync(path.join(fixture.repo, "harness", reportPath)), false, negative);
      assert.equal(
        existsSync(path.join(fixture.repo, "harness", fixture.packagePath, "reviews", `${reviewId}.md`)),
        false,
        negative,
      );
      t.diagnostic(`${negative}: ${code}; no canonical event or report`);
      peer.close();
    }
    const reviewerPackage = path.join(reviewerRoot, "harness", fixture.packagePath);
    mkdirSync(path.join(reviewerPackage, "artifacts", "reports"), { recursive: true });
    writeFileSync(
      path.join(reviewerPackage, "artifacts", "reports", "edge-cli.md"),
      "# Independent Review\n\nThe real CLI flow and its negative controls were checked.\n",
    );
    writeFileSync(
      path.join(reviewerRoot, "review.json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Independent CLI verification passed.",
        evidenceChecked: ["test:remote-edge-lifecycle"],
      }),
    );
    const review = ["task", "review-execution", taskId, "--review-id", "review-edge-cli", "--from-file", "review.json"];
    const acceptedReview = await invoke(review);
    const ledger = openSqliteEventStore({ rootInput: fixture.repo, repoId, readOnly: true });
    try {
      const event = ledger.event(String(acceptedReview.opId));
      assert.ok(event && isTaskEvent(event) && event.type === "review_recorded");
      assert.equal(event.actor.principal.personId, "person-reviewer");
      const report = event.payload.carriedDocumentClaims?.[0];
      assert.equal(report?.path, `${fixture.packagePath}/artifacts/reports/edge-cli.md`);
      assert.equal(
        report?.candidate?.sha256,
        sha256Text(readFileSync(path.join(reviewerPackage, "artifacts/reports/edge-cli.md"), "utf8")),
      );
      assert.ok(ledger.readContentObject(report!.candidate!.sha256));
    } finally {
      ledger.close();
    }
    activeRoot = edgeRoot;
    activeUser = edgeUser;
    writeFileSync(path.join(edgeRoot, "review.json"), readFileSync(path.join(reviewerRoot, "review.json")));
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
