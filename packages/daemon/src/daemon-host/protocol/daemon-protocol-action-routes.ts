import {
  generatedSettingsFieldProtocolProjection,
  presetMethods,
  type GeneratedSettingsActionInputField,
} from "@harness-anything/preset/internal/preset-command-contract";
import { actionRpc, optionalEnum, shape, type RpcShape } from "./daemon-protocol-results.ts";
import { decisionProviderVendorWords } from "./daemon-protocol-vocabulary.ts";
import { daemonReadRoutes } from "./daemon-protocol-read-routes.ts";
import { todoActionRoutes } from "./todo-action-routes.ts";
import { entityDeclarationRoutes, entityImportRoutes } from "./entity-action-routes.ts";
import { taskCompletionRoutes, taskReworkRoutes } from "./entity-action-routes.ts";
import {
  DAEMON_CONTROL_RECEIPT_SCHEMA,
  TERMINAL_CONTROL_RECEIPT_SCHEMA,
  TERMINAL_DETACH_ACK_SCHEMA,
  TERMINAL_INPUT_ACK_SCHEMA,
} from "./daemon-protocol-schema-ids.ts";

const settingsUpdateRpcFields = Object.fromEntries(
  generatedSettingsFieldProtocolProjection.actionInputs.map((field) => [field.field, settingsActionRpcRule(field)]),
) as RpcShape["fields"];

const taskCreate = presetMethods.find(({ method }) => method === "repo.task.create");
if (!taskCreate) throw new Error("Missing task-create RPC declaration.");

function settingsActionRpcRule(field: GeneratedSettingsActionInputField): RpcShape["fields"][string] {
  if (field.field === "idempotencyKey") return "string";
  if (field.enum) return optionalEnum(field.enum);
  switch (field.type) {
    case "number":
      return "number?";
    case "boolean":
      return "boolean?";
    case "string-array":
    case "fact-hold-array":
    case "json-object-array":
      return "array?";
    case "json-object":
      return "json?";
    default:
      return "string?";
  }
}

