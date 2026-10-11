import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { requiredRuntimeProjection } from "./runtime-spawn-process.ts";
import type { RuntimeSpawnerInput } from "./runtime-spawn-types.ts";

/** A read-only attach reads the frozen round from the repository root — the reviewer dispatch's
 *  working-directory discipline — so its dispatch never checks out or advances the round's worktree.
 *  Resolution failures surface here exactly as they would in spawn: an Agent identity that does not
 *  resolve is a dispatch error, never a quiet read-only classification. */
export function readOnlyAttachDispatch(input: RuntimeSpawnerInput, payload: JsonObject): boolean {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  if (taskId === null || payload.role === "reviewer" || payload.dryRun === true) return false;
  const status = requireCurrentTaskProjection(requiredRuntimeProjection(input), taskId, "runtime.run").snapshot.task
    ?.status;
  if (status !== "submitted" && status !== "in_review") return false;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
  return agentId !== undefined && input.resolveAgent !== undefined
    ? input.resolveAgent(agentId)?.permissionMode === "read-only"
    : false;
}
