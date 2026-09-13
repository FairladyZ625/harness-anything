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
] as const);

/** 任务收口的 GUI 写入 ingress:与 `ha task complete` 同一个 fleet `task-complete` 动作。放在这里
 * 而不是注册表文件,沿用 43aa1a51e9 的做法,让 `daemon-protocol-gui-actions.ts` 维持在 G0-5 基线内。 */
export const taskCompletionGuiActions = Object.freeze([
  // Pure passthrough of the fleet `task-complete` action: consent=false asks the center to
  // dispatch the independent reviewer, consent=true records the one human consent. The GUI
  // adds no verdict, CI, or business judgment of its own.
  guiAction(
    "task.complete",
    "repo.task.complete",
    "task-complete",
    shape({ taskId: "string", executionId: "string?", consent: "boolean?" }),
    "completeTask",
    "/api/tasks/:taskId/complete",
    "repo-write",
  ),
]);
