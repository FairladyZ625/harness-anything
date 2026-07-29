import { readFileSync } from "node:fs";
import { readFrontmatter, readScalar, taskDocumentPath } from "@harness-anything/kernel";
import type { CommandRunnerContext } from "../cli/runner-registry.ts";

export interface TaskLineageMetadata {
  readonly parent?: string;
  readonly taskClass?: TaskLineageClass;
}

type TaskLineageClass = "milestone" | "epic";

export function readTaskLineageMetadata(
  context: Pick<CommandRunnerContext, "layoutInput">,
  taskId: string
): TaskLineageMetadata | null {
  try {
    const frontmatter = readFrontmatter(
      readFileSync(taskDocumentPath(context.layoutInput, taskId, "INDEX.md"), "utf8")
    );
    if (!frontmatter) return null;
    const parent = readScalar(frontmatter, "parent");
    const explicitTaskClass = taskLineageClass(readScalar(frontmatter, "taskClass"));
    const taskClass = explicitTaskClass ?? taskClassSetByPreset(readScalar(frontmatter, "preset"));
    return {
      ...(parent ? { parent } : {}),
      ...(taskClass ? { taskClass } : {})
    };
  } catch {
    return null;
  }
}

// Preset-boundary translation for new packages, and the single compatibility
// fallback for packages created before presets materialized taskClass. The core
// gate only consumes the resulting taskClass value.
export function taskClassSetByPreset(presetId: string): TaskLineageClass | undefined {
  if (presetId === "create-milestone") return "milestone";
  if (presetId === "long-running-task") return "epic";
  return undefined;
}

function taskLineageClass(value: string): TaskLineageClass | undefined {
  return value === "milestone" || value === "epic" ? value : undefined;
}
