// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateDaemonSettingsRead } from "../src/protocol/gui-result-validation.ts";
import {
  daemonProtocolError,
  validateDaemonAgenda,
  validateDaemonDecisionList,
  validateDaemonDocumentRead,
  validateDaemonGuiCommandReceipt,
  validateDaemonProtocolError,
  validateDaemonRelationGraph,
  validateDaemonTaskDispatches,
  validateDaemonTaskDocumentList,
  validateDaemonTaskSnapshotList,
  validateDaemonWorkspaceSummary,
  validateGuiSubmission,
} from "../src/protocol/daemon-protocol.contract.ts";
import {
  validateCatalogActionPayload,
  validateSessionEnvironment,
} from "../src/protocol/daemon-protocol-validate-task.ts";
import { writeReceipt } from "../src/protocol/daemon-protocol-validate-results.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

interface ValidatorCase {
  readonly name: string;
  readonly entityId: string;
  readonly field: string;
  readonly validate: () => readonly string[];
}

test("entity import wire input is exact and projected from its executable Action contract", () => {
  const payload = {
    payload: {
      action: {
        kind: "entity-import",
        entityKind: "software/coding/architecture-decision-record@1",
        locator: "docs/adr.md",
        expectedVersion: 0,
        dryRun: true,
      },
    },
  } as JsonObject;
  assert.deepEqual(validateCatalogActionPayload(payload), []);
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, body: "must not cross the descriptor boundary" } },
    } as JsonObject).join("\n"),
    /action\.body.*not declared/u,
  );
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, expectedVersion: -1 } },
    } as JsonObject).join("\n"),
    /action\.expectedVersion.*must be number/u,
  );
});

test("ADR migration wire input requires its source root and accepts an optional expected count", () => {
  const payload = {
    payload: {
      action: {
        kind: "entity-migrate-adrs",
        registryRevision: `sha256:${"a".repeat(64)}`,
        migrationOpId: "w1e-adr-cutover",
        sourceRoot: "harness/adr",
        expectCount: 30,
        dryRun: true,
      },
    },
  } as JsonObject;
  assert.deepEqual(validateCatalogActionPayload(payload), []);
  assert.match(
    validateCatalogActionPayload({
      payload: {
        action: {
          kind: "entity-migrate-adrs",
          registryRevision: `sha256:${"a".repeat(64)}`,
          migrationOpId: "w1e-adr-cutover",
        },
      },
    } as JsonObject).join("\n"),
    /action\.sourceRoot.*field is required/u,
  );
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, locator: "harness/adr" } },
    } as JsonObject).join("\n"),
    /action\.locator.*not declared/u,
  );
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, expectCount: "30" } },
    } as JsonObject).join("\n"),
    /action\.expectCount.*must be number/u,
  );
});

test("Squad migration wire input is limited to legacy source paths and dry-run", () => {
  const payload = {
    payload: {
      action: {
        kind: "entity-migrate-squads",
        sourcePaths: ["harness/squads/ledger-squad.json"],
        dryRun: true,
      },
    },
  } as JsonObject;
  assert.deepEqual(validateCatalogActionPayload(payload), []);
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, sourcePaths: "harness/squads/ledger-squad.json" } },
    } as JsonObject).join("\n"),
    /action\.sourcePaths.*must be string-array/u,
  );
  assert.match(
    validateCatalogActionPayload({
      payload: { action: { ...payload.payload.action, declaration: {} } },
    } as JsonObject).join("\n"),
    /action\.declaration.*not declared/u,
  );
});

