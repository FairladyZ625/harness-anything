// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetRuntimeEventClient } from "../src/fleet/edge.ts";
import { fleetFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { definition } from "./schedule-actions.fixtures.ts";

test(
  "center resume admission retains source identity and consumes it once across two TLS sessions of the lease-holding node",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t),
      first = fixture.subject,
      second = { ...first, nodeId: "node-two", viewId: "node-two" },
      center = await fixture.hold(
        listenFleetTls({
          host: fixture.host,
          ...fixture.writerOptions,
          stateRoot: fixture.stateRoot,
          key: fixture.key,
          cert: fixture.cert,
          replicaDiskQuotaBytes: 64 * 1024 * 1024,
          authenticate: (nodeId, credential) =>
            [first.nodeId, second.nodeId].includes(nodeId) && credential === "machine-secret",
          nodeOwner: fixture.owners.nodeOwner,
          verifyHuman: fixture.owners.verifyHuman,
        }),
      ),
      peer = (assignment = first) => ({
        readAccessToken: async () => `device-token-${assignment.nodeId}`,
        port: center.port,
        ca: fixture.cert,
        nodeId: assignment.nodeId,
        credential: "machine-secret",
        repoId: first.repoId,
      }),
      context = { role: null, taskId: first.taskId, executionId: first.executionId },
      dispatch = (key: string, source?: string, overrides: Record<string, unknown> = {}) => {
        const hash = createHash("sha256").update(`${first.repoId}\0${key}`).digest("hex");
        return {
          opId: `runtime-spawn-${hash.slice(0, 32)}`,
          eventType: "runtime_dispatch_requested",
          dispatchContext: context,
          payload: {
            dispatchId: `dispatch_${hash.slice(0, 24)}`,
            runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
            instanceId: definition.instanceId,
            installationId: definition.installationId,
            kindId: definition.kindId,
            idempotencyKey: key,
            definitionSnapshotRef: "artifact:runtime-definition/resume-test",
            definitionSnapshot: definition,
            taskId: first.taskId,
            executionId: first.executionId,
            agentId: "agent-source",
            ...(source ? { resumedFromDispatchId: source } : {}),
            ...overrides,
          },
        };
      },
      source = dispatch("source");
    await runFleetRuntimeEventClient({ ...peer(), ...source });
    const reject = async (key: string, code: string, overrides: Record<string, unknown> = {}) => {
      const before = fixture.eventCount();
      await assert.rejects(
        runFleetRuntimeEventClient({ ...peer(), ...dispatch(key, source.payload.dispatchId, overrides) }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === code,
      );
      assert.equal(fixture.eventCount(), before, `${key} must not consume the source or append an event`);
    };
    await reject("missing-provider", "runtime_dispatch_not_resumable");
    await runFleetRuntimeEventClient({
      ...peer(),
      opId: "source-start",
      eventType: "runtime_session_started",
      payload: {
        runtimeSessionId: source.payload.runtimeSessionId,
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        definitionSnapshotRef: source.payload.definitionSnapshotRef,
        launchGeneration: 1,
        attachable: true,
        taskBinding: { taskId: first.taskId, executionId: first.executionId },
      },
    });
    await runFleetRuntimeEventClient({
      ...peer(),
      opId: "source-provider",
      eventType: "runtime_session_provider_bound",
      payload: {
        runtimeSessionId: source.payload.runtimeSessionId,
        providerSessionId: "provider-source",
        transcriptRef: "provider:source",
      },
    });
    await reject("wrong-agent", "runtime_resume_agent_mismatch", { agentId: "another-agent" });
    await reject("wrong-execution", "runtime_scope_mismatch", { executionId: "another-execution" });
    fixture.setOwner("other-owner");
    await reject("wrong-owner", "runtime_task_lease_required");
    fixture.setOwner("person-owner");
    const before = fixture.eventCount();
    await assert.rejects(
      fixture.host.runtimeIngress(
        first.repoId,
        {
          kind: "event",
          type: "runtime_dispatch_requested",
          ...dispatch("wrong-node", source.payload.dispatchId),
        },
        fixture.owners.auth(second),
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_task_lease_required",
    );
    assert.equal(fixture.eventCount(), before);
    const attempts = await Promise.allSettled(
      ["resume-one", "resume-two"].map((key) =>
        runFleetRuntimeEventClient({ ...peer(), ...dispatch(key, source.payload.dispatchId) }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const loser = attempts.find((result) => result.status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.equal(loser.reason.code, "runtime_dispatch_already_resumed");
    await reject("duplicate", "runtime_dispatch_already_resumed");
    const events = makeTaskEventReader({ repoId: first.repoId, rootDir: fixture.repo }).read().events;
    assert.equal(
      events.filter(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.resumedFromDispatchId === source.payload.dispatchId,
      ).length,
      1,
    );
  },
);
