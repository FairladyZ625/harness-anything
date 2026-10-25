import { isJsonObject } from "./json-rpc-types.ts";
import { validationError } from "./daemon-protocol-validate-entities.ts";

const TASK_ID = /^[A-Za-z0-9_-]{1,96}$/u;

export function validateDaemonWorkTopologyPayload(value: unknown): string[] {
  if (!isJsonObject(value) || Object.keys(value).length !== 1 || typeof value.workRootTaskId !== "string")
    return ["work topology requires only workRootTaskId"];
  return TASK_ID.test(value.workRootTaskId) ? [] : ["work topology workRootTaskId is invalid"];
}

/** Kept in this narrow contract module so renderer clients do not pull daemon GUI services in. */
export function validateDaemonWorkTopology(value: unknown): readonly string[] {
  const fail = () => validationError("work-topology", "result", value, "must be a valid work topology read");
  if (!isJsonObject(value)) return [validationError("work-topology", "result", value, "must be an object")];
  const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string"),
    statuses = ["planned", "active", "submitted", "blocked", "in_review", "done", "cancelled"],
    topologyStates = ["done", "cancelled", "in-flight", "awaiting-ruling", "blocked", "ready", "unknown", "boundary"],
    blocker = (item: unknown) =>
      isJsonObject(item) &&
      typeof item.relationId === "string" &&
      (item.kind === "depends-on"
        ? typeof item.sourceTaskId === "string" &&
          typeof item.targetTaskId === "string" &&
          (item.rationale === undefined || typeof item.rationale === "string")
        : item.kind === "awaits" &&
          typeof item.sourceTaskId === "string" &&
          typeof item.personId === "string" &&
          ["question", "acceptance", "consent", "reopen"].includes(String(item.askKind)) &&
          typeof item.question === "string"),
    node = (item: unknown, boundary: boolean) =>
      isJsonObject(item) &&
      typeof item.taskId === "string" &&
      item.taskId.length > 0 &&
      typeof item.title === "string" &&
      (item.canonicalStatus === null || statuses.includes(String(item.canonicalStatus))) &&
      topologyStates.includes(String(item.topologyState)) &&
      (item.parentTaskId === null || typeof item.parentTaskId === "string") &&
      typeof item.pinned === "boolean" &&
      item.boundary === boundary &&
      Array.isArray(item.blockers) &&
      item.blockers.every(blocker) &&
      strings(item.warnings),
    edge = (item: unknown) =>
      isJsonObject(item) &&
      typeof item.relationId === "string" &&
      typeof item.from === "string" &&
      typeof item.to === "string" &&
      item.kind === "depends-on" &&
      ["directed", "undirected"].includes(String(item.direction)) &&
      typeof item.state === "string" &&
      typeof item.rationale === "string";
  const valid =
    value.schema === "daemon.work-topology/v1" &&
    value.ok === true &&
    (value.status === "ready" || value.status === "pending") &&
    typeof value.workRootTaskId === "string" &&
    value.workRootTaskId.length > 0 &&
    Array.isArray(value.members) &&
    value.members.every((item) => node(item, false)) &&
    Array.isArray(value.boundaryTasks) &&
    value.boundaryTasks.every((item) => node(item, true)) &&
    Array.isArray(value.edges) &&
    value.edges.every(edge) &&
    strings(value.frontier) &&
    (value.criticalPath === null || strings(value.criticalPath)) &&
    (value.completeness === "complete" || value.completeness === "partial") &&
    strings(value.warnings) &&
    Number.isSafeInteger(value.watermark) &&
    Number.isSafeInteger(value.sourceRevision);
  return valid ? [] : [fail()];
}
