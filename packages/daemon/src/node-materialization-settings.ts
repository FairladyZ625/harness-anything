import { statSync } from "node:fs";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { nodeMaterializationPolicyForMode } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import type { RepoCellOpenInput } from "./repo-cell-types.ts";
import { readLocalState } from "./repo-cell-settings-state.ts";

/** One live configuration shared by the store and read projections, including independent readers. */
export function nodeMaterializationStorage(
  input: Pick<RepoCellOpenInput, "rootDir" | "mode" | "storage">,
): NonNullable<RepoCellOpenInput["storage"]> {
  const fallback = nodeMaterializationPolicyForMode(input.mode, input.storage?.nodeTaskMaterializationPolicy),
    localPath = resolveHarnessLayout(input.rootDir).settingsLocalPath;
  let cached: { readonly key: string; readonly policy: typeof fallback } | undefined;
  return {
    ...input.storage,
    get nodeTaskMaterializationPolicy() {
      // Independent read workers observe durable replacements without rereading unchanged preferences
      // on every storage operation. ctime also detects in-place edits whose mtime was preserved.
      const stat = statSync(localPath, { bigint: true, throwIfNoEntry: false }),
        key = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "absent";
      if (cached?.key !== key)
        cached = {
          key,
          policy: readLocalState(input.rootDir, fallback, localPath).value.nodeTaskMaterializationPolicy,
        };
      return cached.policy;
    },
  };
}
