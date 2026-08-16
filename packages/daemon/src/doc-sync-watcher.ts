import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type WriteReceipt } from "../../kernel/src/index.ts";

const fullScan = "*";
export interface WatchAttribution { readonly sessionId: string; readonly personId: string; readonly path: string; readonly fingerprint: string }
export interface DocSyncWatchStatus { readonly sessionId: string; readonly personId: string; readonly state: "active" | "blocked" | "closed"; readonly pendingPaths: readonly string[]; readonly lastReceipt: Pick<WriteReceipt, "outcome" | "opId" | "code" | "nextAction"> | null; readonly metrics: { readonly scans: number; readonly intents: number; readonly commits: number; readonly writes: number } }
export interface DocSyncWatcher { readonly wake: (logicalPath?: string) => void; readonly overflow: () => void; readonly flush: () => Promise<void>; readonly status: () => DocSyncWatchStatus; readonly close: () => Promise<void> }
type Runner = (action: { readonly kind: "doc-dry-run" | "doc-submit"; readonly paths: readonly string[] }, attribution?: WatchAttribution) => Promise<WriteReceipt>;
interface ScanRow { readonly path: string; readonly state: "clean" | "eligible" | "blocked" | "deletion" | "conflict"; readonly reason: string | null; readonly candidateBlobSha256: string | null }

export function openDocSyncWatcher(input: { readonly rootDir: string; readonly personId: string; readonly run: Runner; readonly debounceMs?: number; readonly watchFilesystem?: boolean; readonly startupScan?: boolean }): DocSyncWatcher {
  const sessionId = `watch-${randomUUID()}`, debounceMs = input.debounceMs ?? 75, pending = new Set<string>(), observations = new Map<string, { fingerprint: string; count: number }>(), submitted = new Map<string, string>();
  const metrics = { scans: 0, intents: 0, commits: 0, writes: 0 }, directories = new Map<string, FSWatcher>(); let state: DocSyncWatchStatus["state"] = "active", lastReceipt: DocSyncWatchStatus["lastReceipt"] = null, timer: NodeJS.Timeout | null = null, tail = Promise.resolve();
  const schedule = () => { if (timer || state === "closed") return; timer = setTimeout(() => { timer = null; enqueue(false); }, debounceMs); };
  const wake = (logicalPath?: string) => { if (state === "closed") return; const normalized = logicalPath && normalize(logicalPath); pending.add(normalized ?? fullScan); schedule(); };
  const enqueue = (drain: boolean) => { tail = tail.then(async () => { do { await scanOnce(); } while (drain && pending.size > 0); }, () => undefined); };
  const scanOnce = async () => {
    if (!pending.size || state === "closed") return; const selected = pending.has(fullScan) ? [] : [...pending].sort(); pending.clear();
    const receipt = await input.run({ kind: "doc-dry-run", paths: selected }); metrics.scans += 1; remember(receipt); const report = parseScan(receipt);
    if (!report) { state = "blocked"; return; } state = report.rows.some((row) => row.state === "blocked" || row.state === "deletion" || row.state === "conflict") ? "blocked" : "active"; const seen = new Set(report.rows.map((row) => row.path));
    for (const row of report.rows) {
      if (row.state !== "eligible" || row.candidateBlobSha256 === null) { observations.delete(row.path); if (row.state === "blocked" && row.reason === "canonical projection is pending") pending.add(row.path); continue; }
      const fingerprint = `${report.baseLedgerSha}:${row.candidateBlobSha256}`, previous = observations.get(row.path), count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
      observations.set(row.path, { fingerprint, count }); if (submitted.get(row.path) === fingerprint) continue; if (count < 2) { pending.add(row.path); continue; }
      metrics.intents += 1; const result = await input.run({ kind: "doc-submit", paths: [row.path] }, { sessionId, personId: input.personId, path: row.path, fingerprint: row.candidateBlobSha256 }); remember(result);
      if (result.outcome === "applied" && !result.opId.startsWith("noop:")) { submitted.set(row.path, fingerprint); metrics.commits += 1; metrics.writes += 1; }
      else if (result.outcome === "rejected" && (result.code === "base_ledger_changed" || result.code === "base_blob_changed" || result.code === "watch_fingerprint_changed")) { observations.delete(row.path); pending.add(row.path); }
      else if (result.outcome !== "applied") state = "blocked";
    }
    for (const pathValue of observations.keys()) if (!seen.has(pathValue)) observations.delete(pathValue);
    if (pending.size && timer === null) schedule();
  };
  const authoredRoot = resolveHarnessLayout(input.rootDir).authoredRoot;
  // One non-recursive watcher per authored directory. Node's recursive watch keeps a
  // per-file watch and stops reporting a file through its parent directory once it has
  // seen it; an editor save writes a temporary file and renames it over the target, which
  // unlinks the watched inode, so on Linux the second and every later save of the same
  // file is delivered nowhere. Directory inodes survive rename-over.
  const watchDirectory = (directory: string): void => {
    if (directories.has(directory) || state === "closed" || path.basename(directory) === ".git") return; let watcher: FSWatcher;
    try { watcher = watch(directory, (_event, filename) => { if (filename === null) { wake(); return; } const child = path.join(directory, String(filename));
      try { if (lstatSync(child).isDirectory()) watchDirectory(child); } catch (error) { consumeKnownError(error); } wake(path.relative(authoredRoot, child)); }); } catch (error) { consumeKnownError(error); return; }
    watcher.on("error", () => { watcher.close(); directories.delete(directory); wake(); }); directories.set(directory, watcher);
    try { for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) watchDirectory(path.join(directory, entry.name)); } catch (error) { consumeKnownError(error); } };
  if (input.watchFilesystem !== false) { watchDirectory(authoredRoot); if (directories.size === 0) state = "blocked"; }
  if (input.startupScan !== false) wake();
  return { wake, overflow: () => wake(), flush: async () => { if (timer) { clearTimeout(timer); timer = null; } enqueue(true); await tail; }, status: () => ({ sessionId, personId: input.personId, state, pendingPaths: [...pending].sort(), lastReceipt, metrics: { ...metrics } }),
    close: async () => { if (state === "closed") return; state = "closed"; if (timer) clearTimeout(timer); timer = null; for (const watcher of directories.values()) watcher.close(); directories.clear(); await tail; } };
  function remember(receipt: WriteReceipt): void { const nextAction = receipt.nextAction ?? receipt.detail?.nextAction; lastReceipt = { outcome: receipt.outcome, opId: receipt.opId, ...(receipt.code ? { code: receipt.code } : {}), ...(nextAction ? { nextAction } : {}) }; }
}

function parseScan(receipt: WriteReceipt): { readonly baseLedgerSha: string; readonly rows: readonly ScanRow[] } | null { if (receipt.outcome !== "applied" || !receipt.evidence?.startsWith("doc-scan:")) return null; try { const value = JSON.parse(receipt.evidence.slice("doc-scan:".length)) as { baseLedgerSha?: unknown; rows?: unknown }; if (typeof value.baseLedgerSha !== "string" || !Array.isArray(value.rows)) return null; return { baseLedgerSha: value.baseLedgerSha, rows: value.rows as readonly ScanRow[] }; } catch (error) { consumeKnownError(error); return null; } }
function normalize(value: string): string | null { const normalized = value.split(path.sep).join("/").replace(/^\.\//u, ""); return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") && (normalized.endsWith(".md") || normalized.endsWith(".txt") || normalized.endsWith(".json")) && !normalized.includes(".conflict-") ? normalized : null; }
function consumeKnownError(error: unknown): void { void error; }
