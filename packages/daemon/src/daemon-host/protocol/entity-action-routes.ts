import { generatedTaskActionProtocolDeclarations } from "@harness-anything/preset/internal/preset-command-contract";
import { actionRpc, optionalEnum, type RpcShape, shape } from "./daemon-protocol-results.ts";

/** GUI 的实体写入面。三条动作都只是既有 center 单写路的命名 ingress:声明实体走
 * generic entity store,artifact 实体走 `ha entity import` 的同一条路与同一个 revision
 * fence。放在这里是因为 `daemon-protocol-action-routes.ts` 只持有注册表本身,按实体域拆分
 * 让它维持在 G0-5 的 shrink-only 基线内。 */

/**
 * 声明实体的新建入口(task_0df76ed3fb Goal 4):复用 CLI `ha entity import` 的同一个
 * center 单写路与 entity revision fence,不新造第二条写路。GUI 只递 kind/locator/title,
 * relink 语义的 entityId/sourceIdentity 不开放给渲染层。
 */
export const entityImportRoutes = Object.freeze([
  actionRpc(
    "vertical.kind.upsert",
    "repo.vertical.kind.upsert",
    "vertical-kind-upsert",
    shape({ kindId: "string", declaration: "json", expectedVersion: "number?" }),
  ),
  actionRpc(
    "vertical.kind.publishSchema",
    "repo.vertical.kind.publishSchema",
    "vertical-kind-publish-schema",
    shape({ kindId: "string", attributes: "json", expectedVersion: "number?" }),
  ),
  actionRpc(
    "vertical.kind.retire",
    "repo.vertical.kind.retire",
    "vertical-kind-retire",
    shape({ kindId: "string", expectedVersion: "number?", reason: "string" }),
  ),
  actionRpc(
    "entity.import",
    "repo.entity.import",
    "entity-import",
    shape({
      entityKind: "string",
      locator: "string",
      locatorKind: "string?",
      mode: "string",
      expectedVersion: "number",
      contentVersion: "string?",
      title: "string?",
      attributes: "json?",
    }),
  ),
  actionRpc(
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
  ),
  actionRpc(
    "entity.archive",
    "repo.entity.archive",
    "entity-archive",
    shape({ entityKind: "string", entityId: "string", expectedVersion: "number", reason: "string" }),
  ),
  // Archive keeps the descriptor and its files; delete retires both. Both already exist as one
  // center action apiece, so the GUI names the second one too rather than making archive mean both.
  actionRpc(
    "entity.delete",
    "repo.entity.delete",
    "entity-delete",
    shape({ entityKind: "string", entityId: "string", expectedVersion: "number", reason: "string" }),
  ),
  // 置顶区的实体级取消置顶(task_9ba495de):与 repo.task.unpin 同一条 entity-unpin 写路
  // (runEntityPinAction),GUI 只递 entityRef;非任务实体的 pin 仍走 CLI `ha pin <ref>`。
  actionRpc("entity.unpin", "repo.entity.unpin", "entity-unpin", shape({ entityRef: "string" })),
] as const);

