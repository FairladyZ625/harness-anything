import { documentPath } from "@harness-anything/kernel";
import { withWorkspaceDocumentPaths } from "./doc-sync-command-actions.ts";
import { directPaths } from "./doc-sync-details.ts";
import { workspacePathOf } from "./doc-sync-settlement.ts";
import {
  acceptEdgeWorktreeScanBases,
  applyFleetMirrorCut,
  fleetMirrorCutFile,
  locateFleetMirrorView,
  scanEdgeTaskWorktrees,
  scanFleetMirrorWorktree,
  type FleetMirrorDirtyFile,
  type FleetMirrorScan,
  type FleetMirrorView,
} from "./fleet-edge-mirror.ts";
import { readFleetRepositoryMetadataClient, runFleetEdgeWrite, runFleetWriteClient } from "./fleet-edge-write.ts";
import type { FleetTaskAction } from "./fleet/command-protocol.ts";

interface FleetEdgeDocSubmitInput {
  readonly payload: {
    readonly viewRoot: string;
    readonly repoId: string;
    readonly nodeId: string;
    readonly executionCredential?: string;
  };
  readonly peer: Parameters<typeof readFleetRepositoryMetadataClient>[0];
  readonly action: FleetTaskAction;
  readonly taskId: string | null;
  readonly workspaceRoot: string;
  readonly waitMs: number;
  readonly signal?: AbortSignal;
  readonly opId: string;
  readonly receiptFormat: "cli" | "domain";
  readonly exactTaskPackagePath: (view: FleetMirrorView, workspaceRoot: string, taskId: string) => string | null;
  readonly createError: (code: string, message: string) => Error;
  readonly rememberAppliedCut: (
    cut: { readonly revision: number; readonly headDigest: string } | null | undefined,
  ) => void;
}

