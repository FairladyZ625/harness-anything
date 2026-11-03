// harness-test-tier: integration
import { daemonBuildStamp } from "../src/build-identity.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, isTaskEvent, writeRepositorySettingsFacet } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint, mkdirSecurely } from "../src/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, daemonProtocolMethods, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { serveJsonRpcStream } from "../src/transport/json-rpc-stream.ts";
import { researchPackage } from "./completion-command-source.fixture.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { signInPolicyTestUser, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import {
  openBootstrappedRepoCell,
  registerBootstrappedDaemonRepo,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";

const method = "repo.task.witness.run";
const script = `import {readFileSync} from 'node:fs';
const input = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT).witnessInput, 'utf8'));
const artifact = input.subjects.find(s => s.path.endsWith('/experiment.json'));
const metadata = JSON.parse(readFileSync(artifact.file, 'utf8'));
if (metadata.seed !== 42) throw new Error('Mutable workspace was read instead of submitted bytes');
console.log(JSON.stringify({schema:'preset-script-result/v1',produces:[{capabilityId:'completion-witness',payload:{
result:input.gateId === 'version-pinned' ? 'pass' : 'fail',subjects:input.subjects.map(({file,...s})=>s),
predicateType:'research/version-pinned/v1',predicate:metadata,diagnostic:'Frozen artifact seed checked by HA'}}]}));`;

