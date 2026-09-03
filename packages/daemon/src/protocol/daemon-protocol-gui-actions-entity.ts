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
    "entity.import",
    "repo.entity.import",
    "entity-import",
    shape({ entityKind: "string", locator: "string", expectedVersion: "number", title: "string?" }),
    "importEntity",
    "/api/entities/import",
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