export async function runFleetEdgeDocSubmit(input: FleetEdgeDocSubmitInput): Promise<Record<string, unknown>> {
  const { payload, peer, action, taskId, workspaceRoot, opId, receiptFormat, createError } = input;
  let normalized: ReturnType<typeof withWorkspaceDocumentPaths>;
  try {
    normalized = withWorkspaceDocumentPaths({ rootDir: workspaceRoot, action });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "invalid_field";
    throw createError(code, error instanceof Error ? error.message : String(error));
  }
  const resolvedAction = normalized.action,
    toWorkspace = workspacePathOf(normalized);

  if (taskId !== null) {
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId, payload.nodeId, {
      entriesPrefix: `tasks/${taskId}`,
    });
    const packagePath = view && input.exactTaskPackagePath(view, workspaceRoot, taskId);
    if (!view || !packagePath) throw createError("mirror_missing", "Task package is not materialized.");
    if (resolvedAction.all === true || (Array.isArray(resolvedAction.paths) && resolvedAction.paths.length > 0))
      throw createError("execution_credential_rejected", "Task document selection cannot name other paths.");
    const scan = scanEdgeTaskWorktrees({ view, workspaceRoot, taskId, packagePath }),
      changes = scan.changes.filter((change) => change.path.startsWith(`${packagePath}/`)),
      admission = await readFleetRepositoryMetadataClient({ ...peer, taskId, actionKind: "doc-submit" });
    if (!admission.actionAllowed)
      throw createError("authorization_denied", "Task document submission is not authorized.");
    const blocked = scan.blocked.filter(
      (row) => row.code !== "doc_route_owned" && row.path.startsWith(`${packagePath}/`),
    );
    if (blocked.length) throw createError("preview_blocked", blocked.map((row) => row.reason).join("; "));
    if (changes.length === 0)
      return { schema: "command-receipt/v2", command: action.kind, ok: true, outcome: "no_changes" };
    return submitScannedChanges({
      input,
      view,
      effectiveTaskId: taskId,
      changes,
      workspaceCoordinate: normalized.workspaceCoordinate === true,
      toWorkspace,
    });
  }

  if (
    resolvedAction.paths !== undefined &&
    (!Array.isArray(resolvedAction.paths) || resolvedAction.paths.some((value) => typeof value !== "string"))
  )
    throw createError("invalid_command", "doc submit requires document paths or a task id.");
  const rawPaths = Array.isArray(resolvedAction.paths) ? (resolvedAction.paths as readonly string[]) : [];
  if (resolvedAction.all === true || rawPaths.length === 0) {
    const summary = [
      "doc-submit: op_rejected (doc_submit_scope_required)",
      "next: rerun ha doc sync --submit with --task <task-id> or --path <path>...",
    ].join("\n");
    return {
      schema: "command-receipt/v2",
      ok: false,
      command: action.kind,
      outcome: "op_rejected",
      opId: `fleet:${opId}`,
      ...(receiptFormat === "cli" ? { canonicalOutcome: "op_rejected" } : {}),
      origin: "fleet-edge",
      code: "doc_submit_scope_required",
      summary,
      rejectionExplanation: summary,
      error: { code: "doc_submit_scope_required", message: summary },
    };
  }

  let selectedPaths: string[];
  try {
    selectedPaths = [...new Set(rawPaths.map((value) => documentPath(value)))];
  } catch (error) {
    throw createError("invalid_field", error instanceof Error ? error.message : String(error));
  }
  if (!directPaths(workspaceRoot, selectedPaths))
    throw createError("invalid_field", "document path contains a symbolic link");

  const taskFolders = new Set(selectedPaths.map((logical) => /^tasks\/([^/]+)\//u.exec(logical)?.[1] ?? null)),
    [onlyFolder] = taskFolders,
    indexPath = taskFolders.size === 1 && onlyFolder !== null ? `tasks/${onlyFolder}/INDEX.md` : null,
    entryPaths = indexPath === null ? selectedPaths : [...new Set([...selectedPaths, indexPath])],
    view = locateFleetMirrorView(payload.viewRoot, payload.repoId, payload.nodeId, { entryPaths });
  if (!view) throw createError("mirror_missing", "Edge replica view is not materialized.");

  const singleTaskId = indexPath === null ? null : readTaskIdFromIndex(view, indexPath),
    scan: FleetMirrorScan =
      singleTaskId !== null && onlyFolder !== null
        ? scanEdgeTaskWorktrees({
            view,
            workspaceRoot,
            taskId: singleTaskId,
            packagePath: `tasks/${onlyFolder}`,
            selection: selectedPaths,
          })
        : scanFleetMirrorWorktree(view, workspaceRoot, selectedPaths);

  const seenPaths = new Set([
      ...scan.cleanPaths,
      ...scan.changes.map((change) => change.path),
      ...scan.inapplicablePaths,
      ...scan.blocked.map((row) => row.path),
    ]),
    missing = selectedPaths.find((logical) => !seenPaths.has(logical));
  if (missing !== undefined)
    throw createError(
      "document_not_found",
      `Document ${toWorkspace(missing)} is absent from the workspace and replica cut.`,
    );

  if (scan.blocked.length > 0) {
    const deleted = new Set(scan.deletedPaths),
      code =
        scan.blocked.find((row) => row.code === "doc_candidate_too_large")?.code ??
        (scan.blocked.some((row) => deleted.has(row.path)) ? "deletion_forbidden" : "preview_blocked");
    throw createError(code, scan.blocked.map((row) => `${toWorkspace(row.path)}: ${row.reason}`).join("; "));
  }

  if (scan.changes.length === 0)
    return { schema: "command-receipt/v2", command: action.kind, ok: true, outcome: "no_changes" };

  if (singleTaskId !== null || !payload.executionCredential) {
    const admission = await readFleetRepositoryMetadataClient({
      ...peer,
      ...(singleTaskId !== null ? { taskId: singleTaskId } : {}),
      actionKind: "doc-submit",
    });
    if (!admission.actionAllowed) throw createError("authorization_denied", "Document submission is not authorized.");
  }

  return submitScannedChanges({
    input,
    view,
    effectiveTaskId: singleTaskId,
    changes: scan.changes,
    workspaceCoordinate: normalized.workspaceCoordinate === true,
    toWorkspace,
    baseLedgerSha: { repoId: view.repoId, revision: view.revision, headDigest: view.headDigest },
  });
}

async function submitScannedChanges(options: {
  readonly input: FleetEdgeDocSubmitInput;
  readonly view: FleetMirrorView;
  readonly effectiveTaskId: string | null;
  readonly changes: readonly FleetMirrorDirtyFile[];
  readonly workspaceCoordinate: boolean;
  readonly toWorkspace: (document: string) => string;
  readonly baseLedgerSha?: { readonly repoId: string; readonly revision: number; readonly headDigest: string };
}): Promise<Record<string, unknown>> {
  const { input, effectiveTaskId, changes, workspaceCoordinate, toWorkspace, baseLedgerSha } = options,
    { payload, peer, action, workspaceRoot, waitMs, signal, createError } = input;
  const center = await runFleetEdgeWrite({
    viewRoot: payload.viewRoot,
    repoId: payload.repoId,
    nodeId: payload.nodeId,
    timeoutMs: waitMs,
    ...(signal ? { signal } : {}),
    write: async () =>
      (
        await runFleetWriteClient({
          ...peer,
          ...(effectiveTaskId !== null ? { taskId: effectiveTaskId } : {}),
          executionId: null,
          channel: "collaborator",
          ...(baseLedgerSha ? { baseLedgerSha } : {}),
          changes: changes.map((change) => ({
            path: change.path,
            body: Buffer.from(change.bytes),
            baseBlobSha256: change.baseBlobSha256,
            policyId: change.policyId,
            mediaType: change.mediaType,
          })),
        })
      ).center,
  });
  if (center.outcome === "applied") {
    acceptEdgeWorktreeScanBases(changes, workspaceRoot);
    const materialized = applyFleetMirrorCut(payload.viewRoot, payload.repoId, workspaceRoot, "pull", {
      kind: effectiveTaskId !== null ? "task-docs" : "doc-sync",
      taskId: effectiveTaskId,
      executionId: null,
      changedPaths: changes.map((change) => change.path),
    });
    if (materialized.outcome === "pull_blocked")
      throw createError("pull_blocked", "Task document materialization is blocked.");
    const cut = center.receipt?.cut;
    if (
      cut !== null &&
      typeof cut === "object" &&
      "revision" in cut &&
      "headDigest" in cut &&
      typeof cut.revision === "number" &&
      typeof cut.headDigest === "string"
    )
      input.rememberAppliedCut({ revision: cut.revision, headDigest: cut.headDigest });
  }
  const receipt =
    workspaceCoordinate && center.receipt ? localizeDocReceipt(center.receipt, toWorkspace) : center.receipt;
  return {
    ...center,
    ...(receipt ?? {}),
    schema: "command-receipt/v2",
    command: action.kind,
    ok: center.outcome === "applied" || center.outcome === "no_changes",
  };
}

function readTaskIdFromIndex(view: FleetMirrorView, indexPath: string): string | null {
  const cutBytes = fleetMirrorCutFile(view, indexPath);
  if (cutBytes === null) return null;
  const body = new TextDecoder("utf-8").decode(cutBytes);
  for (const line of body.split(/\r?\n/u)) {
    const match = /^(?:task_id|taskId):\s*(\S+)\s*$/u.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

function localizeDocReceipt(
  receipt: Readonly<Record<string, unknown>>,
  toWorkspace: (document: string) => string,
): Readonly<Record<string, unknown>> {
  const detail = receipt.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return receipt;
  const record = detail as Readonly<Record<string, unknown>>;
  if (record.kind !== "doc_sync") return receipt;
  const mapRows = (value: unknown) =>
    Array.isArray(value)
      ? value.map((entry) =>
          entry !== null && typeof entry === "object" && "path" in entry && typeof entry.path === "string"
            ? { ...entry, path: toWorkspace(entry.path) }
            : entry,
        )
      : value;
  return {
    ...receipt,
    detail: {
      ...record,
      paths: mapRows(record.paths),
      deletions: mapRows(record.deletions),
      unresolvedTouches: mapRows(record.unresolvedTouches),
      differences: mapRows(record.differences),
    },
  };
}