export const daemonActionRoutes = Object.freeze([
  {
    id: "ceo-config",
    hostAuthority: "own-session",
    phase: "ResidentCeo",
    method: "repo.residentCeo.config",
    actionKind: "ceo-config",
    requiresRepo: true,
    commandClass: "admin",
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ runtimeInstanceId: "string", model: "string", heartbeatIntervalSec: "number" }),
    }),
  },
  {
    id: "ceo-start",
    hostAuthority: "own-session",
    phase: "ResidentCeo",
    method: "repo.residentCeo.start",
    actionKind: "ceo-start",
    requiresRepo: true,
    commandClass: "admin",
    params: shape({ repo: shape({ repoId: "string" }), payload: shape({}) }),
  },
  {
    id: "ceo-stop",
    hostAuthority: "own-session",
    phase: "ResidentCeo",
    method: "repo.residentCeo.stop",
    actionKind: "ceo-stop",
    requiresRepo: true,
    commandClass: "admin",
    params: shape({ repo: shape({ repoId: "string" }), payload: shape({}) }),
  },
  {
    id: "ceo-status",
    hostAuthority: "own-session",
    phase: "ResidentCeo",
    method: "repo.residentCeo.status",
    actionKind: "ceo-status",
    requiresRepo: true,
    commandClass: "repo-read",
    params: shape({ repo: shape({ repoId: "string" }), payload: shape({}) }),
  },
  {
    id: "ceo-chat",
    hostAuthority: "own-session",
    phase: "ResidentCeo",
    method: "repo.residentCeo.chat",
    actionKind: "ceo-chat",
    requiresRepo: true,
    commandClass: "admin",
    params: shape({ repo: shape({ repoId: "string" }), payload: shape({ message: "string" }) }),
  },
  actionRpc(
    "agentRuntime.handoff",
    "repo.agentRuntime.handoff",
    "runtime-handoff-claim",
    shape({
      operation: "string",
      dispatchId: "string",
      runtimeInstanceId: "string?",
      prompt: "string?",
      dispatchKey: "string?",
    }),
  ),
  {
    id: "gui.control.request",
    phase: "W5-GUI-S3",
    method: "daemon.gui.control.request",
    actionKind: "daemon-control-request",
    requiresRepo: false,
    params: shape({
      payload: shape({
        kind: "string",
        authorityRepoId: "string",
        reason: "string?",
      }),
    }),
    commandClass: "admin",
    outputSchemaId: DAEMON_CONTROL_RECEIPT_SCHEMA.id,
  },
  { ...taskCreate, method: "repo.task.create", actionKind: "task-create" },
  ...taskReworkRoutes,
  actionRpc("task.start", "repo.task.start", "task-start", shape({ taskId: "string", executionId: "string" })),
  actionRpc(
    "task.progress.append",
    "repo.task.progress.append",
    "task-progress-append",
    shape({
      taskId: "string",
      executionId: "string?",
      text: "string",
      evidence: "array?",
      baseDocumentSha256: "string-null?",
      asOwner: "boolean?",
    }),
  ),
  actionRpc(
    "task.submit",
    "repo.task.submit",
    "task-submit",
    shape({ taskId: "string", executionId: "string?", amend: "boolean?" }),
  ),
  actionRpc(
    "task.assign",
    "repo.task.assign",
    "task-assign",
    shape({
      taskId: "string",
      expectedVersion: "number",
      personId: "string?",
      nodeId: "string?",
      teamId: "string?",
      expiresAt: "string?",
    }),
  ),
  actionRpc(
    "task.unassign",
    "repo.task.unassign",
    "task-unassign",
    shape({ taskId: "string", expectedVersion: "number" }),
  ),
  ...taskCompletionRoutes,
  // Task buttons are aliases onto the repository-wide Entity Pin write path.
  actionRpc("task.pin", "repo.task.pin", "entity-pin", shape({ taskId: "string" })),
  actionRpc("task.unpin", "repo.task.unpin", "entity-unpin", shape({ taskId: "string" })),
  // 答复 awaits 的 GUI 写通道:与 `ha relation unrelate` 同一条 daemon 动作,答复原文即 retire 理由。
  actionRpc(
    "relation.unrelate",
    "repo.relation.unrelate",
    "relation-unrelate",
    shape({ relationId: "string", reason: "string", expectedVersion: "number" }),
  ),
  actionRpc(
    "decision.list",
    "repo.decision.list",
    "decision-list",
    shape({
      search: "string?",
      legacyId: "string?",
      legacyRange: "json?",
      state: "string?",
      module: "string?",
      productLine: "string?",
      limit: "number?",
      cursor: "string?",
    }),
    { read: true },
  ),
  actionRpc(
    "decision.show",
    "repo.decision.show",
    "decision-show",
    shape({ decisionId: "string", includeBody: "boolean?" }),
    { read: true },
  ),
  actionRpc(
    "decision.propose",
    "repo.decision.propose",
    "decision-propose",
    shape({
      title: "string",
      question: "string",
      riskTier: "string",
      urgency: "string",
      vertical: "string",
      preset: "string",
      appliesTo: "json",
      decisionClass: "string",
      chosen: "array",
      rejected: "array",
      body: "string",
      claims: "array",
      fulfillments: "array",
    }),
  ),
  actionRpc(
    "decision.accept",
    "repo.decision.accept",
    "decision-accept",
    shape({
      decisionId: "string",
      rationale: "string",
      judgmentOnlyRationale: "string?",
      reviewId: "string?",
      expectedDigest: "string?",
    }),
  ),
  actionRpc(
    "decision.reject",
    "repo.decision.reject",
    "decision-reject",
    shape({ decisionId: "string", reason: "string" }),
  ),
  actionRpc(
    "decision.defer",
    "repo.decision.defer",
    "decision-defer",
    shape({ decisionId: "string", reason: "string" }),
  ),
  // Decision 评审的 GUI 通道:与 `ha decision respond-review / override-review / dispatch-review`
  // 同一条 daemon 动作,授权与切面判据全在中心;报告正文按 reportRef 经 `ha doc show` 同一读。
  actionRpc(
    "decision.respondReview",
    "repo.decision.respondReview",
    "decision-respond-review",
    shape({ decisionId: "string", responses: "array" }),
  ),
  actionRpc(
    "decision.overrideReview",
    "repo.decision.overrideReview",
    "decision-override-review",
    shape({ decisionId: "string", reviewContentDigest: "string", reviewIds: "array", reason: "string" }),
  ),
  actionRpc(
    "decision.dispatchReview",
    "repo.decision.dispatchReview",
    "decision-dispatch-review",
    shape({ decisionId: "string", expectedDigest: "string" }),
  ),
  actionRpc("doc.show", "repo.doc.show", "doc-show", shape({ path: "string" }), { read: true }),
  actionRpc(
    "dossier.synthesize",
    "repo.dossier.synthesize",
    "dossier-synthesize",
    shape({
      slotId: "string",
      expectedWatermark: "number",
      watermark: "number",
      body: "string",
      scheduleId: "string?",
      claimFence: "string?",
      idempotencyKey: "string?",
    }),
  ),
  ...todoActionRoutes,
  ...entityImportRoutes,
  // `waitFor`/`timeoutMs` are the receipt-acceptance predicates the cell already runs
  // (repo-cell-api → waitForReceiptAcceptance); `ha` settles every write through them.
  // Admitting only `opId` here gave the GUI a single follower snapshot taken before the
  // acceptance had been published, so an accepted write could never be observed as visible.
  actionRpc(
    "receipt.show",
    "repo.receipt.show",
    "receipt-show",
    shape({ opId: "string", waitFor: "array?", timeoutMs: "number?" }),
    { read: true },
  ),
  actionRpc("settings.update", "repo.settings.update", "settings-update", shape(settingsUpdateRpcFields)),
  actionRpc("gui.catalog.reread", "repo.gui.catalog.reread", "catalog-reread", shape({ expectedDigest: "string?" }), {
    read: true,
  }),
  actionRpc(
    "agentRuntime.spawn",
    "repo.agentRuntime.spawn",
    "runtime-spawn",
    shape({
      runtimeInstanceId: "string?",
      dispatchId: "string?",
      agentId: "string?",
      targetAgentId: "string?",
      squadId: "string?",
      role: "string?",
      model: "string?",
      effort: "string?",
      fast: "boolean?",
      permissionMode: "string?",
      mcpPolicy: "string?",
      cwd: "json?",
      prompt: "string?",
      promptSource: "string?",
      missionName: "string?",
      onExitCommand: "string?",
      taskId: "string-null?",
      handoffEnabled: "boolean?",
      dispatchKey: "string",
      providerSessionId: "string?",
      expectedAgentDeclarationDigest: "string?",
      expectedSkillSnapshotDigest: "string?",
      // Fenced recovery of a stopped implementation dispatch: { dispatchId, executionId, expectedVersion? }.
      recovery: "json?",
      // Reviewer dispatches carry the canonical decision/task binding through the
      // same payload that runtime-spawn consumes.
      reviewTarget: "json?",
      executor: "json?",
      dryRun: "boolean?",
    }),
  ),
  ...entityDeclarationRoutes,
  actionRpc(
    "schedule.create",
    "repo.schedule.create",
    "schedule-create",
    shape({
      scheduleId: "string",
      name: "string",
      mode: "string",
      everyMs: "number?",
      cronExpression: "string?",
      timezone: "string?",
      agentId: "string",
      mission: "string",
      reasoningEffort: "string?",
      fast: "boolean?",
      idempotencyKey: "string",
    }),
  ),
  actionRpc(
    "schedule.update",
    "repo.schedule.update",
    "schedule-update",
    shape({
      scheduleId: "string",
      // Every definition field is optional: an agent Schedule keeps its unmentioned target
      // fields, and a built-in Schedule edit sends only trigger/retention fields.
      name: "string?",
      mode: "string?",
      everyMs: "number?",
      cronExpression: "string?",
      timezone: "string?",
      agentId: "string?",
      mission: "string?",
      reasoningEffort: "string-null?",
      fast: "boolean?",
      keepDays: "number?",
      keepMonthly: "boolean?",
      idempotencyKey: "string",
    }),
  ),
  actionRpc(
    "schedule.delete",
    "repo.schedule.delete",
    "schedule-delete",
    shape({ scheduleId: "string", reason: "string?", idempotencyKey: "string" }),
  ),
  actionRpc(
    "schedule.enable",
    "repo.schedule.enable",
    "schedule-enable",
    shape({ scheduleId: "string", idempotencyKey: "string" }),
  ),
  actionRpc(
    "schedule.disable",
    "repo.schedule.disable",
    "schedule-disable",
    shape({ scheduleId: "string", idempotencyKey: "string" }),
  ),
  actionRpc(
    "schedule.runNow",
    "repo.schedule.runNow",
    "schedule-run-now",
    shape({ scheduleId: "string", idempotencyKey: "string" }),
  ),
  actionRpc(
    "agentRuntime.cancel",
    "repo.agentRuntime.cancel",
    "runtime-cancel",
    shape({ runtimeSessionId: "string", ruling: "string?", reason: "string?", idempotencyKey: "string?" }),
  ),
  actionRpc(
    "agentRuntime.steer",
    "repo.agentRuntime.steer",
    "runtime-steer",
    shape({
      runtimeSessionId: "string?",
      dispatchId: "string?",
      prompt: "string",
      expected: "json?",
      idempotencyKey: "string?",
    }),
  ),
  actionRpc(
    "terminal.spawn",
    "repo.terminal.spawn",
    "terminal-spawn",
    shape({
      idempotencyKey: "string",
      backend: "string",
      name: "string?",
      cwd: "json",
      shellProfileId: "string?",
      taskId: "string?",
    }),
    { outputSchemaId: TERMINAL_CONTROL_RECEIPT_SCHEMA.id },
  ),
  actionRpc(
    "terminal.input",
    "repo.terminal.input",
    "terminal-input",
    shape({ sessionId: "string", daemonGeneration: "number", clientSeq: "number", utf8: "string" }),
    { outputSchemaId: TERMINAL_INPUT_ACK_SCHEMA.id },
  ),
  actionRpc(
    "terminal.resize",
    "repo.terminal.resize",
    "terminal-resize",
    shape({ sessionId: "string", cols: "number", rows: "number" }),
    { outputSchemaId: TERMINAL_CONTROL_RECEIPT_SCHEMA.id },
  ),
  actionRpc(
    "terminal.detach",
    "repo.terminal.detach",
    "terminal-detach",
    shape({ sessionId: "string", attachmentId: "string" }),
    { read: true, outputSchemaId: TERMINAL_DETACH_ACK_SCHEMA.id },
  ),
  actionRpc(
    "terminal.terminate",
    "repo.terminal.terminate",
    "terminal-terminate",
    shape({ sessionId: "string", confirmed: "boolean?" }),
    { outputSchemaId: TERMINAL_CONTROL_RECEIPT_SCHEMA.id },
  ),
] as const);
export const daemonStreamFacets = Object.freeze([
  {
    id: "agentRuntime.attach",
    phase: "Runtime-B",
    method: "repo.agentRuntime.attach",
    eventMethod: "repo.agentRuntime.attach.frame",
    commandClass: "repo-read",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ runtimeSessionId: "string", afterCursor: "json?" }),
    }),
  },
  {
    id: "terminal.attach",
    phase: "W5-GUI-S3",
    method: "repo.terminal.attach",
    eventMethod: "repo.terminal.attach.frame",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ sessionId: "string", afterSeq: "number", daemonGeneration: "number?" }),
    }),
    commandClass: "repo-read",
  },
] as const);

