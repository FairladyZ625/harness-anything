import path from "node:path";
import {
  isReceiptDiagnostic,
  deriveActionReturnsContract,
  getExecutableEntityAction,
  resolveHarnessLayout,
  type CanonicalEventStore,
  type ReceiptGuidanceArgument,
  type ReceiptGuidanceContractEntry,
  type ReceiptDiagnostic,
} from "../../kernel/src/index.ts";

/** The two layout roots receipt prose needs: where the workspace starts and where the ledger lives. */
export interface WorkspaceLayoutRoots {
  readonly rootDir: string;
  readonly authoredRoot: string;
}

/**
 * Receipt prose shows file locations, so ledger paths (relative to the authored root) must carry
 * the workspace prefix a human can open from the repository root. The prefix comes from the layout
 * the write itself already resolved — the store's last accepted append — so rendering adds no
 * harness.yaml read to a write; a store that has not appended in this process (dry-run previews,
 * replay before any write) resolves the layout now. The prefix never comes from a hardcoded
 * `harness/` in a render template.
 */
export function receiptLayoutRoots(store: CanonicalEventStore, rootDir: string): WorkspaceLayoutRoots {
  return store.lastAppendLayout?.() ?? resolveHarnessLayout(rootDir);
}

export function workspaceRelativePath(roots: WorkspaceLayoutRoots, ledgerPath: string): string {
  const prefix = path.relative(roots.rootDir, roots.authoredRoot).split(path.sep).join("/");
  return `${prefix}/${ledgerPath}`;
}

export function taskCreateGuidance(
  roots: WorkspaceLayoutRoots,
  values: Readonly<Record<string, string | number | boolean>>,
) {
  const action = getExecutableEntityAction("task-create");
  if (!action) throw new Error("task.create has no declared return contract.");
  const returns = deriveActionReturnsContract(action),
    scopedValues =
      typeof values.packagePath === "string"
        ? {
            ...values,
            packagePath: workspaceRelativePath(roots, values.packagePath),
            ledgerPackagePath: values.packagePath,
          }
        : values;
  return Object.freeze(returns.guidance.map((entry) => resolveGuidanceEntry(entry, scopedValues)));
}

export function diagnosticForError(error: unknown): ReceiptDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("diagnostic" in error && isReceiptDiagnostic(error.diagnostic)) return error.diagnostic;
  if (
    "documentPath" in error &&
    typeof error.documentPath === "string" &&
    "diskDiffers" in error &&
    typeof error.diskDiffers === "boolean" &&
    "missingSections" in error &&
    Array.isArray(error.missingSections)
  )
    return {
      kind: "missing-sections",
      documentPath: error.documentPath,
      diskDiffers: error.diskDiffers,
      missingSections: error.missingSections as Extract<
        ReceiptDiagnostic,
        { readonly kind: "missing-sections" }
      >["missingSections"],
    };
  if (
    "field" in error &&
    typeof error.field === "string" &&
    "workspaceRoot" in error &&
    typeof error.workspaceRoot === "string"
  )
    return { kind: "workspace-boundary", field: error.field, workspaceRoot: error.workspaceRoot };
  return undefined;
}

function resolveGuidanceEntry(
  entry: ReceiptGuidanceContractEntry,
  values: Readonly<Record<string, string | number | boolean>>,
): ReceiptGuidanceContractEntry {
  return Object.freeze({
    kind: entry.kind,
    args: Object.freeze(
      Object.fromEntries(Object.entries(entry.args).map(([field, value]) => [field, resolveArgument(value, values)])),
    ),
    ...(entry.when ? { when: entry.when } : {}),
  });
}

function resolveArgument(
  argument: ReceiptGuidanceArgument,
  values: Readonly<Record<string, string | number | boolean>>,
): ReceiptGuidanceArgument {
  if (typeof argument !== "string") return argument;
  return argument.replaceAll(/\{([^{}]+)\}/gu, (_match, field: string) => {
    const value = values[field];
    if (value === undefined) throw new Error(`Receipt guidance placeholder ${field} is not available.`);
    return String(value);
  });
}
