// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/dispatch-stream.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

const fixtureNativeId = "019abcdef-1234-5678-9999-abcdef123456";
const phrase = "resolved-home-handoff-sentinel";

// The directory a launch resolved is frozen into its dispatch stream and is the only
// directory export, install and settlement metrics consult: an operator-configured
// home survives a later isolation flip on the source, and the target installs into
// the home its own prepared launch resolved — never a userRoot/instance layout.
test("native handoff reads the launch-frozen provider directory on both nodes", { timeout: 240_000 }, async (t) => {
  const f = await fleetFixture(
      t,
      ["tasks/task-fleet-fleet", "agents"],
      [
        {
          installationId: "handoff-codex",
          kindId: "codex",
          executablePath: "/usr/bin/true",
          version: "codex-cli 0.159.1",
          observedAt: new Date().toISOString(),
        },
      ],
    ),
    { repoId, taskId } = f.subject,
    // Two independent operator homes: the source launch resolves home A, the target
    // launch resolves home C. Neither equals any userRoot/instance directory.
    homeA = path.join(f.root, "operator-home-a"),
    homeC = path.join(f.root, "operator-home-c"),
    executablePath = writeProviderExecutable(
      path.join(f.root, "codex.mjs"),
      `
import { mkdirSync, writeFileSync, readFileSync, globSync } from 'node:fs';
import path from 'node:path';
const id = ${JSON.stringify(fixtureNativeId)}, home = process.env.CODEX_HOME;
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.1'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
for await (const chunk of process.stdin) { /* drain the real prompt */ }
const sessions = path.join(home, 'sessions'), resumed = process.argv.includes('resume');
let message = 'source settled';
if (resumed) {
  if (!process.argv.includes(id)) throw new Error('native identity changed');
  const matches = globSync('**/rollout-*-' + id + '.jsonl', { cwd: sessions });
  if (matches.length !== 1) throw new Error('native rollout unavailable');
  const native = readFileSync(path.join(sessions, matches[0]), 'utf8');
  if (!native.includes(${JSON.stringify(phrase)})) throw new Error('conversation missing');
  message = ${JSON.stringify(phrase)};
} else {
  const directory = path.join(sessions, '2026', '10', '04'); mkdirSync(directory, {recursive:true});
  const records = [
    {type:'session_meta',payload:{id,cli_version:'0.159.1',timestamp:'2026-10-04T00:00:00.000Z'}},
    {type:'response_item',payload:{type:'function_call_output',output:${JSON.stringify(phrase)}}},
    {type:'compacted',payload:{message:${JSON.stringify(phrase)}}}
  ];
  writeFileSync(path.join(directory,'rollout-2026-10-04T00-00-00-' + id + '.jsonl'), records.map(JSON.stringify).join('\\n')+'\\n');
}
for (const row of [{type:'thread.started',thread_id:id},
 {type:'item.completed',item:{id:'answer',type:'agent_message',text:message}},
 {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(row));
`,
    ),
    installation = {
      installationId: "handoff-codex",
      kindId: "codex",
      executablePath,
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    },
    instance = {
      instanceId: "handoff-codex",
      name: "Handoff Codex",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
      isolationState: "operator-environment",
      codex: { reasoningEffort: "high" },
    },
    localAuth = localAuthFixture();
  await f.host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth);
  const packageSource = path.join(f.root, "handoff-agent");
  mkdirSync(packageSource);
  writeFileSync(
    path.join(packageSource, "agent.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id: "handoff-worker",
      name: "Handoff Worker",
      instructions: "Continue the same task.",
      runtimes: [{ type: "codex" }],
      role: "worker",
    }),
  );
  const installed = await f.host.run(
    repoId,
    { kind: "agent-install", packageSource, expectedVersion: 0, idempotencyKey: "handoff-agent" },
    localAuth,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  await waitForFleetPublication(f.host, repoId, installed.opId, localAuth);
  const center = await f.hold(
      listenFleetTls({
        host: f.host,
        ...f.writerOptions,
        stateRoot: f.stateRoot,
        key: f.key,
        cert: f.cert,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (_node, credential) => credential === "machine-secret",
        nodeOwner: f.owners.nodeOwner,
        verifyHuman: f.owners.verifyHuman,
      }),
    ),
    remote = path.join(f.root, "code.git");
  git(f.root, "init", "--bare", "-q", "--initial-branch=main", remote);
  const sourceRoot = path.join(f.root, "source");
  mkdirSync(path.join(sourceRoot, "harness"), { recursive: true });
  initRepo(sourceRoot);
  git(sourceRoot, "branch", "-M", "main");
  writeFileSync(
    path.join(sourceRoot, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: handoff\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(sourceRoot, "add", "harness");
  git(sourceRoot, "commit", "-qm", "test: code baseline");
  git(sourceRoot, "remote", "add", "origin", remote);
  git(sourceRoot, "push", "-qu", "origin", "main");
  const targetRoot = path.join(f.root, "target");
  git(f.root, "clone", "-q", remote, targetRoot);
  git(targetRoot, "config", "user.name", "Handoff Test");
  git(targetRoot, "config", "user.email", "handoff@example.invalid");
  async function node(nodeId: string, rootDir: string, providerHome: string) {
    const userRoot = path.join(f.root, `${nodeId}-user`),
      viewRoot = path.join(f.root, `${nodeId}-view`);
    await runFleetReplicaPullClient({
      readAccessToken: async () => `device-token-${nodeId}`,
      port: center.port,
      ca: f.cert,
      nodeId,
      credential: "machine-secret",
      repoId,
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    applyFleetMirrorCut(viewRoot, repoId, rootDir, "pull");
    registerBootstrappedDaemonRepo({
      canonicalRoot: rootDir,
      repoId,
      mode: "remote-edge",
      userRoot,
      createConvenienceLinks: false,
    });
    f.owners.signIn(userRoot, nodeId);
    const host = await openDaemonHost({
      daemonId: nodeId,
      userRoot,
      runtimeDiscover: () => [installation],
      // The daemon's operator environment pins this node's provider home; the real
      // launch resolves CODEX_HOME from here, not from any instance layout.
      runtimeEnv: { CODEX_HOME: providerHome },
    });
    t.after(() => host.close());
    await host.attachmentsSettled();
    await host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth);
    const request = {
      host: "127.0.0.1",
      port: center.port,
      caPath: f.certFile,
      nodeId,
      credential: "machine-secret",
      repoId,
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
      workspaceRoot: rootDir,
    };
    writeFileSync(
      path.join(rootDir, "fleet-edge.json"),
      JSON.stringify({ schema: "fleet-edge-config/v1", ...request }),
    );
    return {
      userRoot,
      rootDir,
      host,
      run: (method: "repo.agentRuntime.spawn" | "repo.agentRuntime.handoff", action: JsonObject) =>
        host.fleet.edgeRuntime({ ...request, method, action }, localAuth),
    };
  }
  const source = await node("node-one", sourceRoot, homeA),
    target = await node("node-two", targetRoot, homeC);
  const waitForOutcome = async (runtimeSessionId: string) => {
    const receipt = await f.host.awaitRuntimeSessions(
      repoId,
      { runtimeSessionIds: [runtimeSessionId], mode: "all" },
      { ...localAuth, connectionSignal: t.signal },
    );
    // The handoff source settles unknown (no witnessed delivery); a zero exit plus a result
    // reference no longer restates success.
    assert.equal(receipt.outcome, "unknown", JSON.stringify(receipt));
    assert.deepEqual(receipt.unavailable, []);
  };
  const dispatch = async (idempotencyKey: string, prompt: string) => {
    const spawned = await source.run("repo.agentRuntime.spawn", {
      agentId: "handoff-worker",
      runtimeInstanceId: instance.instanceId,
      taskId,
      handoffEnabled: true,
      prompt,
      idempotencyKey,
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    await waitForOutcome(String(spawned.runtimeSessionId));
    return spawned;
  };
  // Source launch: operator home A is frozen into the stream header at launch.
  const first = await dispatch("resolved-home-source", "Remember the private tool result.");
  const dispatchId = String(first.dispatchId),
    sourceWorktree = path.join(sourceRoot, ".worktrees", taskId);
  assert.equal(readDispatchStream(sourceRoot, dispatchId)?.header.resolvedProviderDirectory, homeA);
  const sourceFiles = globSync(`**/rollout-*-${fixtureNativeId}.jsonl`, { cwd: path.join(homeA, "sessions") });
  assert.equal(sourceFiles.length, 1);
  const sourceNative = readFileSync(path.join(homeA, "sessions", sourceFiles[0]!));
  const commit = git(sourceWorktree, "rev-parse", "HEAD");
  git(sourceWorktree, "push", "-q", "origin", `HEAD:refs/heads/${taskId}`);
  // Flip the source instance to enforced isolation after settlement: the export must
  // still read the frozen home A, not the instance directory the flip created.
  const flipped = await source.host.runtimeInstance(
    "daemon.runtimeInstance.update",
    { instanceId: instance.instanceId, isolationState: "enforced" },
    localAuth,
  );
  assert.equal(flipped.outcome, "applied", JSON.stringify(flipped));
  const exported = await source.run("repo.agentRuntime.handoff", { operation: "export", dispatchId });
  assert.equal(exported.outcome, "applied", JSON.stringify(exported));
  assert.equal((exported.checkpoint as JsonObject).commit, commit);
  assert.equal(
    readFileSync(path.join(f.repo, ".harness/runtime-handoffs", dispatchId, "rollout.jsonl")).equals(sourceNative),
    true,
    "export reads the launch-frozen operator home after the isolation flip",
  );
  // The settled round released its lease; a new source round needs a started execution
  // before the edge will dispatch into it again.
  const reopened = await f.host.run(
    repoId,
    { kind: "task-transition", taskId, status: "planned", reason: "Reopen for the enforced-isolation source round" },
    f.auth,
  );
  assert.equal(reopened.outcome, "applied", JSON.stringify(reopened));
  const restarted = await f.host.run(repoId, { kind: "task-start", taskId }, f.auth);
  assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
  // The next launch of the same instance freezes its own witness: enforced isolation
  // resolves the instance directory the new launch actually uses.
  const second = await dispatch("resolved-home-source-enforced", "Settle again under enforced isolation.");
  const secondDispatchId = String(second.dispatchId);
  assert.equal(
    readDispatchStream(sourceRoot, secondDispatchId)?.header.resolvedProviderDirectory,
    path.join(source.userRoot, "runtime-instances", instance.instanceId, "home", ".codex"),
  );
  // A stream without a witness — every dispatch launched before the field existed —
  // fails closed instead of guessing a directory from current configuration.
  const streamFile = dispatchStreamPath(sourceRoot, secondDispatchId),
    raw = readFileSync(streamFile, "utf8"),
    headerEnd = raw.indexOf("\n"),
    stripped = JSON.parse(raw.slice(0, headerEnd)) as Record<string, unknown>;
  delete stripped.resolvedProviderDirectory;
  writeFileSync(streamFile, `${JSON.stringify(stripped)}\n${raw.slice(headerEnd + 1)}`);
  await assert.rejects(source.run("repo.agentRuntime.handoff", { operation: "export", dispatchId: secondDispatchId }), {
    code: "runtime_handoff_rollout_missing",
  });
  // Target claim: install and resume both use the home the target launch resolved (C).
  const returned = await f.host.run(
    repoId,
    { kind: "task-transition", taskId, status: "planned", reason: "Return before cross-node handoff" },
    f.auth,
  );
  assert.equal(returned.outcome, "applied", JSON.stringify(returned));
  const started = await f.host.run(
    repoId,
    { kind: "task-start", taskId },
    f.owners.auth({ ...f.subject, nodeId: "node-two", viewId: "node-two" }),
  );
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const claim = {
    operation: "claim",
    dispatchId,
    runtimeInstanceId: instance.instanceId,
    prompt: "Recall the tool result.",
    idempotencyKey: "resolved-home-target",
  };
  const resumed = await target.run("repo.agentRuntime.handoff", claim);
  assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
  const targetDispatch = String(resumed.dispatchId);
  await waitForOutcome(String(resumed.runtimeSessionId));
  const targetStream = readDispatchStream(targetRoot, targetDispatch);
  assert.equal(targetStream?.header.resolvedProviderDirectory, homeC);
  assert.equal(targetStream?.providerSessionId, fixtureNativeId);
  assert.ok(targetStream?.terminalOutcome);
  assert.equal(
    targetStream.terminalOutcome!.body.includes(phrase),
    true,
    "the resumed provider read the rollout installed into its own resolved home",
  );
  const installedFiles = globSync(`**/rollout-*-${fixtureNativeId}.jsonl`, { cwd: path.join(homeC, "sessions") });
  assert.equal(installedFiles.length, 1);
  assert.equal(
    existsSync(path.join(target.userRoot, "runtime-instances", instance.instanceId, "home", ".codex", "sessions")),
    false,
    "no rollout is installed into a userRoot/instance layout",
  );
  assert.equal(
    JSON.stringify(
      makeTaskEventReader({ rootDir: f.repo, repoId })
        .read()
        .events.filter((event) => event.type === "runtime_handoff_exported"),
    ).includes(phrase),
    false,
    "the private tool result never reaches the canonical ledger",
  );
});
