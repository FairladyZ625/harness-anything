import type { ModuleRecordV2, TaskCreatePayloadV2 } from "./task-decision-module-command-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { TaskDecisionModuleAuthorityStateV2 } from "./task-decision-module-semantic-compiler-v2.ts";
import { readModuleRegistryV2 } from "./task-decision-module-module-mutations-v2.ts";
import {
  semanticAdmissionV2 as admission,
  verifySemanticPathCasV2
} from "./semantic-authority-helpers-v2.ts";

export interface TaskCreateModuleReadDependencyV2 {
  readonly snapshot: HostedDocumentSnapshotV2;
  readonly publicationRevalidation: () => Promise<void>;
}

interface TaskModuleSelectionV2 {
  readonly key: string;
  readonly title: string;
  readonly scopes: ReadonlyArray<string>;
}

export async function taskCreateModuleReadDependencyV2(
  state: TaskDecisionModuleAuthorityStateV2,
  writes: TaskCreatePayloadV2["writes"]
): Promise<TaskCreateModuleReadDependencyV2 | null> {
  const moduleWrites = writes?.filter((write) => write.path === "module.md") ?? [];
  if (moduleWrites.length > 1) throw admission("MODULE_SELECTION_INVALID");
  const moduleWrite = moduleWrites[0];
  if (!moduleWrite) return null;
  const selection = parseTaskModuleSelection(moduleWrite.body);
  const initial = await requiredRegisteredTaskModule(state, selection);
  return {
    snapshot: initial.snapshot,
    publicationRevalidation: async () => {
      const { registry, snapshot } = await readModuleRegistryV2(state);
      const module = registry.modules.find((entry) => entry.key === selection.key);
      if (!snapshot || !module || module.status === "unregistered") throw admission("MODULE_NOT_FOUND");
      verifySemanticPathCasV2([{
        path: "modules.json",
        expectedEpoch: initial.snapshot.epoch,
        expectedRevision: initial.snapshot.revision,
        expectedBlobDigest: initial.snapshot.blobDigest
      }], [{ path: "modules.json", snapshot }]);
      assertTaskModuleSelection(module, selection);
    }
  };
}

function parseTaskModuleSelection(body: string): TaskModuleSelectionV2 {
  const keys = [...body.matchAll(/^Module key:\s*(.+)$/gmu)].map((match) => match[1]!.trim());
  const titles = [...body.matchAll(/^Module title:\s*(.+)$/gmu)].map((match) => match[1]!.trim());
  const scopeHeading = [...body.matchAll(/^## Scopes\s*$/gmu)];
  if (keys.length !== 1 || titles.length !== 1 || scopeHeading.length !== 1 || !keys[0] || !titles[0]) {
    throw admission("MODULE_SELECTION_INVALID");
  }
  const tail = body.slice(scopeHeading[0]!.index! + scopeHeading[0]![0].length);
  const scopes: string[] = [];
  for (const line of tail.split(/\r?\n/u).slice(1)) {
    if (line.startsWith("- ")) {
      const scope = line.slice(2).trim();
      if (!scope) throw admission("MODULE_SELECTION_INVALID");
      scopes.push(scope);
      continue;
    }
    if (line.trim() === "" && scopes.length === 0) continue;
    break;
  }
  if (new Set(scopes).size !== scopes.length) throw admission("MODULE_SELECTION_INVALID");
  return { key: keys[0], title: titles[0], scopes };
}

async function requiredRegisteredTaskModule(
  state: TaskDecisionModuleAuthorityStateV2,
  selection: TaskModuleSelectionV2
): Promise<{ readonly snapshot: HostedDocumentSnapshotV2 }> {
  const { registry, snapshot } = await readModuleRegistryV2(state);
  const module = registry.modules.find((entry) => entry.key === selection.key);
  if (!snapshot || !module || module.status === "unregistered") throw admission("MODULE_NOT_FOUND");
  assertTaskModuleSelection(module, selection);
  return { snapshot };
}

function assertTaskModuleSelection(
  module: Pick<ModuleRecordV2, "title" | "scopes">,
  selection: TaskModuleSelectionV2
): void {
  if (module.title !== selection.title
    || module.scopes.length !== selection.scopes.length
    || module.scopes.some((scope, index) => scope !== selection.scopes[index])) {
    throw admission("MODULE_SELECTION_MISMATCH");
  }
}
