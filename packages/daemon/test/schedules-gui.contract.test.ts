// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScheduleV1 } from "../../kernel/src/index.ts";
import {
  daemonGuiActionMethods,
  daemonGuiReadMethods,
  validateDaemonRpcCall,
} from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { daemonGuiReadSchemas } from "../src/protocol/daemon-protocol-schema-registry.ts";
import { DAEMON_SCHEDULES_LIST_SCHEMA } from "../src/protocol/daemon-protocol-schema-ids.ts";
import {
  deriveScheduleExecutionAvailability,
  readSchedulesGui,
  type SchedulesGuiReadContext,
} from "../src/schedules-gui-read.ts";
import {
  serializeSchedulesList,
  validateSchedulesList,
  type ScheduleGuiRowDto,
  type SchedulesListResult,
} from "../src/protocol/schedules-gui-contract.ts";
import type { FleetRoster } from "../src/fleet-center-admission.ts";

const now = "2026-08-27T08:00:00.000Z";
const actor = { principal: { personId: "schedule-gui" }, executor: null } as const;
const roster = (nodeIds: readonly string[], scheduleIds: readonly string[]): FleetRoster => ({
  nodes: nodeIds.map((nodeId) => ({ nodeId, credential: `credential-${nodeId}` })),
  assignments: nodeIds.flatMap((nodeId, index) =>
    scheduleIds.map((scheduleId) => ({
      assignmentId: `assignment-${nodeId}-${scheduleId}`,
      nodeId,
      repoId: "schedule-gui",
      viewId: `view-${index}`,
      personId: "operator",
      executorId: undefined,
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: { kind: "schedule" as const, scheduleId, paths: ["schedules"] },
    })),
  ),
});

const armedSchedule = createScheduleV1({
  scheduleId: "heartbeat-probe",
  name: "Heartbeat probe",
  spec: {
    trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-27T07:00:00.000Z" },
    target: { kind: "agent", agentId: "probe-agent", runtimeInstanceId: "codex-schedule" },
    mission: "Scan the previous day of pull requests.",
  },
  actor,
  occurredAt: "2026-08-27T07:00:00.000Z",
});

function guiContext(overrides: Partial<SchedulesGuiReadContext> = {}): SchedulesGuiReadContext {
  return {
    mode: "local",
    rootDir: "/tmp/schedule-gui-unused",
    now: () => now,
    input: { repoId: "schedule-gui" },
    projection: {
      listEntities: (kind) => (kind === "schedule" ? [{ value: armedSchedule, workspaceRevision: 3 }] : []),
      readTaskStatuses: () => ({ status: "ready", watermark: 9, sourceRevision: 9 }),
    },
    ...overrides,
  };
}

test("the schedules list read facet is registered and payload-closed", () => {
  const facet = daemonGuiReadMethods.find(({ method }) => method === "repo.schedules.list");
  assert.ok(facet, "repo.schedules.list must be registered");
  assert.equal(facet.guiBridgeMethod, "listSchedules");
  assert.equal(facet.outputSchemaId, DAEMON_SCHEDULES_LIST_SCHEMA.id);
  assert.deepEqual(
    validateDaemonRpcCall({ method: "repo.schedules.list", params: { repo: { repoId: "schedule-gui" } } }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      method: "repo.schedules.list",
      params: { repo: { repoId: "schedule-gui" }, payload: { scheduleId: "heartbeat-probe" } },
    }),
    [],
  );
});

test("the three schedule GUI actions reuse the S3 action kinds", () => {
  const methods = daemonGuiActionMethods
    .filter(({ method }) => method.startsWith("repo.schedule."))
    .map(({ method, actionKind, guiBridgeMethod }) => ({ method, actionKind, guiBridgeMethod }));
  assert.deepEqual(methods, [
    { method: "repo.schedule.enable", actionKind: "schedule-enable", guiBridgeMethod: "enableSchedule" },
    { method: "repo.schedule.disable", actionKind: "schedule-disable", guiBridgeMethod: "disableSchedule" },
    { method: "repo.schedule.runNow", actionKind: "schedule-run-now", guiBridgeMethod: "runScheduleNow" },
  ]);
  const validate = (method: string, payload: Record<string, unknown>) =>
    validateDaemonRpcCall({ method, params: { repo: { repoId: "schedule-gui" }, payload } });
  for (const method of ["repo.schedule.enable", "repo.schedule.disable", "repo.schedule.runNow"]) {
    assert.deepEqual(validate(method, { scheduleId: "heartbeat-probe", idempotencyKey: "retry-1" }), []);
    assert.notDeepEqual(validate(method, { scheduleId: "heartbeat-probe" }), []);
    assert.notDeepEqual(validate(method, { scheduleId: "heartbeat-probe", idempotencyKey: 7 }), []);
    assert.notDeepEqual(validate(method, { scheduleId: "heartbeat-probe", idempotencyKey: "k", extra: true }), []);
  }
});

