import { nodeMaterializationPolicyForMode } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { readLocalState } from "./repo-cell-settings-state.ts";

/** One live configuration shared by the store and read projections, including independent readers. */
export function nodeMaterializationStorage(
  input: Pick<RepoCellOpenInput, "rootDir" | "mode" | "storage">,
): NonNullable<RepoCellOpenInput["storage"]> {
  const fallback = nodeMaterializationPolicyForMode(input.mode, input.storage?.nodeTaskMaterializationPolicy);
  return {
    ...input.storage,
    get nodeTaskMaterializationPolicy() {
      return readLocalState(input.rootDir, fallback).value.nodeTaskMaterializationPolicy;
    },
  };
}
