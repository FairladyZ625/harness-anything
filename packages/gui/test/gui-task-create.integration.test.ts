// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { readCatalogPreset } from "../src/renderer/api-client-catalog.ts";
import { startWorkPlan } from "../src/renderer/start-work-flow.ts";
import { parseDaemonGuiReadResult, requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";

test(
  "GUI task creation uses the daemon Action authorization and system read matches ha daemon status",
  { timeout: 150_000 },
  async (context) => {
    const fixture = await startGuiResidentDaemonFixture({
        displayName: "GUI Task Create Probe",
        attachTimeoutMs: 20_000,
        shutdownDeadlineMs: 5_000,
      }),
      previous = {
        userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
        daemonId: process.env.HARNESS_DAEMON_ID,
        repoId: process.env.HARNESS_DAEMON_REPO_ID,
      };
    Object.assign(process.env, fixture.env);
    context.after(async () => {
      await fixture.stop();
      restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
      restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
      restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
    });

    const bridge = createLocalGuiServiceBridge(fixture.rootDir);
    let payload: {
      readonly repoId: string;
      readonly title: string;
      readonly presetId: string;
      readonly verticalId: string;
      readonly locale: string;
      readonly riskTier: string;
      readonly taskClass: string;
      readonly workKind: string;
      readonly idempotencyKey: string;
      readonly plan: string;
    } | null = null;

    await context.test("selected preset provides the plan scaffold used by the GUI", async () => {
      const detail = readCatalogPreset(
          await bridge.invoke("getCatalogPreset", { repoId: fixture.repoId, presetId: "standard-task" }),
        ),
        scaffold = detail.resolved.documents.find(({ slot }) => slot === "task.plan");
      assert.ok(scaffold, "the selected preset must provide a task.plan scaffold");
      const plan = startWorkPlan(
        scaffold.body,
        "Created from the GUI bridge",
        "Prove that the GUI action reaches the authorized daemon task-create path.",
        "Use the Brief above as the objective for this section.",
      );
      assert.ok(plan, "the selected preset scaffold must produce a task plan");
      payload = {
        repoId: fixture.repoId,
        title: "Created from the GUI bridge",
        presetId: "standard-task",
        verticalId: "software/coding",
        locale: "en-US",
        riskTier: "medium",
        taskClass: "standard",
        workKind: "feat",
        idempotencyKey: "gui-bridge-task-create-positive",
        plan,
      };
    });
    assert.ok(payload, "the selected preset must produce a task-create payload");
    const createPayload = payload;

    await context.test("authorized creation returns the canonical task receipt", async () => {
      const receipt = (await bridge.invoke("createTask", createPayload)) as Record<string, unknown>;
      assert.equal(receipt.schema, "command-receipt/v2", JSON.stringify(receipt));
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(receipt.command, "task-create", JSON.stringify(receipt));
      assert.ok(["applied", "pending", "no_changes"].includes(String(receipt.outcome)), JSON.stringify(receipt));
      assert.equal(typeof receipt.taskId, "string", JSON.stringify(receipt));
      assert.equal(typeof receipt.packagePath, "string", JSON.stringify(receipt));
      assert.equal(typeof receipt.opId, "string", JSON.stringify(receipt));
    });

    await context.test("revoked Action grant returns authorization_denied", async () => {
      fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-create"]);
      const denied = (await bridge.invoke("createTask", {
        ...createPayload,
        title: "Denied from the GUI bridge",
        idempotencyKey: "gui-bridge-task-create-negative",
      })) as Record<string, unknown>;
      assert.equal(denied.schema, "command-receipt/v2", JSON.stringify(denied));
      assert.equal(denied.ok, false, JSON.stringify(denied));
      assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
      assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
    });

    await context.test("authorized system read matches the repo rows used by ha daemon status", async () => {
      const system = parseDaemonGuiReadResult("daemon.gui.system.read", await bridge.invoke("getSystemStatus", null)),
        cliStatus = await requestDaemonJsonRpcAt(
          fixture.endpoint,
          "daemon.status",
          {},
          1_000,
          undefined,
          undefined,
          true,
        );
      assert.deepEqual(
        system.repos.map(({ repoId, displayName, canonicalRoot, registrationState, cellState }) => {
          assert.equal(typeof displayName, "string");
          assert.ok(displayName.trim().length > 0);
          return [repoId, canonicalRoot, registrationState, cellState];
        }),
        cliStatus.repos.map(({ repoId, rootDir, registrationState, state }) => [
          repoId,
          rootDir === "" ? null : rootDir,
          registrationState ?? "enabled",
          state === "closed" ? "not_loaded" : state,
        ]),
      );
    });
  },
);