test("the schedules list validator locks the joined wire shape", () => {
  const result = readSchedulesGui(guiContext());
  assert.deepEqual(validateSchedulesList(result), []);
  assert.equal(parseDaemonGuiReadResult("repo.schedules.list", result), result);
  assert.equal(serializeSchedulesList(result), `${JSON.stringify(result)}\n`);
  const row = result.schedules[0] as ScheduleGuiRowDto;
  assert.equal(row.scheduleId, "heartbeat-probe");
  assert.equal(row.state, "armed");
  assert.equal(row.definitionResidency, "ledger");
  assert.equal(row.definitionRevision, 3);
  assert.deepEqual(row.trigger, { kind: "interval", everyMs: 1_800_000, timezone: null, summary: "every 30m" });
  assert.equal(row.executionAvailability, "local");
  assert.deepEqual(row.claim, { nodeId: null, assignmentId: null });
  assert.equal(row.nextRunAt, "2026-08-27T08:30:00.000Z");
  assert.equal(row.actions.runNow.available, true);
  assert.equal(row.actions.enable.available, false);
  assert.equal(row.actions.enable.code, "no_changes");
  assert.equal(row.watermarkParent, undefined);
  for (const mutation of [
    (value: SchedulesListResult) => ({ ...value, repoMode: "fleet" }),
    (value: SchedulesListResult) => ({ ...value, schedules: "many" }),
    (value: SchedulesListResult) => ({ ...value, apiKey: "secret" }),
  ])
    assert.notDeepEqual(validateSchedulesList(mutation(result)), []);
  const rowMutations = [
    (row: ScheduleGuiRowDto) => ({ ...row, state: "running" }),
    (row: ScheduleGuiRowDto) => ({ ...row, executionAvailability: "remote" }),
    (row: ScheduleGuiRowDto) => ({ ...row, nextRunAt: "tomorrow" }),
    (row: ScheduleGuiRowDto) => ({ ...row, target: { ...row.target, extra: 1 } }),
    (row: ScheduleGuiRowDto) => ({
      ...row,
      actions: { ...row.actions, runNow: { available: false, code: null, nextAction: null } },
    }),
    (row: ScheduleGuiRowDto) => ({ ...row, missed: { ...row.missed, lastMissedReason: "vibes" } }),
    (row: ScheduleGuiRowDto) => ({ ...row, activeRun: { occurrenceId: "x" } }),
  ];
  for (const mutate of rowMutations)
    assert.notDeepEqual(
      validateSchedulesList({ ...result, schedules: [mutate(row)] }),
      [],
      `mutation ${mutate.toString()} must be rejected`,
    );
});

test("availability distinguishes the four execution states from roster truth", () => {
  const base = { repoId: "schedule-gui", scheduleId: "heartbeat-probe", now };
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "local",
      viewerNodeId: "local",
      roster: null,
      activeNodeId: null,
    }),
    "local",
  );
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-edge",
      viewerNodeId: "edge-one",
      roster: roster(["edge-one"], ["heartbeat-probe"]),
      activeNodeId: null,
    }),
    "local",
  );
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-edge",
      viewerNodeId: "edge-two",
      roster: roster(["edge-one"], ["heartbeat-probe"]),
      activeNodeId: null,
    }),
    "not-on-this-node",
  );
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-edge",
      viewerNodeId: "edge-one",
      roster: roster(["edge-one"], ["other-schedule"]),
      activeNodeId: null,
    }),
    "unassigned",
  );
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-center",
      viewerNodeId: null,
      roster: roster(["edge-one"], ["heartbeat-probe"]),
      activeNodeId: "edge-one",
    }),
    "claimed-elsewhere",
  );
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-edge",
      viewerNodeId: "edge-one",
      roster: roster(["edge-one"], ["heartbeat-probe"]),
      activeNodeId: "edge-two",
    }),
    "claimed-elsewhere",
  );
  // An expired roster assignment is not an owner: the schedule reads unassigned.
  const expired = roster(["edge-one"], ["heartbeat-probe"]);
  expired.assignments[0]!.expiresAt = "2020-01-01T00:00:00.000Z";
  assert.equal(
    deriveScheduleExecutionAvailability({
      ...base,
      mode: "remote-edge",
      viewerNodeId: "edge-one",
      roster: expired,
      activeNodeId: null,
    }),
    "unassigned",
  );
});