const relationGraph = {
    ok: true,
    status: "ready",
    watermark: 1,
    sourceRevision: 1,
    edges: [{ relationId: "rel-contract", sourceRef: "task/a" }],
    coverageRows: [],
    factAnchors: [],
    facts: [],
    warnings: [],
  },
  agendaTask = {
    taskId: "task-agenda-contract",
    title: "Agenda contract",
    status: "planned",
    pinned: "not-a-boolean",
    updatedAt: "2026-09-02T00:00:00.000Z",
    leaseExecutionId: null,
    activeExecutionIds: [],
    blockingAssessment: { taskId: "task-agenda-contract", state: "clear", blockers: [], warnings: [] },
  },
  agenda = {
    schema: "daemon.agenda/v1",
    ok: true,
    command: "agenda",
    status: "ready",
    inFlight: [agendaTask],
    awaitingDecision: [],
    waitingOnOthers: [],
    dispatchable: [],
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 1,
    sourceRevision: 1,
    warnings: [],
    summary: "one invalid row",
  },
  cases: readonly ValidatorCase[] = [
    {
      name: "validateGuiSubmission",
      entityId: "a".repeat(40),
      field: "completionClaim",
      validate: () =>
        validateGuiSubmission({
          completionClaim: "",
          deliverables: [],
          outputs: [],
          verificationNotes: [],
          knownGaps: [],
          residualRisks: [],
          commitSha: "a".repeat(40),
        }),
    },
    {
      name: "validateCatalogActionPayload",
      entityId: "task-action-contract",
      field: "action.ttlMs",
      validate: () =>
        validateCatalogActionPayload({
          payload: { action: { kind: "task-start", taskId: "task-action-contract", ttlMs: -1 } },
        } as JsonObject),
    },
    {
      name: "validateSessionEnvironment",
      entityId: "agent:session-contract",
      field: "sessionEnvironment.CODEX_THREAD_ID",
      validate: () => validateSessionEnvironment({ HARNESS_ACTOR: "agent:session-contract", CODEX_THREAD_ID: "" }),
    },
    {
      name: "validateDaemonAgenda",
      entityId: "task-agenda-contract",
      field: "inFlight[0]",
      validate: () => validateDaemonAgenda(agenda),
    },
    {
      name: "validateDaemonRelationGraph",
      entityId: "rel-contract",
      field: "edges[0]",
      validate: () => validateDaemonRelationGraph(relationGraph),
    },
    {
      name: "validateDaemonDecisionList",
      entityId: "decision-contract",
      field: "decisions[0]",
      validate: () =>
        validateDaemonDecisionList({
          ok: true,
          projection: "summary",
          decisions: [
            {
              decisionId: "decision-contract",
              title: "Contract decision",
              state: "not-a-state",
              appliesTo: { modules: [], productLines: [] },
            },
          ],
          warnings: [],
        }),
    },
    {
      name: "validateDaemonDocumentRead",
      entityId: "task-document-contract",
      field: "path",
      validate: () =>
        validateDaemonDocumentRead({
          ok: true,
          status: "ready",
          taskId: "task-document-contract",
          path: "",
          body: "body",
          blobSha256: null,
          worktreeBody: null,
          uncommitted: false,
          watermark: 1,
          sourceRevision: 1,
        }),
    },
    {
      name: "validateDaemonTaskDocumentList",
      entityId: "task-documents-contract",
      field: "documents[0]",
      validate: () =>
        validateDaemonTaskDocumentList({
          ok: true,
          status: "ready",
          taskId: "task-documents-contract",
          documents: [
            { path: "/outside", blobSha256: "a".repeat(64), size: 1, mediaType: "text/plain", uncommitted: false },
          ],
          watermark: 1,
          sourceRevision: 1,
        }),
    },
    {
      name: "validateDaemonTaskDispatches",
      entityId: "dispatch-contract",
      field: "dispatches[0]",
      validate: () =>
        validateDaemonTaskDispatches({
          ok: true,
          status: "ready",
          taskId: "task-dispatch-contract",
          dispatches: [{ dispatchId: "dispatch-contract" }],
          watermark: 1,
          sourceRevision: 1,
        }),
    },
    {
      name: "validateDaemonProtocolError",
      entityId: "repo.contract.read",
      field: "error.hint",
      validate: () =>
        validateDaemonProtocolError({
          schema: "command-receipt/v2",
          ok: false,
          command: "repo.contract.read",
          outcome: "op_rejected",
          opId: "N/A",
          origin: "daemon",
          code: "invalid_result",
          evidence: "validation failed",
          error: { code: "invalid_result", hint: "" },
          nextAction: "inspect the response",
        }),
    },
    {
      name: "writeReceipt",
      entityId: "op-contract",
      field: "revision",
      validate: () =>
        writeReceipt({
          outcome: "op_rejected",
          opId: "op-contract",
          revision: -1,
          code: "invalid_result",
          origin: "daemon",
          nextAction: "fix the response",
        }),
    },
    {
      name: "validateDaemonGuiCommandReceipt",
      entityId: "op-gui-contract",
      field: "schema",
      validate: () =>
        validateDaemonGuiCommandReceipt({
          schema: "wrong-schema",
          ok: false,
          command: "task-start",
          outcome: "op_rejected",
          opId: "op-gui-contract",
          code: "invalid_result",
          origin: "daemon",
          nextAction: "fix the response",
        }),
    },
    {
      name: "validateDaemonTaskSnapshotList",
      entityId: "task-snapshot-contract",
      field: "rows[0].packagePath",
      validate: () =>
        validateDaemonTaskSnapshotList({
          ok: true,
          status: "ready",
          rows: [{ taskId: "task-snapshot-contract" }],
          invalidRows: [],
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        }),
    },
    {
      name: "validateDaemonWorkspaceSummary",
      entityId: "workspace",
      field: "tasks.total",
      validate: () =>
        validateDaemonWorkspaceSummary({
          schema: "daemon.workspace-summary/v1",
          ok: true,
          status: "ready",
          tasks: {
            total: -1,
            byStatus: { planned: 0, active: 0, blocked: 0, in_review: 0, done: 0, cancelled: 0, unknown: 0 },
          },
          decisions: {},
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        }),
    },
    {
      name: "validateDaemonSettingsRead",
      entityId: "settings",
      field: "settings",
      validate: () => validateDaemonSettingsRead({ schema: "daemon.settings-read/v1", ok: true, settings: {} }),
    },
  ];