export const daemonStreamFacetByMethod: ReadonlyMap<string, (typeof daemonStreamFacets)[number]> = new Map(
  daemonStreamFacets.map((facet) => [facet.method, facet] as const),
);
export const runtimeInstanceMethods = Object.freeze([
  {
    id: "repo.agentRuntime.batch",
    phase: "Runtime-B",
    method: "repo.agentRuntime.batch",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ declaration: "string", executor: "json?" }),
    }),
  },
  {
    id: "repo.agentRuntime.sessions.await",
    phase: "Runtime-B",
    method: "repo.agentRuntime.sessions.await",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({
        runtimeSessionIds: "array?",
        taskIds: "array?",
        mode: optionalEnum(["any", "all"] as const),
      }),
    }),
  },
  {
    id: "daemon.runtimeInstance.create",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.create",
    requiresRepo: false,
    params: shape({
      repo: "json?",
      payload: shape(
        {
          instanceId: "string",
          name: "string",
          kindId: "string",
          installationId: "string?",
          providerId: "string",
          models: "array",
          enabled: "boolean?",
          defaultModel: "string?",
          permissionMode: "string?",
          mcpPolicy: "string?",
          isolationState: "string?",
          tier: "number?",
          credentialSource: optionalEnum(["operator", "instance"] as const),
          authMode: "string",
          credentialRef: "string?",
          apiKey: "string?",
        },
        true,
      ),
    }),
  },
  {
    id: "daemon.runtimeInstance.list",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.list",
    requiresRepo: false,
    params: shape({ repo: "json?", payload: shape({ all: "boolean?", probe: "boolean?" }) }),
  },
  {
    id: "daemon.runtimeInstance.show",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.show",
    requiresRepo: false,
    params: shape({ repo: "json?", payload: shape({ instanceId: "string", probe: "boolean?" }) }),
  },
  {
    id: "daemon.runtimeInstance.update",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.update",
    requiresRepo: false,
    params: shape({
      repo: "json?",
      payload: shape({
        instanceId: "string",
        name: "string?",
        installationId: "string?",
        models: "array?",
        defaultModel: "string?",
        baseUrl: "string-or-empty?",
        effort: "string-or-empty?",
        webSearch: "string-or-empty?",
        permissionMode: "string?",
        mcpPolicy: "string-or-empty?",
        isolationState: "string?",
        tier: "number?",
        credentialSource: optionalEnum(["operator", "instance"] as const),
        fast: "boolean?",
        enabled: "boolean?",
        clearFreeze: "boolean?",
        apiKey: "string?",
      }),
    }),
  },
  {
    id: "daemon.runtimeInstance.delete",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.delete",
    requiresRepo: false,
    params: shape({ repo: "json?", payload: shape({ instanceId: "string" }) }),
  },
] as const);