test("a remote-edge read resolves viewer node and roster from the repo root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedules-edge-"));
  try {
    const rosterFile = path.join(root, "roster.json");
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema: "fleet-roster/v2",
        nodes: [{ nodeId: "edge-one", credential: "credential-edge-one" }],
        assignments: [
          {
            assignmentId: "assignment-edge-one",
            nodeId: "edge-one",
            repoId: "schedule-gui",
            viewId: "view-edge-one",
            personId: "operator",
            expiresAt: "2099-01-01T00:00:00.000Z",
            scope: { kind: "schedule", scheduleId: "heartbeat-probe", paths: ["schedules"] },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(root, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: "schedule-gui",
        host: "127.0.0.1",
        port: 1,
        caPath: "/tmp/ca.pem",
        nodeId: "edge-one",
        rosterPath: rosterFile,
        assignmentId: "assignment-edge-one",
        viewRoot: path.join(root, "view"),
        quotaBytes: 1024,
      }),
    );
    const result = readSchedulesGui(guiContext({ mode: "remote-edge", rootDir: root }));
    assert.equal(result.repoMode, "remote-edge");
    assert.equal(result.viewerNodeId, "edge-one");
    assert.equal(result.assignmentResolution, "roster");
    const row = result.schedules[0]!;
    assert.equal(row.executionAvailability, "local");
    assert.deepEqual(row.claim, { nodeId: "edge-one", assignmentId: "assignment-edge-one" });
    assert.equal(row.actions.runNow.available, true);
    assert.equal(row.actions.enable.available, false);
    assert.match(String(row.actions.enable.nextAction), /remote-edge repository does not author ledger state/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remote-center read keeps the catalog blockers instead of faking an executor", () => {
  const result = readSchedulesGui(
    guiContext({ mode: "remote-center", fleetRoster: roster(["edge-one"], ["heartbeat-probe"]) }),
  );
  assert.equal(result.repoMode, "remote-center");
  assert.equal(result.viewerNodeId, null);
  assert.equal(result.assignmentResolution, "roster");
  const row = result.schedules[0]!;
  assert.equal(row.executionAvailability, "not-on-this-node");
  assert.deepEqual(row.claim, { nodeId: "edge-one", assignmentId: "assignment-edge-one-heartbeat-probe" });
  // The catalog routes every schedule write on a center through assignment ingress, so
  // the run-now facet carries that exact blocker — the center never fakes an executor.
  assert.equal(row.actions.runNow.available, false);
  assert.equal(row.actions.runNow.code, "repo_mode_requires_center_ingress");
  for (const facet of [row.actions.enable, row.actions.disable])
    assert.equal(facet.code, "repo_mode_requires_center_ingress");
  const unresolved = readSchedulesGui(guiContext({ mode: "remote-center" }));
  assert.equal(unresolved.assignmentResolution, "unavailable");
  assert.equal(unresolved.schedules[0]!.executionAvailability, "not-on-this-node");
});

test("paused and single-flight states produce precise run-now blockers", () => {
  const pausedSchedule = {
      ...armedSchedule,
      state: "paused" as const,
    },
    singleFlight = {
      ...armedSchedule,
      status: {
        ...armedSchedule.status,
        activeRun: {
          occurrenceId: "occurrence_single",
          kind: "scheduled" as const,
          scheduledFor: now,
          claimedAt: now,
          nodeId: "edge-two",
          assignmentId: null,
          claimFence: "claim_fence",
          attemptIndex: 0,
        },
      },
    };
  const paused = readSchedulesGui(
    guiContext({
      projection: {
        listEntities: () => [{ value: pausedSchedule, workspaceRevision: 1 }],
        readTaskStatuses: guiContext().projection.readTaskStatuses,
      },
    }),
  );
  assert.equal(paused.schedules[0]!.state, "paused");
  assert.equal(paused.schedules[0]!.nextRunAt, null);
  assert.equal(paused.schedules[0]!.actions.runNow.code, "schedule_paused");
  assert.equal(paused.schedules[0]!.actions.enable.available, true);
  const claimed = readSchedulesGui(
    guiContext({
      mode: "remote-edge",
      rootDir: unusedEdgeRoot(),
      fleetRoster: null,
      projection: {
        listEntities: () => [{ value: singleFlight, workspaceRevision: 1 }],
        readTaskStatuses: guiContext().projection.readTaskStatuses,
      },
    }),
  );
  assert.equal(claimed.schedules[0]!.executionAvailability, "claimed-elsewhere");
  assert.equal(claimed.schedules[0]!.actions.runNow.code, "schedule_single_flight_active");
  assert.match(String(claimed.schedules[0]!.actions.runNow.nextAction), /occurrence_single/u);
});

test("the schedules list schema is registry-closed with a negative fixture", () => {
  const entry = daemonGuiReadSchemas.find(({ id }) => id === DAEMON_SCHEDULES_LIST_SCHEMA.id);
  assert.ok(entry, "the schedules list schema must be registered");
  assert.deepEqual(entry.negativeFixtures, ["packages/daemon/fixtures/contracts/daemon-schedules-list-invalid.json"]);
  assert.notDeepEqual(
    validateSchedulesList(
      JSON.parse(
        '{"ok":true,"status":"ready","repoId":"r","repoMode":"local","viewerNodeId":"local","assignmentResolution":"roster","schedules":[],"watermark":0,"sourceRevision":0,"schema":"daemon.schedules-list/v1"}',
      ),
    ),
    [],
  );
});

function unusedEdgeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedules-unused-"));
  mkdirSync(root, { recursive: true });
  return root;
}