test("real host RPC runs only the declared gate, rejects forged results and unauthorized requests, and fences concurrent claims", async () => {
  assert.ok(
    daemonProtocolMethods.some((entry) => entry.method === method),
    "completion source request must be advertised",
  );
  const root = mkdtempSync(path.join(tmpdir(), "ha-witness-rpc-")),
    ledger = path.join(root, "harness"),
    userRoot = path.join(root, "user"),
    repoId = workspaceId("witness-rpc"),
    taskId = "task-rpc-artifacts",
    executionId = "exe-rpc-artifacts",
    request = { taskId, executionId, gateId: "version-pinned" },
    worker = withPolicyGroup(
      { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const },
      "admin",
    );
  let crashOnSubmit = false;
  initRepo(root);
  git(root, "branch", "-M", "main");
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\nsource/\nuser/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture exclusions");
  mkdirSync(ledger);
  initRepo(ledger);
  const source = researchPackage(root, script),
    assets = path.join(root, "verticals/research");
  cpSync(new URL("../../preset/assets/software-coding", import.meta.url), assets, { recursive: true });
  const manifestPath = path.join(source, "preset.json"),
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")),
    verticalPath = path.join(assets, "vertical.json"),
    vertical = JSON.parse(readFileSync(verticalPath, "utf8"));
  manifest.completion.gates["second-check"] = { ...manifest.completion.gates["version-pinned"] };
  manifest.profiles[0].completionGates.push("second-check");
  vertical.id = "research/experiments";
  vertical.completion = manifest.completion;
  manifest.vertical = vertical.id;
  delete manifest.completion;
  writeFileSync(verticalPath, JSON.stringify(vertical));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  cpSync(source, path.join(assets, "presets/research-checks"), { recursive: true });
  writeFileSync(
    path.join(ledger, "harness.yaml"),
    writeRepositorySettingsFacet(
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
      {
        ...INITIAL_SETTINGS_V1,
        defaultVertical: vertical.id,
        defaultPreset: "research-checks",
        defaultProfile: "experiment",
      },
    ),
  );
  const cell = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(root),
    ownerId: "witness-rpc-seed",
    killpoint: (point) => {
      if (crashOnSubmit && point === "after_store_commit") {
        crashOnSubmit = false;
        throw new Error("Fixture response loss after submitted cut, before source invocation");
      }
    },
  });
  const applied = async (action: Record<string, unknown> & { kind: string }) => {
    const receipt = await cell.run(action, worker);
    assert.ok(
      receipt.outcome === "applied" || (receipt.outcome === "pending" && receipt.acceptance !== null),
      JSON.stringify(receipt),
    );
    if (receipt.acceptance !== null) await waitForFixturePublication(cell, receipt.opId, worker);
    console.log("WITNESS_RPC_SETUP=" + action.kind);
    return receipt;
  };
  try {
    await applied({ kind: "preset-install", packageSource: source });
    const created = await applied({
        kind: "task-create",
        taskId,
        title: "RPC artifact check",
        presetId: "research-checks",
        profileId: "experiment",
        riskTier: "low",
      }),
      packagePath = String((created as { packagePath?: string }).packagePath);
    await realizeTaskPlanFixture(
      root,
      packagePath,
      (p) => applied({ kind: "doc-submit", paths: [p] }),
      "RPC artifact check",
    );
    await applied({ kind: "task-start", taskId, executionId });
    mkdirSync(path.join(ledger, packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":42}\n');
    writeFileSync(
      path.join(ledger, packagePath, "closeout.md"),
      "## Summary\nRPC fixture.\n## Verification\nFrozen artifact check.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nDeclared source.\n",
    );
    await applied({ kind: "doc-submit", taskId });
    crashOnSubmit = true;
    const submitted = await cell.run({ kind: "task-submit", taskId, executionId }, worker);
    assert.equal(submitted.code, "publication_indeterminate", JSON.stringify(submitted));
    // A caller cannot replace submitted artifact bytes through its workspace.
    writeFileSync(path.join(ledger, packagePath, "artifacts/experiment.json"), '{"seed":"mutable"}\n');
  } finally {
    await cell.close();
  }
  console.log("WITNESS_RPC_SETUP=cell-closed");
  registerBootstrappedDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    mode: "remote-center",
    createConvenienceLinks: false,
  });
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  const host = await openDaemonHost({ daemonId: "witness-rpc", userRoot }),
    socketPath = localUserDaemonEndpoint(userRoot, "witness-rpc"),
    listener = net.createServer((socket) =>
      serveJsonRpcStream({
        input: socket,
        output: socket,
        transportKind: "unix-socket",
        authContext: auth,
        createProtocolServer: (authContext, emit, connectionId, signal) =>
          createJsonRpcProtocolServer({
            host,
            build: daemonBuildStamp(),
            authContext: { ...authContext, connectionSignal: signal },
            sessionPrincipal: (method, params) => host.sessionPrincipal(authContext, method, params),
            emit,
            connectionId,
          }),
      }),
    ),
    reader = makeTaskEventReader({ repoId, rootDir: root }),
    events = () =>
      reader
        .read()
        .events.filter(isTaskEvent)
        .filter((event) => event.taskId === taskId),
    rpc = (payload: Record<string, unknown>) =>
      requestDaemonJsonRpcAt(socketPath, method, { repo: { repoId }, payload }, 1_000, 30_000);
  try {
    console.log("WITNESS_RPC_SETUP=host-opened");
    await host.attachmentsSettled();
    console.log("WITNESS_RPC_SETUP=attached");
    if (process.platform !== "win32") mkdirSecurely(path.dirname(socketPath));
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, resolve);
    });
    const hello = await requestDaemonJsonRpcAt(
      socketPath,
      "protocol.hello",
      { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
      1_000,
      30_000,
    );
    assert.ok(Array.isArray(hello.methods) && hello.methods.includes(method));
    assert.equal(events().filter((event) => event.type === "completion_gate_verified").length, 0);
    assert.equal(
      events().findLast((event) => event.type === "execution_submitted")?.payload.execution.state,
      "submitted",
    );
    for (const forged of [
      { result: "pass" },
      { evidence: {} },
      { witnessId: "forged" },
      { claimFence: 1 },
      { command: "echo pass" },
    ]) {
      const rejected = await rpc({ ...request, ...forged });
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
      assert.equal(rejected.code, "unknown_field");
      assert.equal(rejected.outcome, "op_rejected");
    }
    signInPolicyTestUser(userRoot, "viewer", [repoId], "viewer");
    const denied = await rpc(request);
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.code, "authorization_denied");
    assert.equal(events().filter((event) => event.type === "gate_run_changed").length, 0);
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    for (const invalid of [
      { ...request, executionId: "exe-stale" },
      { ...request, gateId: "not-declared" },
    ]) {
      const rejected = await rpc(invalid);
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
      assert.equal(rejected.code, invalid.executionId === "exe-stale" ? "gate_run_stale" : "invalid_command");
    }
    const pair = await Promise.all([rpc(request), rpc(request)]);
    for (const result of pair) assert.equal(result.ok, true, JSON.stringify(result));
    const result = await rpc(request),
      witness = result.witness as Record<string, unknown>;
    assert.equal(witness.result, "pass", JSON.stringify(result));
    assert.equal(typeof witness.witnessId, "string");
    assert.equal(witness.diagnostic, "Frozen artifact seed checked by HA");
    const verified = events().filter((event) => event.type === "completion_gate_verified");
    assert.equal(verified.length, 1);
    assert.equal(events().filter((event) => event.type === "gate_run_changed").length, 1);
    assert.equal(verified[0]!.payload.witness.witnessId, witness.witnessId);
    assert.equal(verified[0]!.actor.executor?.id, "completion-source:research/anchor-check");
    assert.equal(verified[0]!.payload.execution.gateRuns.length, 1);
    const failed = await rpc({ ...request, gateId: "second-check" });
    assert.equal(failed.ok, true, JSON.stringify(failed));
    assert.equal((failed.witness as Record<string, unknown>).result, "fail");
    assert.equal(events().filter((event) => event.type === "completion_gate_verified").length, 2);
    console.log("WITNESS_RPC_RESULTS=" + JSON.stringify({ denied, pair, result, failed }));
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    console.log("WITNESS_RPC_SETUP=closing-host");
    await host.close();
    console.log("WITNESS_RPC_SETUP=closed-host");
    await reader.drain();
    rmSync(root, { recursive: true, force: true });
  }
});
