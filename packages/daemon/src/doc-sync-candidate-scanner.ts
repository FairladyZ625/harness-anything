import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { DOC_POLICY_ID, decideDocWrite, documentPath, parseDocWriteIntent, resolveDocRoute, resolveHarnessLayout, sha256Bytes,
  type ActorIdentity, type CanonicalEventStore, type DocWriteIntent, type LedgerCommitSha, type TaskProjection, type WriteSource } from "../../kernel/src/index.ts";

export type DocCandidateState = "clean" | "eligible" | "blocked" | "deletion";
export interface DocCandidateRow { readonly path: string; readonly state: DocCandidateState; readonly reason: string | null; readonly baseBlobSha256: string | null; readonly candidateBlobSha256: string | null; readonly size: number | null; readonly mediaType: "text/markdown" | "text/plain" | null }
export interface ScannedDocCandidate extends DocCandidateRow { readonly bytes: Uint8Array | null }
export interface DocCandidateScan { readonly baseLedgerSha: LedgerCommitSha; readonly executionId: string | null; readonly lease: ReturnType<TaskProjection["currentLeaseForExecution"]>; readonly rows: readonly ScannedDocCandidate[] }

export function scanDocCandidates(input: { readonly rootDir: string; readonly workspaceId: string; readonly store: CanonicalEventStore; readonly projection: TaskProjection; readonly actor: ActorIdentity; readonly source: WriteSource; readonly now: string; readonly selection?: readonly string[]; readonly executionId?: string }): DocCandidateScan {
  const layout = resolveHarnessLayout(input.rootDir), prefix = relative(input.rootDir, layout.authoredRoot), selected = input.selection?.map((value) => documentPath(value)), candidates = selected?.length ? [...new Set(selected)] : dirtyPaths(input.rootDir, prefix), paths = candidates.filter((value) => selected?.length || prosePath(value)).sort(), baseLedgerSha = input.store.currentCommit(), execution = executionBinding(paths, input.executionId, input.projection, input.now), rows = paths.map((logical) => scanOne(logical));
  return { baseLedgerSha, executionId: execution.id, lease: execution.lease, rows };
  function scanOne(logical: string): ScannedDocCandidate {
    const route = resolveDocRoute(documentPath(logical)), target = path.join(layout.authoredRoot, ...logical.split("/")), projected = input.projection.readDocument(documentPath(logical));
    if (!prosePath(logical)) return row("blocked", "path is not canonical prose", null, projected.document?.blobSha256 ?? null, null);
    if (!route.allowed) return row("blocked", `path is owned by ${route.requiredRoute}`, null, projected.document?.blobSha256 ?? null, null);
    if (projected.watermark !== projected.sourceRevision) return row("blocked", "canonical projection is pending", null, projected.document?.blobSha256 ?? null, null);
    if (!directFile(layout.authoredRoot, logical)) return row("blocked", "path contains a symbolic link or is not a regular file", null, projected.document?.blobSha256 ?? null, null);
    const bytes = existsSync(target) ? readFileSync(target) : null, base = projected.document?.blobSha256 ?? null;
    if (bytes === null) return row(projected.document ? "deletion" : "clean", projected.document ? "canonical document is missing from the worktree" : null, null, base, null);
    const candidate = sha256Bytes(bytes), mediaType = logical.endsWith(".md") ? "text/markdown" as const : "text/plain" as const; if (candidate === base) return row("clean", null, bytes, base, candidate, mediaType);
    const intent = parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: execution.id, baseLedgerSha: baseLedgerSha.sha, changes: [{ path: logical, baseBlobSha256: base, policyId: DOC_POLICY_ID, candidate: { ref: `doc-sync-claims/${candidate}`, sha256: candidate, size: bytes.byteLength, mediaType } }] }, input.workspaceId), decision = decideDocWrite({ intent, opId: "scan", eventId: "scan", workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1, actor: input.actor, source: input.source, occurredAt: input.now, currentLedgerSha: baseLedgerSha, lease: execution.lease, documents: [projected.document], claims: [bytes] });
    return decision.accepted ? row("eligible", null, bytes, base, candidate, mediaType) : row(decision.code === "deletion_forbidden" ? "deletion" : "blocked", decision.detail.unresolvedTouches[0]?.reason ?? decision.detail.nextAction, bytes, base, candidate, mediaType);
    function row(state: DocCandidateState, reason: string | null, body: Uint8Array | null, baseHash: string | null, candidateHash: string | null, media: "text/markdown" | "text/plain" | null = null): ScannedDocCandidate { return { path: logical, state, reason, baseBlobSha256: baseHash, candidateBlobSha256: candidateHash, size: body?.byteLength ?? null, mediaType: media, bytes: body }; }
  }
}

export function intentFromScan(scan: DocCandidateScan, workspaceId: string): { readonly intent: DocWriteIntent; readonly claims: readonly Uint8Array[] } { const eligible = scan.rows.filter((row) => row.state === "eligible"); return { intent: parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: scan.executionId, baseLedgerSha: scan.baseLedgerSha.sha, changes: eligible.map((row) => ({ path: row.path, baseBlobSha256: row.baseBlobSha256, policyId: DOC_POLICY_ID, candidate: { ref: `doc-sync-claims/${row.candidateBlobSha256}`, sha256: row.candidateBlobSha256, size: row.size, mediaType: row.mediaType } })) }, workspaceId), claims: eligible.map((row) => row.bytes!) }; }
export function publicScan(scan: DocCandidateScan): { readonly baseLedgerSha: string; readonly rows: readonly DocCandidateRow[] } { return { baseLedgerSha: scan.baseLedgerSha.sha, rows: scan.rows.map(({ bytes: _bytes, ...row }) => row) }; }

function executionBinding(paths: readonly string[], explicit: string | undefined, projection: TaskProjection, now: string) { if (explicit) return { id: explicit, lease: projection.currentLeaseForExecution(explicit, now) }; const tasks = [...new Set(paths.flatMap((value) => /^tasks\/([^/]+)\//u.exec(value)?.[1] ?? []))], lease = tasks.length === 1 ? projection.currentLease(tasks[0]!, now) : null; return { id: lease?.executionId ?? null, lease }; }
function dirtyPaths(repoRoot: string, authoredPrefix: string): string[] { const changed = gitNames(repoRoot, ["diff", "--name-only", "-z", "HEAD", "--", authoredPrefix]), untracked = gitNames(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", authoredPrefix]), prefix = `${authoredPrefix}/`; return [...new Set([...changed, ...untracked].filter((value) => value.startsWith(prefix) && !value.includes(".conflict-")).map((value) => value.slice(prefix.length)))]; }
function gitNames(repoRoot: string, args: readonly string[]): string[] { return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).split("\0").filter(Boolean); }
function prosePath(value: string): boolean { return value.endsWith(".md") || value.endsWith(".txt"); }
function relative(root: string, target: string): string { return path.relative(root, target).split(path.sep).join("/"); }
function directFile(authoredRoot: string, logical: string): boolean { let target = authoredRoot; if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false; for (const segment of logical.split("/")) { target = path.join(target, segment); if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false; } return !existsSync(target) || lstatSync(target).isFile(); }
