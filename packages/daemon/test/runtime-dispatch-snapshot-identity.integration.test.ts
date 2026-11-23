// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { validateAgentDispatchPreview } from "../src/daemon-host/gui-s3-control.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { waitForArrival, watchDirectoryArrival, watchFileArrival } from "../../../tools/fixtures/event-arrival.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerSettledBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

test("dispatch seals Agent/Skill snapshot digests, isolates post-launch tampering, and fences bare providerSessionId resumes", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dispatch-snapshot-fence-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    launchLog = path.join(parent, "provider-launches.ndjson"),
    gateDir = path.join(parent, "gates"),
    repoId = "dispatch-snapshot-fence",
    uid = process.getuid?.() ?? 0;
  mkdirSync(gateDir, { recursive: true });

  const executablePath = writeProviderExecutable(
      path.join(parent, "codex-snapshot-provider.mjs"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'if (process.argv[2] === "login") process.exit(0);',
        'let prompt = "";',
        "for await (const chunk of process.stdin) prompt += chunk;",
        "const args = process.argv.slice(2);",
        'const resumeIdx = args.indexOf("resume");',
        "const resumedSession = resumeIdx >= 0 ? args.at(-2) : null;",
        `const launchIndex = fs.existsSync(${JSON.stringify(launchLog)}) ? fs.readFileSync(${JSON.stringify(launchLog)}, "utf8").trim().split("\\n").filter(Boolean).length + 1 : 1;`,
        "const sessionId = resumedSession ?? `provider-sealed-session-${launchIndex}`;",
        `fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ launchIndex, sessionId, resumedSession }) + "\\n");`,
        'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sessionId }) + "\\n");',
        "const gateMatch = prompt.match(/WAIT_GATE:([A-Za-z0-9_-]+)/u);",
        "if (gateMatch) {",
        `  const gateFile = path.join(${JSON.stringify(gateDir)}, gateMatch[1] + ".open");`,
        "  if (!fs.existsSync(gateFile)) {",
        "    await new Promise((resolve) => {",
        `      const watcher = fs.watch(${JSON.stringify(gateDir)}, () => {`,
        "        if (fs.existsSync(gateFile)) { watcher.close(); resolve(); }",
        "      });",
        "      if (fs.existsSync(gateFile)) { watcher.close(); resolve(); }",
        "    });",
        "  }",
        "}",
        "const skillMatch = prompt.match(/- sealed-skill: (.+\\/SKILL\\.md)/u);",
        'const skillPath = skillMatch ? skillMatch[1].trim() : "";',
        'const skillBody = skillPath && fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : "MISSING";',
        'const helperPath = skillPath ? path.join(path.dirname(skillPath), "notes", "linked.txt") : "";',
        'const helperBody = helperPath && fs.existsSync(helperPath) ? fs.readFileSync(helperPath, "utf8") : "MISSING";',
        'process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "witness", type: "agent_message", text: `skill=${skillBody.trim()}|helper=${helperBody.trim()}`, skill_path: skillPath, skill_body: skillBody, helper_body: helperBody } }) + "\\n");',
        'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
        "",
      ].join("\n"),
    ),
    installation = {
      installationId: "installation-codex-snapshot",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-11-20T00:00:00.000Z",
    };

  initRepo(root, uid);
  signInPolicyTestUser(userRoot, "owner", [repoId], "admin");

  const skillDir = path.join(root, "harness", "skills", "sealed-skill"),
    skillFile = path.join(skillDir, "SKILL.md"),
    targetsDir = path.join(skillDir, "targets"),
    notesDir = path.join(skillDir, "notes"),
    targetV1 = path.join(targetsDir, "v1.txt"),
    targetV2 = path.join(targetsDir, "v2.txt"),
    linkedNote = path.join(notesDir, "linked.txt");
  mkdirSync(targetsDir, { recursive: true });
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(skillFile, "SEALED_SKILL_V1\n");
  writeFileSync(targetV1, "LINK_TARGET_V1\n");
  writeFileSync(targetV2, "LINK_TARGET_V2\n");
  symlinkSync(path.join("..", "targets", "v1.txt"), linkedNote);

  await registerSettledBootstrappedDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-dispatch-snapshot-fence",
      userRoot,
      runtimeDiscover: () => [installation],
    });
  await host.attachmentsSettled();

  const launchCount = (): number =>
    existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean).length : 0;

  try {
    assert.equal(
      (
        await host.run(
          repoId,
          { kind: "settings-update", runtimeAllowedInstances: ["codex-snapshot"], idempotencyKey: "allow-snapshot" },
          auth,
        )
      ).outcome,
      "applied",
    );
    await host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-snapshot",
        name: "Codex Snapshot",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["snapshot-model"],
        authMode: "subscription",
      },
      auth,
    );

    for (const [id, instructions] of [
      ["agent-alpha", "Follow alpha instructions."],
      ["agent-beta", "Follow beta instructions."],
    ] as const) {
      const installed = await host.run(
        repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id,
            name: id,
            instructions,
            runtimes: [{ type: "codex" }],
            skills: [{ id: "sealed-skill", path: "skills/sealed-skill" }],
          },
        },
        auth,
      );
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    }

    // 1. Dry-run preview computes both digests without launching or leaving snapshot files behind.
    const preview = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Preview check.",
        taskId: null,
        dryRun: true,
        dispatchKey: "preview-alpha-1",
      },
    });
    assert.deepEqual(validateAgentDispatchPreview(preview), []);
    assert.match(String(preview.agentDeclarationDigest), SHA256_DIGEST);
    assert.match(String(preview.skillSnapshotDigest), SHA256_DIGEST);
    assert.equal(launchCount(), 0);
    assert.equal(
      existsSync(path.join(root, ".harness", "runtime", "sealed-skills", String(preview.runtimeSessionId))),
      false,
      "dry-run must not leave materialized skill snapshots on disk",
    );

    // 2. Negative A (preview -> launch drift): SKILL.md mutation, symlink retarget, and Agent reinstall are all rejected.
    writeFileSync(skillFile, "DRIFTED_SKILL_V2\n");
    const driftedSkillAttempt = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Should reject drifted skill.",
        taskId: null,
        expectedAgentDeclarationDigest: preview.agentDeclarationDigest,
        expectedSkillSnapshotDigest: preview.skillSnapshotDigest,
        dispatchKey: "launch-drifted-skill",
      },
    });
    assert.equal(driftedSkillAttempt.outcome, "op_rejected", JSON.stringify(driftedSkillAttempt));
    assert.equal(driftedSkillAttempt.code, "dispatch_snapshot_stale");
    assert.equal(launchCount(), 0);
    writeFileSync(skillFile, "SEALED_SKILL_V1\n");

    unlinkSync(linkedNote);
    symlinkSync(path.join("..", "targets", "v2.txt"), linkedNote);
    const driftedSymlinkAttempt = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Should reject retargeted symlink.",
        taskId: null,
        expectedAgentDeclarationDigest: preview.agentDeclarationDigest,
        expectedSkillSnapshotDigest: preview.skillSnapshotDigest,
        dispatchKey: "launch-drifted-symlink",
      },
    });
    assert.equal(driftedSymlinkAttempt.outcome, "op_rejected", JSON.stringify(driftedSymlinkAttempt));
    assert.equal(driftedSymlinkAttempt.code, "dispatch_snapshot_stale");
    assert.equal(launchCount(), 0);
    unlinkSync(linkedNote);
    symlinkSync(path.join("..", "targets", "v1.txt"), linkedNote);

    await host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "agent-alpha",
          name: "agent-alpha",
          instructions: "Mutated alpha instructions after preview.",
          runtimes: [{ type: "codex" }],
          skills: [{ id: "sealed-skill", path: "skills/sealed-skill" }],
        },
      },
      auth,
    );
    const driftedAgentAttempt = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Should reject reinstalled agent.",
        taskId: null,
        expectedAgentDeclarationDigest: preview.agentDeclarationDigest,
        expectedSkillSnapshotDigest: preview.skillSnapshotDigest,
        dispatchKey: "launch-drifted-agent",
      },
    });
    assert.equal(driftedAgentAttempt.outcome, "op_rejected", JSON.stringify(driftedAgentAttempt));
    assert.equal(driftedAgentAttempt.code, "dispatch_snapshot_stale");
    assert.equal(launchCount(), 0);

    // Restore original agent-alpha so digests match the original preview exactly.
    await host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "agent-alpha",
          name: "agent-alpha",
          instructions: "Follow alpha instructions.",
          runtimes: [{ type: "codex" }],
          skills: [{ id: "sealed-skill", path: "skills/sealed-skill" }],
        },
      },
      auth,
    );

    // 3. Positive + Negative B (launch -> provider-read tamper): overwrite and delete original SKILL.md while provider is live.
    const launched = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Execute with WAIT_GATE:tamper_after_launch",
        taskId: null,
        expectedAgentDeclarationDigest: preview.agentDeclarationDigest,
        expectedSkillSnapshotDigest: preview.skillSnapshotDigest,
        dispatchKey: "launch-alpha-sealed",
      },
    });
    assert.equal(launched.outcome, "applied", JSON.stringify(launched));
    const dispatchId = String(launched.dispatchId),
      runtimeSessionId = String(launched.runtimeSessionId);

    await waitForDispatchRecord(root, dispatchId, (record) => record.kind === "provider_binding");
    // Tamper and delete the live source files AFTER launch, BEFORE the provider reads its prompt skill path.
    writeFileSync(skillFile, "TAMPERED_AFTER_LAUNCH\n");
    unlinkSync(skillFile);
    unlinkSync(targetV1);
    writeFileSync(path.join(gateDir, "tamper_after_launch.open"), "open\n");

    const witness = await waitForDispatchRecord(
      root,
      dispatchId,
      (record) =>
        record.kind === "provider_event" && (record.event as { item?: { id?: string } })?.item?.id === "witness",
    );
    const item = (witness.event as { item: { skill_body: string; helper_body: string; skill_path: string } }).item;
    assert.equal(
      item.skill_body,
      "SEALED_SKILL_V1\n",
      "running provider must read sealed snapshot bytes, not deleted source",
    );
    assert.equal(item.helper_body, "LINK_TARGET_V1\n", "resolved symlink target bytes must be sealed in snapshot");
    assert.notEqual(item.skill_path, skillFile);

    // Wait for session exit & settlement, verifying canonical event digests and snapshot directory cleanup.
    await waitForArrival(
      async () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
          )
          ? true
          : null,
      watchDirectoryArrival(parent),
    );
    const dispatchEvent = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.find((event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === dispatchId);
    assert.ok(dispatchEvent && dispatchEvent.type === "runtime_dispatch_requested");
    assert.equal(dispatchEvent.payload.agentDeclarationDigest, preview.agentDeclarationDigest);
    assert.equal(dispatchEvent.payload.skillSnapshotDigest, preview.skillSnapshotDigest);
    assert.equal(
      existsSync(path.join(root, ".harness", "runtime", "sealed-skills", runtimeSessionId)),
      false,
      "settled session must reclaim its local skill snapshot directory",
    );

    const providerSessionId = readDispatchStream(root, dispatchId)?.providerSessionId;
    assert.equal(providerSessionId, "provider-sealed-session-1");

    // Restore original skill files so agent-alpha and agent-beta have valid skills on disk.
    writeFileSync(skillFile, "SEALED_SKILL_V1\n");
    writeFileSync(targetV1, "LINK_TARGET_V1\n");

    // 4. Negative C (bare providerSessionId cross-identity resume): different Agent, stripped Agent, mutated Skill, and unknown session are rejected.
    const launchesBeforeResumeChecks = launchCount();
    const crossAgentResume = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-beta",
        cwd: { scope: "repo-root" },
        prompt: "Hijack alpha session as beta.",
        providerSessionId,
        taskId: null,
        dispatchKey: "bare-resume-wrong-agent",
      },
    });
    assert.equal(crossAgentResume.outcome, "op_rejected", JSON.stringify(crossAgentResume));
    assert.equal(crossAgentResume.code, "runtime_resume_agent_mismatch");

    const strippedAgentResume = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        cwd: { scope: "repo-root" },
        prompt: "Hijack alpha session without agent.",
        providerSessionId,
        taskId: null,
        dispatchKey: "bare-resume-stripped-agent",
      },
    });
    assert.equal(strippedAgentResume.outcome, "op_rejected", JSON.stringify(strippedAgentResume));
    assert.equal(strippedAgentResume.code, "runtime_resume_agent_mismatch");

    writeFileSync(skillFile, "INCOMPATIBLE_SKILL_MUTATION\n");
    const mutatedSkillResume = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Resume alpha after incompatible skill edit.",
        providerSessionId,
        taskId: null,
        dispatchKey: "bare-resume-mutated-skill",
      },
    });
    assert.equal(mutatedSkillResume.outcome, "op_rejected", JSON.stringify(mutatedSkillResume));
    assert.equal(mutatedSkillResume.code, "runtime_resume_skill_mismatch");
    writeFileSync(skillFile, "SEALED_SKILL_V1\n");

    const foreignSessionResume = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Resume unrecorded foreign provider session.",
        providerSessionId: "foreign-unrecorded-session",
        taskId: null,
        dispatchKey: "bare-resume-foreign-session",
      },
    });
    assert.equal(foreignSessionResume.outcome, "op_rejected", JSON.stringify(foreignSessionResume));
    assert.equal(foreignSessionResume.code, "runtime_resume_session_not_found");
    assert.equal(
      launchCount(),
      launchesBeforeResumeChecks,
      "rejected bare resumes must not launch any provider process",
    );

    // 5. Positive bare providerSessionId resume: same Agent + same Skill snapshot succeeds.
    const validBareResume = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-snapshot",
        agentId: "agent-alpha",
        cwd: { scope: "repo-root" },
        prompt: "Continue alpha legitimately.",
        providerSessionId,
        taskId: null,
        dispatchKey: "bare-resume-same-identity",
      },
    });
    assert.equal(validBareResume.outcome, "applied", JSON.stringify(validBareResume));
    await waitForDispatchRecord(
      root,
      String(validBareResume.dispatchId),
      (record) =>
        record.kind === "provider_event" && (record.event as { item?: { id?: string } })?.item?.id === "witness",
    );
    assert.equal(launchCount(), launchesBeforeResumeChecks + 1);
    t.diagnostic(
      `digests=agent:${String(preview.agentDeclarationDigest)} skill:${String(preview.skillSnapshotDigest)} launches=${String(launchCount())}`,
    );
  } finally {
    await host.close();
    removeTempRepository(parent);
  }
});

function initRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Snapshot Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "snapshot@example.invalid"]);
  writeFileSync(path.join(root, ".gitignore"), "/.harness/\n");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: dispatch-snapshot-fence\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify(
      {
        schema: "harness-people/v1",
        people: [
          {
            personId: "owner",
            displayName: "Owner",
            roles: ["owner"],
            credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }],
          },
        ],
        roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("git", ["-C", root, "add", ".gitignore", "harness"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
}

async function rpc(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host,
    build: daemonBuildStamp(),
    authContext: auth,
    emit: async () => undefined,
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method,
      params,
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    return (response as { result: Record<string, unknown> }).result;
  } finally {
    server.close();
  }
}

async function waitForDispatchRecord(
  root: string,
  dispatchId: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await waitForArrival(
    () => {
      const stream = readDispatchStream(root, dispatchId),
        match = stream?.records.find(predicate);
      if (match) return match;
      if (stream?.process?.exited)
        throw new Error(`provider exited before recording the awaited event: ${JSON.stringify(stream.records)}`);
      return null;
    },
    watchFileArrival(dispatchStreamPath(root, dispatchId)),
  );
}
