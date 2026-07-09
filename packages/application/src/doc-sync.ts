export interface RegistryRow {
  readonly id: string;
  readonly bearing: string;
  readonly channel: { readonly pathClass: string; readonly zoneClass: string };
  readonly cliActions?: ReadonlyArray<string>;
  readonly apiRoutes?: ReadonlyArray<string>;
  readonly guiBridgeMethods?: ReadonlyArray<string>;
  readonly writeKinds?: ReadonlyArray<string>;
}

export interface DocSyncChangeV1 {
  readonly path: string;
  readonly baseBlobSha256: string | null;
  readonly newBlobSha256: string;
  readonly mediaType: string;
  readonly size: number;
  readonly declaredPathClass?: string;
  readonly declaredZoneClass?: string;
  readonly declaredBearing?: string;
  readonly content: { readonly kind: "inline"; readonly body: string } | { readonly kind: string };
}

export interface DocSyncSubmitRequestV1 {
  readonly repo: { readonly repoId: string };
  readonly session?: { readonly sessionId?: string; readonly runtime?: "human" | "claude-code" | "codex" | "zcode" | "antigravity" | "unknown" };
  readonly payload: {
    readonly baseLedgerSha: string;
    readonly intentId: string;
    readonly declaredIntent: "prose-edit" | "manual-artifact" | "generated-artifact" | "session-export";
    readonly changes: ReadonlyArray<DocSyncChangeV1>;
  };
}

export interface DocSyncForbiddenTouchV1 {
  readonly path: string;
  readonly hunks: ReadonlyArray<{
    readonly hunkId: string;
    readonly oldStartLine: number | null;
    readonly oldEndLine: number | null;
    readonly newStartLine: number | null;
    readonly newEndLine: number | null;
    readonly bearing: string;
    readonly zoneClass: string;
    readonly registryRowId: string;
    readonly pathClass: "rpc-only";
    readonly summary: string;
    readonly requiredRpc: {
      readonly registryRowId: string;
      readonly cliActions?: ReadonlyArray<string>;
      readonly apiRoutes?: ReadonlyArray<string>;
      readonly guiBridgeMethods?: ReadonlyArray<string>;
      readonly writeKinds?: ReadonlyArray<string>;
    };
  }>;
}

export interface DocSyncConflictV1 {
  readonly path: string;
  readonly code: "base_blob_changed" | "base_ledger_changed" | "content_hash_mismatch";
  readonly baseLedgerSha: string;
  readonly currentLedgerSha: string;
  readonly baseBlobSha256: string | null;
  readonly currentBlobSha256: string | null;
  readonly submittedNewBlobSha256: string;
  readonly retryable: true;
  readonly action: "rerun-doc-status" | "refresh-base-and-resubmit" | "resolve-local-conflict";
  readonly message: string;
}

export type TouchedZone =
  | { readonly ok: true; readonly bearing: string; readonly zoneClass: string; readonly row: RegistryRow }
  | { readonly ok: false; readonly bearing?: string; readonly zoneClass?: string; readonly reason: string };

export interface DirtyEntry {
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly path: string;
}

export interface AppliedChangePlan {
  readonly path: string;
  readonly absolutePath: string;
  readonly baseBlobSha256: string | null;
  readonly newBlobSha256: string;
  readonly body: string;
  readonly zoneClassesTouched: ReadonlyArray<string>;
}

export type DocSyncSubmitResultV1 =
  | {
    readonly ok: true;
    readonly schema: "daemon.doc-sync-submit-result/v1";
    readonly status: "accepted";
    readonly intentId: string;
    readonly baseLedgerSha: string;
    readonly appliedLedgerSha: string;
    readonly rebasedFromLedgerSha?: string;
    readonly appliedChanges: ReadonlyArray<{
      readonly path: string;
      readonly baseBlobSha256: string | null;
      readonly newBlobSha256: string;
      readonly zoneClassesTouched: ReadonlyArray<string>;
    }>;
  }
  | {
    readonly ok: false;
    readonly _tag?: "WriteRejected";
    readonly schema: "daemon.doc-sync-submit-result/v1";
    readonly status: "rejected";
    readonly intentId: string;
    readonly code: "doc_sync_forbidden_touch" | "cas_watermark_mismatch" | "doc_sync_conflict" | "doc_sync_post_apply_bearing_changed" | "doc_sync_invalid_payload";
    readonly reason: string;
    readonly retryable: boolean;
    readonly currentWatermark?: string | null;
    readonly expectedWatermark?: string | null;
    readonly conflicts?: ReadonlyArray<DocSyncConflictV1>;
    readonly forbiddenTouches?: ReadonlyArray<DocSyncForbiddenTouchV1>;
    readonly unresolvedTouches?: ReadonlyArray<{ readonly path: string; readonly reason: string; readonly bearing?: string; readonly zoneClass?: string }>;
    readonly postApplyViolations?: ReadonlyArray<DocSyncForbiddenTouchV1>;
  };

export interface DocSyncValidationResult {
  readonly ok: boolean;
  readonly acceptedChanges: ReadonlyArray<AppliedChangePlan>;
  readonly forbiddenTouches: ReadonlyArray<DocSyncForbiddenTouchV1>;
  readonly unresolvedTouches: ReadonlyArray<{ readonly path: string; readonly reason: string; readonly bearing?: string; readonly zoneClass?: string }>;
  readonly conflicts: ReadonlyArray<DocSyncConflictV1>;
  readonly currentLedgerSha: string;
}