test("every scoped validator reports entity id, field path, and a truncated actual value", () => {
  for (const fixture of cases) {
    const errors = fixture.validate(),
      first = errors[0];
    assert.ok(first, `${fixture.name} must reject its bad row`);
    assert.match(first, /entity=/u, fixture.name);
    assert.ok(first.includes(fixture.entityId), `${fixture.name} must identify ${fixture.entityId}: ${first}`);
    assert.ok(first.includes(`field=${fixture.field}`), `${fixture.name} must identify ${fixture.field}: ${first}`);
    assert.match(first, /actual=/u, fixture.name);
    assert.ok(first.length < 360, `${fixture.name} must truncate its actual value: ${first.length}`);
  }
});

test("task snapshot isolated-row diagnostics require an actual-value summary", () => {
  const errors = validateDaemonTaskSnapshotList({
    ok: true,
    status: "ready",
    rows: [],
    invalidRows: [
      {
        rowIndex: 0,
        taskId: "task-isolated-contract",
        field: "rows[0].snapshot.task",
        message: "Task snapshot field is invalid.",
      },
    ],
    watermark: 1,
    sourceRevision: 1,
    warnings: [],
  });
  assert.match(errors[0]!, /task-isolated-contract.*field=invalidRows\[0\].*actual=/u);
});

test("protocol validation failures preserve entity, field, and actual as structured diagnostics", () => {
  const receipt = daemonProtocolError(
    "repo.task.create",
    "invalid_request",
    "entity=task-a field=status must be planned; actual='weird'",
  );
  assert.deepEqual(receipt.diagnostic, {
    kind: "validation",
    entity: "task-a",
    field: "status",
    expectation: "must be planned",
    actual: "'weird'",
  });
  assert.deepEqual(validateDaemonProtocolError(receipt), []);
});
