// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, sha256Text } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetRuntimeEventClient, runFleetTaskCommandClient, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { fleetFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { definition } from "./schedule-actions.fixtures.ts";

const nativeId = "019abcdef-1234-5678-9999-abcdef123456";
const body = Buffer.from(
  JSON.stringify({
    type: "session_meta",
    payload: {
      id: nativeId,
      cli_version: "0.159.1",
      timestamp: "2026-10-01T00:00:00.000Z",
    },
  }) +
    "\n" +
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "private-native-sentinel".repeat(8000) }],
      },
    }) +
    "\n",
);

test(
  "private export, lease-bound target read, atomic resume consumption and revocation through Fleet",
  { timeout: 90_000 },
  async (t) => {
    const f = await fleetFixture(t),
      source = f.subject,
      target = { ...source, nodeId: "node-two", viewId: "node-two" },
      center = await f.hold(
        listenFleetTls({
          host: f.host,
          ...f.writerOptions,
          stateRoot: f.stateRoot,
          key: f.key,
          cert: f.cert,
          replicaDiskQuotaBytes: 64 * 1024 * 1024,
          authenticate: (_node, credential) => credential === "machine-secret",
          nodeOwner: f.owners.nodeOwner,
        }),
      ),
      peer = (nodeId = source.nodeId) => ({
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        repoId: source.repoId,
      }),
      context = { taskId: source.taskId, executionId: source.executionId, role: null },
      dispatch = (key: string, extra: Record<string, unknown> = {}) => {
        const hash = createHash("sha256").update(`${source.repoId}\0${key}`).digest("hex");
        return {
          opId: `runtime-spawn-${hash.slice(0, 32)}`,
          eventType: "runtime_dispatch_requested",
          dispatchContext: context,
          payload: {
            dispatchId: `dispatch_${hash.slice(0, 24)}`,
            runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: "codex",
            idempotencyKey: key,
            definitionSnapshotRef: "artifact:runtime-definition/handoff-test",
            definitionSnapshot: { ...definition, kindId: "codex" },
            taskId: source.taskId,
            executionId: context.executionId,
            agentId: "agent-source",
            handoffEnabled: true,
            ...extra,
          },
        };
      },
      first = dispatch("handoff-source"),
      dispatchId = first.payload.dispatchId,
      command = (nodeId: string, action: Record<string, unknown>, privatePayload?: Uint8Array) =>
        runFleetTaskCommandClient({
          ...peer(nodeId),
          taskId: source.taskId,
          opId: `command-${randomUUID()}`,
          waitMs: 0,
          action: action as { kind: string },
          ...(privatePayload ? { privatePayload } : {}),
        });
    await runFleetRuntimeEventClient({ ...peer(), ...first });
    const sessionId = first.payload.runtimeSessionId;
    for (const [eventType, payload] of [
      [
        "runtime_session_started",
        {
          runtimeSessionId: sessionId,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: "codex",
          definitionSnapshotRef: first.payload.definitionSnapshotRef,
          launchGeneration: 1,
          attachable: true,
          taskBinding: { taskId: source.taskId, executionId: source.executionId },
        },
      ],
      [
        "runtime_session_provider_bound",
        { runtimeSessionId: sessionId, providerSessionId: nativeId, transcriptRef: "provider:native" },
      ],
    ] as const)
      await runFleetRuntimeEventClient({ ...peer(), eventType, payload, opId: eventType });
    const exportAction = { kind: "runtime-handoff-export", dispatchId, commit: "a".repeat(40) };
    const active = await command(source.nodeId, exportAction, body);
    assert.equal(active.receipt?.code, "runtime_handoff_ineligible", JSON.stringify(active));
    await runFleetRuntimeEventClient({
      ...peer(),
      eventType: "runtime_session_exited",
      payload: { runtimeSessionId: sessionId },
      opId: "source-exited",
    });
    await runFleetRuntimeEventClient({
      ...peer(),
      eventType: "runtime_session_outcome_observed",
      opId: "source-outcome",
      resultBody: "settled",
      payload: {
        runtimeSessionId: sessionId,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: `artifact:runtime-result/sha256/${sha256Text("settled")}`,
        result: { sha256: sha256Text("settled"), size: 7, mediaType: "text/plain; charset=utf-8" },
      },
    });
    const released = await f.host.run(
      source.repoId,
      { kind: "task-release", taskId: source.taskId, reason: "source settled" },
      f.auth,
    );
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const exported = await command(source.nodeId, exportAction, body);
    assert.equal(exported.outcome, "applied", JSON.stringify(exported));
    assert.ok(exported.receipt?.checkpoint, JSON.stringify(exported));
    const checkpointFile = path.join(f.repo, ".harness/runtime-handoffs", dispatchId, "checkpoint.json");
    assert.equal(existsSync(checkpointFile), true);
    assert.equal(readFileSync(checkpointFile, "utf8").includes("private-native-sentinel"), false);
    const viewRoot = path.join(f.root, "private-checkpoint-replica");
    await runFleetReplicaPullClient({ ...peer(target.nodeId), viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    const view = locateFleetMirrorView(viewRoot, source.repoId);
    assert.ok(view);
    assert.equal(
      [...view.entries.keys()].some((name) => /rollout|runtime-handoffs/u.test(name)),
      false,
    );
    const claim = { kind: "runtime-handoff-claim", dispatchId };
    const noLease = await command(target.nodeId, claim);
    assert.equal(noLease.receipt?.code, "runtime_task_lease_required", JSON.stringify(noLease));
    const returned = await f.host.run(
      source.repoId,
      { kind: "task-transition", taskId: source.taskId, status: "planned", reason: "Explicit rework before handoff" },
      f.auth,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const started = await f.host.run(
      source.repoId,
      { kind: "task-start", taskId: source.taskId },
      f.owners.auth(target),
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    assert.equal(typeof started.executionId, "string");
    context.executionId = String(started.executionId);
    assert.notEqual(context.executionId, source.executionId);
    const ready = await command(target.nodeId, claim);
    assert.equal(ready.outcome, "applied", JSON.stringify(ready));
    assert.equal(ready.receipt?.outcome, "no_changes");
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await command(target.nodeId, { ...claim, offset });
      const bytes = Buffer.from(String(chunk.receipt?.dataBase64), "base64");
      assert.ok(bytes.length > 0);
      offset += bytes.length;
      assert.equal(chunk.receipt?.nextOffset, offset);
      chunks.push(bytes);
      if (chunk.receipt?.done) break;
    }
    assert.ok(chunks.length > 1);
    assert.deepEqual(Buffer.concat(chunks), body);
    const sameNode = await command(source.nodeId, claim);
    assert.equal(sameNode.receipt?.code, "runtime_handoff_target_same");
    const otherNode = await command("node-slow", claim);
    assert.equal(otherNode.receipt?.code, "runtime_task_lease_required");
    await f.owners.reassign(target.nodeId, "person-other");
    const otherOwner = await command(target.nodeId, claim);
    assert.equal(otherOwner.receipt?.code, "runtime_handoff_owner_mismatch", JSON.stringify(otherOwner));
    await f.owners.reassign(target.nodeId, "person-owner");
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer(),
        ...dispatch("source-resume", {
          resumedFromDispatchId: dispatchId,
          resumeProviderSessionId: nativeId,
        }),
      }),
      { code: "runtime_task_lease_required" },
    );
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer(target.nodeId),
        ...dispatch("raw-resume", {
          resumeProviderSessionId: nativeId,
        }),
      }),
      { code: "runtime_handoff_source_exported" },
    );
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer(),
        eventType: "runtime_handoff_revoked",
        opId: "forged-revoke",
        payload: { dispatchId, runtimeSessionId: sessionId },
      }),
      /violates closed schema/u,
    );
    const resumed = {
      resumedFromDispatchId: dispatchId,
      handoffCheckpointId: dispatchId,
      resumeProviderSessionId: nativeId,
      acceptedCommit: "a".repeat(40),
    };
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer(target.nodeId),
        ...dispatch("wrong-sha", { ...resumed, acceptedCommit: "b".repeat(40) }),
      }),
      { code: "runtime_handoff_binding_mismatch" },
    );
    const attempts = await Promise.allSettled(
      ["target-one", "target-two"].map((key) =>
        runFleetRuntimeEventClient({ ...peer(target.nodeId), ...dispatch(key, resumed) }),
      ),
    );
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1, JSON.stringify(attempts));
    assert.equal(
      (attempts.find((item) => item.status === "rejected") as PromiseRejectedResult).reason.code,
      "runtime_dispatch_already_resumed",
    );
    const acceptedKey = ["target-one", "target-two"][attempts.findIndex((item) => item.status === "fulfilled")];
    const acceptedReplay = await command(target.nodeId, { ...claim, idempotencyKey: acceptedKey });
    assert.equal(acceptedReplay.receipt?.replayed, true, JSON.stringify(acceptedReplay));
    assert.equal(acceptedReplay.receipt?.handoffResumed, false, "admission alone does not confirm provider resume");
    const repeated = await command(target.nodeId, claim);
    assert.equal(repeated.receipt?.code, "runtime_dispatch_already_resumed", JSON.stringify(repeated));
    await center.close();
    await f.host.close();
    const restarted = await openDaemonHost({ daemonId: "fleet-center", userRoot: path.join(f.root, "user") });
    t.after(() => restarted.close());
    await restarted.attachmentsSettled();
    const afterRestart = await restarted.run(source.repoId, claim, f.owners.auth(target));
    assert.equal(afterRestart.code, "runtime_dispatch_already_resumed", JSON.stringify(afterRestart));
    const revoked = await restarted.run(source.repoId, { kind: "runtime-handoff-revoke", dispatchId }, f.auth);
    assert.equal(revoked.outcome, "applied", JSON.stringify(revoked));
    assert.equal(existsSync(path.join(path.dirname(checkpointFile), "rollout.jsonl")), false);
    const revokedRead = await restarted.run(source.repoId, claim, f.owners.auth(target));
    assert.equal(revokedRead.code, "runtime_handoff_revoked");
    const events = makeTaskEventReader({ rootDir: f.repo, repoId: source.repoId }).read().events;
    assert.equal(JSON.stringify(events).includes("private-native-sentinel"), false);
  },
);