export function classifyTouchedZones(pathInput: string, status: DirtyEntry["status"], baseBody: string | null, currentBody: string | null, rows: ReadonlyArray<RegistryRow>): ReadonlyArray<TouchedZone> {
  if (status === "deleted") return [unresolved("doc sync deletion is not defined in Phase 2")];
  const normalized = pathInput.split(/[\\/]+/u).join("/");
  if (normalized === "modules.json") return rowZones(rows, "module-registry", "module-authored-structured");
  if (normalized.startsWith("decisions/")) return rowZones(rows, "decision", "decision-authored-structured");
  if (!normalized.startsWith("tasks/")) return [unresolved("path is outside the registered doc-sync task document surface")];
  if (normalized.endsWith("/facts.md")) return rowZones(rows, "task-fact", "task-authored-structured");
  if (normalized.endsWith("/INDEX.md") && frontmatterChanged(baseBody, currentBody)) return rowZones(rows, "task-lifecycle", "task-authored-structured");
  return rowZones(rows, "task-document", "task-authored-prose-or-stage");
}

export function classifyStaticZones(pathInput: string, rows: ReadonlyArray<RegistryRow>): ReadonlyArray<TouchedZone> {
  const normalized = pathInput.split(/[\\/]+/u).join("/");
  if (normalized === "modules.json") return rowZones(rows, "module-registry", "module-authored-structured");
  if (normalized.startsWith("decisions/")) return rowZones(rows, "decision", "decision-authored-structured");
  if (!normalized.startsWith("tasks/")) return [unresolved("path is outside the registered doc-sync task document surface")];
  if (normalized.endsWith("/facts.md")) return rowZones(rows, "task-fact", "task-authored-structured");
  if (normalized.endsWith("/INDEX.md")) return rowZones(rows, "task-lifecycle", "task-authored-structured");
  return rowZones(rows, "task-document", "task-authored-prose-or-stage");
}

export function forbiddenTouchesForZones(filePath: string, zones: ReadonlyArray<Extract<TouchedZone, { readonly ok: true }>>): ReadonlyArray<DocSyncForbiddenTouchV1> {
  return zones.flatMap((zone) => zone.row.channel.pathClass === "rpc-only" ? [forbiddenTouch(filePath, zone)] : []);
}

export function mediaType(filePath: string): string {
  if (filePath.endsWith(".md")) return "text/markdown";
  if (filePath.endsWith(".json")) return "application/json";
  return "text/plain";
}

export function frontmatterBlock(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(body);
  return match?.[0] ?? "";
}

function rowZones(rows: ReadonlyArray<RegistryRow>, bearing: string, zoneClass: string): ReadonlyArray<TouchedZone> {
  const matches = rows.filter((row) => row.bearing === bearing && row.channel.zoneClass === zoneClass);
  if (matches.length === 0) return [unresolved(`registry row resolution failed for ${bearing}/${zoneClass}`, bearing, zoneClass)];
  const rpcOnly = matches.filter((row) => row.channel.pathClass === "rpc-only");
  if (rpcOnly.length > 0) return [{ ok: true, bearing, zoneClass, row: bestRpcRow(rpcOnly) }];
  return matches.map((row) => ({ ok: true, bearing, zoneClass, row }));
}

function bestRpcRow(rows: ReadonlyArray<RegistryRow>): RegistryRow {
  return [...rows].sort((left, right) => routeCount(right) - routeCount(left) || left.id.localeCompare(right.id))[0]!;
}

function routeCount(row: RegistryRow): number {
  return (row.cliActions?.length ?? 0) + (row.apiRoutes?.length ?? 0) + (row.guiBridgeMethods?.length ?? 0) + (row.writeKinds?.length ?? 0);
}

function forbiddenTouch(filePath: string, zone: Extract<TouchedZone, { readonly ok: true }>): DocSyncForbiddenTouchV1 {
  return {
    path: filePath,
    hunks: [{
      hunkId: "dirty-file",
      oldStartLine: null,
      oldEndLine: null,
      newStartLine: null,
      newEndLine: null,
      bearing: zone.bearing,
      zoneClass: zone.zoneClass,
      registryRowId: zone.row.id,
      pathClass: "rpc-only",
      summary: `Doc sync candidate touches ${zone.row.id}.`,
      requiredRpc: {
        registryRowId: zone.row.id,
        ...(zone.row.cliActions ? { cliActions: zone.row.cliActions } : {}),
        ...(zone.row.apiRoutes ? { apiRoutes: zone.row.apiRoutes } : {}),
        ...(zone.row.guiBridgeMethods ? { guiBridgeMethods: zone.row.guiBridgeMethods } : {}),
        ...(zone.row.writeKinds ? { writeKinds: zone.row.writeKinds } : {})
      }
    }]
  };
}

function unresolved(reason: string, bearing?: string, zoneClass?: string): TouchedZone {
  return { ok: false, reason, ...(bearing ? { bearing } : {}), ...(zoneClass ? { zoneClass } : {}) };
}

function frontmatterChanged(baseBody: string | null, currentBody: string | null): boolean {
  return frontmatterBlock(baseBody ?? "") !== frontmatterBlock(currentBody ?? "");
}