export const runtimeInstanceAuthMethods = Object.freeze([
  {
    id: "repo.runtimeInstance.auth.login",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.login",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
  },
  {
    id: "repo.runtimeInstance.auth.logout",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.logout",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
  },
] as const);

export const providerMethods = Object.freeze([
  {
    id: "daemon.provider.create",
    phase: "Decision-Provider",
    method: "daemon.provider.create",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({
      payload: shape({
        type: "string",
        vendor: optionalEnum(decisionProviderVendorWords),
        providerId: "string",
        name: "string",
        model: "string",
        baseUrl: "string-or-empty?",
        apiKey: "string?",
        credentialRef: "string?",
        enabled: "boolean?",
        requestTimeoutMs: "number?",
        maxRetries: "number?",
      }),
    }),
  },
  {
    id: "daemon.provider.list",
    phase: "Decision-Provider",
    method: "daemon.provider.list",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({ payload: shape({}) }),
  },
  {
    id: "daemon.provider.show",
    phase: "Decision-Provider",
    method: "daemon.provider.show",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({ payload: shape({ providerId: "string" }) }),
  },
  {
    id: "daemon.provider.update",
    phase: "Decision-Provider",
    method: "daemon.provider.update",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({
      payload: shape({
        providerId: "string",
        vendor: optionalEnum(decisionProviderVendorWords),
        name: "string?",
        model: "string?",
        baseUrl: "string-or-empty?",
        apiKey: "string?",
        credentialRef: "string?",
        enabled: "boolean?",
        requestTimeoutMs: "number?",
        maxRetries: "number?",
      }),
    }),
  },
  {
    id: "daemon.provider.probe",
    phase: "Decision-Provider",
    method: "daemon.provider.probe",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({ payload: shape({ providerId: "string" }) }),
  },
  {
    id: "daemon.provider.delete",
    phase: "Decision-Provider",
    method: "daemon.provider.delete",
    requiresRepo: false,
    commandClass: "admin",
    params: shape({ payload: shape({ providerId: "string" }) }),
  },
] as const);

export const interactiveRpcMethods = Object.freeze([
  ...daemonReadRoutes,
  ...daemonActionRoutes,
  ...runtimeInstanceMethods.filter(({ method }) => method.startsWith("daemon.runtimeInstance.")),
  ...runtimeInstanceAuthMethods,
  ...providerMethods,
]);
