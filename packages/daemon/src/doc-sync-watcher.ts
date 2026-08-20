import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { classifyTextualArtifactPath, consumeKnownError, resolveHarnessLayout, type WriteReceipt } from "../../kernel/src/index.ts";

const fullScan = "*";
export interface WatchAttribution { readonly sessionId: string; readonly personId: string; readonly path: string; readonly fingerprint: string }
export interface DocSyncWatchStatus { readonly sessionId: string; readonly personId: string; readonly state: "active" | "blocked" | "closed"; readonly pendingPaths: readonly string[]; readonly lastReceipt: Pick<WriteReceipt, "outcome" | "opId" | "code" | "nextAction"> | null; readonly metrics: { readonly scans: number; readonly intents: number; readonly commits: number; readonly writes: number } }
export interface DocSyncWatcher { readonly wake: (logicalPath?: string) => void; readonly overflow: () => void; readonly flush: () => Promise<void>; readonly status: () => DocSyncWatchStatus; readonly close: () => Promise<void> }
type Runner = (action: { readonly kind: "doc-dry-run" | "doc-submit"; readonly paths: readonly string[] }, attribution?: WatchAttribution) => Promise<WriteReceipt>;
type WatchFactory = (target: string, options: { readonly recursive: boolean }, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
interface ScanRow { readonly path: string; readonly state: "clean" | "eligible" | "blocked" | "deletion" | "conflict"; readonly reason: string | null; readonly candidateBlobSha256: string | null }

export function openDocSyncWatcher(input: { readonly rootDir: string; readonly personId: string; readonly run: Runner; readonly debounceMs?: number; readonly pollMs?: number; readonly watchFilesystem?: boolean; readonly startupScan?: boolean; readonly platform?: NodeJS.Platform; readonly watchPath?: WatchFactory }): DocSyncWatcher {
  const sessionId = `watch-${randomUUID()}`, debounceMs = input.debounceMs ?? 75, pending = new Set<string>(), observations = new Map<string, { fingerprint: string; count: number }>(), submitted = new Map<string, string>();
  const metrics = { scans: 0, intents: 0, commits: 0, writes: 0 }; let state: DocSyncWatchStatus["state"] = "active", lastReceipt: DocSyncWatchStatus["lastReceipt"] = null, timer: NodeJS.Timeout | null = null, pollTimer: NodeJS.Timeout | null = null, filesystemWatcher: FSWatcher | null = null, rearmPending = false, tail = Promise.resolve();
  const pollMs = input.pollMs ?? 30_000;
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
      else if (result.outcome === "op_rejected" && (result.code === "base_ledger_changed" || result.code === "base_blob_changed" || result.code === "watch_fingerprint_changed")) { observations.delete(row.path); pending.add(row.path); }
      else if (result.outcome !== "applied") state = "blocked";
    }
    for (const pathValue of observations.keys()) if (!seen.has(pathValue)) observations.delete(pathValue);
    if (pending.size && timer === null) schedule();
  };
  const authoredRoot = resolveHarnessLayout(input.rootDir).authoredRoot;
  // One recursive root stream avoids the per-directory FSEvents handles that could deadlock
  // macOS and keeps JS watcher/fd registration O(1). Linux implements recursion with inotify
  // watch descriptors. Notifications are latency hints; periodic full-scan reconciliation
  // remains the correctness path when registration fails or an event is lost.
  const reconcile = (): void => { if (pollTimer || state === "closed") return; pollTimer = setInterval(() => wake(), pollMs); pollTimer.unref?.(); };
  if (input.watchFilesystem !== false) {
    reconcile(); const platform = input.platform ?? process.platform, recursive = ["darwin", "linux", "win32"].includes(platform), watchPath = input.watchPath ?? watch;
    const armFilesystemWatcher = (): void => {
      let watcher: FSWatcher;
      try { watcher = watchPath(authoredRoot, { recursive }, (_event, filename) => {
        if (filename === null) { wake(); return; } const relative = String(filename); if (relative.split(path.sep).includes(".git")) return; wake(relative);
        // Linux's recursive fs.watch may retain a stale inode binding after an
        // editor renames a temporary file over the watched path. Re-arm the one
        // root stream after document events so the next atomic save is observed.
        if (platform === "linux" && normalize(relative) !== null && !rearmPending && state !== "closed") { rearmPending = true; setImmediate(() => { rearmPending = false; if (state === "closed") return; const stale = filesystemWatcher; filesystemWatcher = null; stale?.close(); armFilesystemWatcher(); }); }
      }); filesystemWatcher = watcher;
      // Closing directly inside an FSEvents error callback deadlocks libuv on macOS.
      watcher.on("error", () => { if (filesystemWatcher === watcher) filesystemWatcher = null; setImmediate(() => watcher.close()); wake(); });
      } catch (error) { consumeKnownError(error); filesystemWatcher = null; }
    };
    armFilesystemWatcher();
  }
  if (input.startupScan !== false) wake();
  return { wake, overflow: () => wake(), flush: async () => { if (timer) { clearTimeout(timer); timer = null; } enqueue(true); await tail; }, status: () => ({ sessionId, personId: input.personId, state, pendingPaths: [...pending].sort(), lastReceipt, metrics: { ...metrics } }),
    close: async () => { if (state === "closed") return; state = "closed"; if (timer) clearTimeout(timer); timer = null; if (pollTimer) clearInterval(pollTimer); pollTimer = null; const watcher = filesystemWatcher, closed = watcher ? once(watcher, "close") : null; filesystemWatcher = null; watcher?.close(); if (closed) await closed; await tail; } };
  function remember(receipt: WriteReceipt): void { const nextAction = receipt.nextAction ?? receipt.detail?.nextAction; lastReceipt = { outcome: receipt.outcome, opId: receipt.opId, ...(receipt.code ? { code: receipt.code } : {}), ...(nextAction ? { nextAction } : {}) }; }
}

function parseScan(receipt: WriteReceipt): { readonly baseLedgerSha: string; readonly rows: readonly ScanRow[] } | null { if (receipt.outcome !== "applied" || !receipt.evidence?.startsWith("doc-scan:")) return null; try { const value = JSON.parse(receipt.evidence.slice("doc-scan:".length)) as { baseLedgerSha?: unknown; rows?: unknown }; if (typeof value.baseLedgerSha !== "string" || !Array.isArray(value.rows)) return null; return { baseLedgerSha: value.baseLedgerSha, rows: value.rows as readonly ScanRow[] }; } catch (error) { consumeKnownError(error); return null; } }
export function normalizeDocSyncWatchPath(value: string): string | null { const normalized = value.split(path.sep).join("/").replace(/^\.\//u, ""); return normalized && !normalized.startsWith("/") && !normalized.split("/").includes("..") && classifyTextualArtifactPath(normalized) !== null && !normalized.includes(".conflict-") ? normalized : null; }
function normalize(value: string): string | null { return normalizeDocSyncWatchPath(value); }
