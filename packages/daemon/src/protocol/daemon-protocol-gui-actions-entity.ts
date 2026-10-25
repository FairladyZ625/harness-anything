import { shape } from "./daemon-protocol-gui-types.ts";
import { DAEMON_GUI_COMMAND_RECEIPT_SCHEMA, guiAction, guiS3Action } from "./daemon-protocol-schema-ids.ts";

/** GUI 的实体写入面。三条动作都只是既有 center 单写路的命名 ingress:声明实体走
 * generic entity store,artifact 实体走 `ha entity import` 的同一条路与同一个 revision
 * fence。放在这里是因为 `daemon-protocol-gui-actions.ts` 只持有注册表本身,按实体域拆分
 * 让它维持在 G0-5 的 shrink-only 基线内。 */

/**
 * 声明实体的新建入口(task_0df76ed3fb Goal 4):复用 CLI `ha entity import` 的同一个
 * center 单写路与 entity revision fence,不新造第二条写路。GUI 只递 kind/locator/title,
 * relink 语义的 entityId/sourceIdentity 不开放给渲染层。
 */
export const entityImportGuiActions = Object.freeze([
  guiAction(
    "vertical.kind.upsert",
    "repo.vertical.kind.upsert",
    "vertical-kind-upsert",
    shape({ kindId: "string", declaration: "json", expectedVersion: "number?" }),
    "upsertVerticalKind",
    "/api/vertical/kinds/upsert",
    "repo-write",
  ),
  guiAction(
    "vertical.kind.publishSchema",
    "repo.vertical.kind.publishSchema",
    "vertical-kind-publish-schema",
    shape({ kindId: "string", attributes: "json", expectedVersion: "number?" }),
    "publishVerticalKindSchema",
    "/api/vertical/kinds/publish-schema",
    "repo-write",
  ),
  guiAction(
    "vertical.kind.retire",
    "repo.vertical.kind.retire",
    "vertical-kind-retire",
    shape({ kindId: "string", expectedVersion: "number?", reason: "string" }),
    "retireVerticalKind",
    "/api/vertical/kinds/retire",
    "repo-write",
  ),
  guiAction(
    "entity.import",
    "repo.entity.import",
    "entity-import",
    shape({
      entityKind: "string",
      locator: "string",
      expectedVersion: "number",
      title: "string?",
      attributes: "json?",
    }),
    "importEntity",
    "/api/entities/import",
    "repo-write",
  ),
  guiAction(
    "entity.update",
    "repo.entity.update",
    "entity-update",
    shape({
      entityKind: "string",
      entityId: "string",
      expectedVersion: "number",
      title: "string?",
      locator: "string?",
      contentVersion: "string?",
      attributes: "json?",
    }),
    "updateEntity",
    "/api/entities/update",
    "repo-write",
  ),
  guiAction(
    "entity.archive",
    "repo.entity.archive",
    "entity-archive",
    shape({ entityKind: "string", entityId: "string", expectedVersion: "number", reason: "string" }),
    "archiveEntity",
    "/api/entities/archive",
    "repo-write",
  ),
  // Archive keeps the descriptor and its files; delete retires both. Both already exist as one
  // center action apiece, so the GUI names the second one too rather than making archive mean both.
  guiAction(
    "entity.delete",
    "repo.entity.delete",
    "entity-delete",
    shape({ entityKind: "string", entityId: "string", expectedVersion: "number", reason: "string" }),
    "deleteEntity",
    "/api/entities/delete",
    "repo-write",
  ),
  // 置顶区的实体级取消置顶(task_9ba495de):与 repo.task.unpin 同一条 entity-unpin 写路
  // (runEntityPinAction),GUI 只递 entityRef;非任务实体的 pin 仍走 CLI `ha pin <ref>`。
  guiAction(
    "entity.unpin",
    "repo.entity.unpin",
    "entity-unpin",
    shape({ entityRef: "string" }),
    "unpinEntity",
    "/api/entities/unpin",
    "repo-write",
  ),
] as const);

/** Agent/Squad 声明文档的写入面;两者共用 generic entity store 的同一条写路。 */
export const entityDeclarationGuiActions = Object.freeze([
  guiS3Action(
    "agent.entity.write",
    "repo.agent.entity.write",
    "agent-install",
    shape({ declaration: "json" }),
    "saveAgent",
    "/api/agents",
    "repo-write",
    DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  ),
  guiS3Action(
    "squad.entity.write",
    "repo.squad.entity.write",
    "squad-install",
    shape({ declaration: "json" }),
    "saveSquad",
    "/api/squads",
    "repo-write",
    DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  ),
  // The U/D of the GUI entity CRUD: named ingresses onto the same agent-retire / agent-delete /
  // squad-delete actions the CLI uses, so retirement and deletion validation (system-bundled
  // closure, the entity revision fence, agent_referenced) stays in the one daemon executor.
  guiS3Action(
    "agent.entity.retire",
    "repo.agent.entity.retire",
    "agent-retire",
    shape({ agentId: "string", reason: "string", successor: "string?" }),
    "retireAgent",
    "/api/agents/:agentId/retire",
    "repo-write",
    DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  ),
  guiS3Action(
    "agent.entity.delete",
    "repo.agent.entity.delete",
    "agent-delete",
    shape({ agentId: "string", reason: "string", expectedVersion: "number" }),
    "deleteAgent",
    "/api/agents/:agentId",
    "repo-write",
    DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  ),
  guiS3Action(
    "squad.entity.delete",
    "repo.squad.entity.delete",
    "squad-delete",
    shape({ squadId: "string", reason: "string", expectedVersion: "number" }),
    "deleteSquad",
    "/api/squads/:squadId",
    "repo-write",
    DAEMON_GUI_COMMAND_RECEIPT_SCHEMA.id,
  ),
] as const);

/** 任务收口的 GUI 写入 ingress:与 `ha task complete` 同一个 fleet `task-complete` 动作。放在这里
 * 而不是注册表文件,沿用 43aa1a51e9 的做法,让 `daemon-protocol-gui-actions.ts` 维持在 G0-5 基线内。 */
export const taskCompletionGuiActions = Object.freeze([
  // Pure passthrough of the fleet `task-complete` action: completion is mechanical — the
  // review verdict and the owner's consent are separate explicit actions, never complete flags.
  guiAction(
    "task.complete",
    "repo.task.complete",
    "task-complete",
    shape({ taskId: "string", executionId: "string?" }),
    "completeTask",
    "/api/tasks/:taskId/complete",
    "repo-write",
  ),
  // The owner's verdict accept onto the same `task-review-consent` action as the CLI. The
  // execution is a stated id (the reviewed cut's own execution), never an inferred one.
  guiAction(
    "task.consent",
    "repo.task.consent",
    "task-review-consent",
    shape({ taskId: "string", executionId: "string", reviewId: "string" }),
    "consentReview",
    "/api/tasks/:taskId/consent",
    "repo-write",
  ),
  // Named ingress onto the same `task-attest` action as `ha task attest`: the closed payload mirrors the
  // CLI inputs, and mode/rationale/human-principal admission stays in the one daemon handler.
  guiAction(
    "task.attest",
    "repo.task.attest",
    "task-attest",
    shape({
      taskId: "string",
      gateId: "string",
      result: "string",
      mode: "string?",
      note: "string?",
      rationale: "string?",
    }),
    "taskAttest",
    "/api/tasks/:taskId/attest",
    "repo-write",
  ),
]);