/** Agent/Squad 声明文档的写入面;两者共用 generic entity store 的同一条写路。 */
export const entityDeclarationRoutes = Object.freeze([
  actionRpc(
    "agent.entity.write",
    "repo.agent.entity.write",
    "agent-install",
    // The install action already owns the revision fence; this ingress only has to hand it the
    // revision the editor read. Optional because the same facet also serves a first create, which
    // sends expectedVersion 0; an omitted value keeps the pre-fence behavior for callers that do
    // not hold a revision.
    shape({ declaration: "json", expectedVersion: "number?", reactivate: "boolean?", reason: "string?" }),
  ),
  actionRpc("squad.entity.write", "repo.squad.entity.write", "squad-install", shape({ declaration: "json" })),
  // The U/D of the GUI entity CRUD: named ingresses onto the same agent-retire / agent-restore /
  // agent-delete / squad-delete actions the CLI uses, so lifecycle and deletion validation stays
  // in the one daemon executor.
  actionRpc(
    "agent.entity.retire",
    "repo.agent.entity.retire",
    "agent-retire",
    shape({ agentId: "string", reason: "string", successor: "string?" }),
  ),
  actionRpc(
    "agent.entity.restore",
    "repo.agent.entity.restore",
    "agent-restore",
    shape({ agentId: "string", reason: "string", expectedVersion: "number?" }),
  ),
  actionRpc(
    "agent.entity.delete",
    "repo.agent.entity.delete",
    "agent-delete",
    shape({ agentId: "string", reason: "string", expectedVersion: "number" }),
  ),
  actionRpc(
    "squad.entity.delete",
    "repo.squad.entity.delete",
    "squad-delete",
    shape({ squadId: "string", reason: "string", expectedVersion: "number" }),
  ),
] as const);

/** 任务收口的 GUI 写入 ingress:与 `ha task complete` 同一个 fleet `task-complete` 动作。放在这里
 * 而不是注册表文件,沿用 43aa1a51e9 的做法,让 `daemon-protocol-action-routes.ts` 维持在 G0-5 基线内。 */
export const taskCompletionRoutes = Object.freeze([
  // dec_9C43012EBB2754D7112F618F0D / dec_13B7B846B56BFA192533011B91:
  // named GUI ingresses only; admission and persistence remain in the canonical actions.
  actionRpc("task.archive", "repo.task.archive", "task-archive", shape({ taskIds: "array", reason: "string" })),
  actionRpc(
    "agentRuntime.incidentDismiss",
    "repo.agentRuntime.incidentDismiss",
    "runtime-incident-dismiss",
    shape({ dispatchId: "string", reason: "string" }),
  ),
  actionRpc(
    "task.escalationResolve",
    "repo.task.escalationResolve",
    "task-escalation-resolve",
    shape({ taskId: "string", dispatchId: "string", answer: "string" }),
  ),
  // Pure passthrough of the fleet `task-complete` action: completion is mechanical — the
  // review verdict and the owner's consent are separate explicit actions, never complete flags.
  actionRpc(
    "task.complete",
    "repo.task.complete",
    "task-complete",
    shape({ taskId: "string", executionId: "string?" }),
  ),
  // The owner's verdict accept onto the same `task-review-consent` action as the CLI. The
  // execution is a stated id (the reviewed cut's own execution), never an inferred one.
  actionRpc(
    "task.consent",
    "repo.task.consent",
    "task-review-consent",
    shape({ taskId: "string", executionId: "string", reviewId: "string" }),
  ),
  // Named ingress onto the same `task-attest` action as `ha task attest`: the closed payload mirrors the
  // CLI inputs, and mode/rationale/human-principal admission stays in the one daemon handler.
  actionRpc(
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
  ),
]);

// CLI task-rework runs through repo.task.run; it has no dedicated preset RPC method. The GUI
// alias consumes that Action's generated input fields, then uses the same task-rework ingress.
const reworkInput = generatedTaskActionProtocolDeclarations.find((action) => action.id === "rework")!.input;
const reworkFields = Object.fromEntries(
  reworkInput.fields.map((field) => {
    const scalar = field.type === "boolean" ? "boolean" : field.type === "number" ? "number" : "string";
    return [field.field, field.enum ? optionalEnum(field.enum) : `${scalar}${field.required ? "" : "?"}`];
  }),
) as RpcShape["fields"];

export const taskReworkRoutes = Object.freeze([
  actionRpc("task.materialize", "repo.task.materialize", "doc-materialize", shape({ taskId: "string" })),
  actionRpc("task.show", "repo.task.show", "task-show", shape({ taskId: "string" }), { read: true }),
  actionRpc("task.rework", "repo.task.rework", "task-rework", shape(reworkFields)),
] as const);
