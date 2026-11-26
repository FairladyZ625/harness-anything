/**
 * Offline read-only governance auditor and rolling baseline exporter for `tools/retro/`.
 *
 * Implements dec_D8EECF29C93D0C300252060A10 (CH1, CH4):
 * - Computes rolling `taskBaselines` (P50/P90 duration, rework rate, top-20 hot files) and
 *   optionally emits sanitized `retro-baselines/v1` with zero private path/ID leakage.
 * - Audits five read-only governance surfaces:
 *   1. `quarantineAudit`: expired `tools/test-quarantine.json` entries & closed `ownerTask`s
 *   2. `unreachedAllowlists`: `UNREACHED_ALLOW=0` check reusing `allowlistJsonPolicies`
 *      (clearly marking unobservable gate sections without modifying `tools/gates/*.mjs`)
 *   3. `waiverExposure`: `closeout-readiness` null-waiver exposure ledger & dispute drafts
 *   4. `decisionWhyNotAudit`: high-risk / standing-policy hollow Decisions missing whyNot
 *   5. `factContagionFlags`: standing Facts from unfinalized tasks or with dangling code paths
 * - Pure offline read-only on repo/ledger; `--strict` exits 1 on expired quarantine or
 *   `UNREACHED_ALLOW > 0`.
 */
import { spawnSync } from "node:child_process";
import { hash as cryptoHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { makeTaskProjectionReader } from "@harness-anything/storage/projection";
import { allowlistJsonPolicies } from "../gates/allowlist-path-existence.mjs";
import { readTestQuarantine } from "../test-quarantine.mjs";
import { SanitizeError, rejectPrivateLeakage, sanitizeText } from "./lib/sanitize.mjs";
import {
  RETRO_AUDIT_REPORT_SCHEMA,
  RETRO_BASELINES_SCHEMA,
  collectRetroAuditReportIssues,
  collectRetroBaselinesIssues,
} from "./lib/schemas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXIT_OK = 0;
const EXIT_GATE_FAILURE = 1;
const EXIT_INVALID_INPUT = 2;

const DEFAULT_WINDOW_DAYS = 60;
const DEFAULT_MAX_QUARANTINE_DAYS = 14;
const DEFAULT_MAX_TASKS_SCAN = 500;
const DEFAULT_MAX_DECISIONS_SCAN = 500;
const DEFAULT_MAX_FACTS_SCAN = 500;
const MAX_HOT_FILES = 20;
const MIN_WHY_NOT_LENGTH = 10;

const PRIVATE_PATH_PREFIXES = Object.freeze([
  ".harness/",
  ".harness-private/",
  "harness/",
  ".retro-local/",
  ".worktrees/",
]);
const HOLLOW_WHY_NOT_MARKERS = new Set(["n/a", "na", "none", "todo", "tbd", "-", "--", "无", "暂无", "略"]);
const CLOSED_TASK_STATUSES = new Set(["done", "cancelled"]);
const CODE_PATH_PATTERN =
  /\b((?:packages|tools|scripts|docs|docs-release|schemas)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8})\b/gu;

export class AuditError extends Error {
  constructor(message, exitCode = EXIT_INVALID_INPUT, code = "audit_error") {
    super(message);
    this.name = "AuditError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

function persistUtf8FileSync(targetPath, content) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = openSync(targetPath, "w");
  try {
    writeSync(fd, content, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function normalizePosixPath(rawPath) {
  return String(rawPath ?? "")
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "");
}

function checkPrivatePathPrefix(relPath) {
  const normalized = normalizePosixPath(relPath);
  return PRIVATE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function readJsonQuiet(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function runGitReadOnly(cwd, args) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function resolveCanonicalGitRoot(repoRoot) {
  const common = runGitReadOnly(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.stdout.trim()) return path.resolve(repoRoot);
  const commonDir = path.resolve(repoRoot, common.stdout.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : path.resolve(repoRoot);
}

function discoverRemoteEdgeProjectionPath(canonicalRoot) {
  const userRoot = process.env.HARNESS_DAEMON_USER_ROOT || path.join(os.homedir(), ".harness");
  const registry = readJsonQuiet(path.join(userRoot, "registry.json"));
  const normalizedTarget = path.resolve(canonicalRoot).toLowerCase();
  const repo = (registry?.repos ?? []).find(
    (entry) =>
      typeof entry?.canonicalRoot === "string" &&
      path.resolve(entry.canonicalRoot).toLowerCase() === normalizedTarget &&
      entry.mode === "remote-edge",
  );
  if (!repo?.repoId) return null;
  const edgeCfg = readJsonQuiet(path.join(userRoot, "fleet", "edge", repo.repoId, "fleet-edge.json"));
  if (typeof edgeCfg?.viewRoot !== "string" || typeof edgeCfg?.nodeId !== "string") return null;
  const viewDir = path.join(edgeCfg.viewRoot, "repos", repo.repoId, "views", edgeCfg.nodeId);
  const current = readJsonQuiet(path.join(viewDir, "current.json"));
  if (typeof current?.id !== "string" || current.id.trim() === "") return null;
  const candidate = path.join(viewDir, "generations", current.id, ".harness", "cache", "task.sqlite");
  return existsSync(candidate) ? candidate : null;
}

function resolveProjectionPath(canonicalRoot, explicitProjectionPath) {
  if (explicitProjectionPath) {
    const resolved = path.resolve(explicitProjectionPath);
    if (!existsSync(resolved)) {
      throw new AuditError(`Projection file not found: ${resolved}`, EXIT_INVALID_INPUT, "projection_not_found");
    }
    return resolved;
  }
  const localPath = path.join(canonicalRoot, ".harness", "cache", "task.sqlite");
  if (existsSync(localPath)) {
    const reader = makeTaskProjectionReader({ rootDir: canonicalRoot, projectionPath: localPath });
    try {
      if (reader.withSession((queries) => queries.readCut().watermark) > 0) return localPath;
    } catch {
      // Fall through to remote-edge replica discovery.
    } finally {
      reader.close();
    }
  }
  return discoverRemoteEdgeProjectionPath(canonicalRoot);
}

function loadLedgerFromProjection(projectionPath, canonicalRoot, sinceIso, quarantineOwnerIds) {
  const reader = makeTaskProjectionReader({ rootDir: canonicalRoot, projectionPath });
  const tasks = [];
  const taskStatuses = {};
  let decisions = [];
  let facts = [];
  try {
    reader.withSession((queries) => {
      const taskRows = [];
      let cursor;
      while (taskRows.length < DEFAULT_MAX_TASKS_SCAN) {
        const page = queries.readTaskIndex({
          updatedAfter: sinceIso,
          limit: Math.min(200, DEFAULT_MAX_TASKS_SCAN - taskRows.length),
          ...(cursor ? { cursor } : {}),
        });
        for (const row of page.rows) {
          taskRows.push(row);
          taskStatuses[row.taskId] = row.status;
          if (taskRows.length >= DEFAULT_MAX_TASKS_SCAN) break;
        }
        if (!page.page?.nextCursor) break;
        cursor = page.page.nextCursor;
      }

      for (const row of taskRows) {
        const snap = queries.read(row.taskId, false, false).snapshot;
        if (!snap?.task) continue;
        tasks.push({
          taskId: row.taskId,
          title: snap.task.title,
          status: snap.task.status,
          iteration: snap.task.iteration ?? 1,
          createdAt: snap.task.createdAt ?? row.createdAt ?? null,
          completedAt: snap.task.completedAt ?? row.completedAt ?? null,
          executions: snap.executions ?? [],
          reviews: snap.reviews ?? [],
          gateWitnesses: snap.gateWitnesses ?? [],
        });
      }

      try {
        const decRes = queries.listDecisions({ limit: DEFAULT_MAX_DECISIONS_SCAN }, "review");
        decisions = Array.isArray(decRes?.decisions) ? [...decRes.decisions] : [];
      } catch {
        decisions = [];
      }

      try {
        const factRes = queries.searchFacts({ limit: DEFAULT_MAX_FACTS_SCAN });
        facts = Array.isArray(factRes?.facts) ? [...factRes.facts] : [];
      } catch {
        facts = [];
      }

      const extraIds = new Set(quarantineOwnerIds);
      for (const fact of facts) {
        if (typeof fact.taskId === "string" && fact.taskId.trim() !== "") extraIds.add(fact.taskId);
      }
      const missingIds = [...extraIds].filter((id) => !(id in taskStatuses));
      if (missingIds.length > 0) {
        try {
          const statusRes = queries.readTaskStatuses(missingIds);
          for (const row of statusRes?.rows ?? []) {
            if (row?.taskId && typeof row.status === "string") {
              taskStatuses[row.taskId] = row.status;
            }
          }
        } catch {
          // Leave missing statuses as unknown.
        }
      }
    });
  } finally {
    reader.close();
  }
  return { tasks, taskStatuses, decisions, facts };
}

function collectGitHotFiles(repoRoot, sinceIso) {
  const res = runGitReadOnly(repoRoot, [
    "log",
    `--since=${sinceIso}`,
    "--no-merges",
    "--name-only",
    "--pretty=format:",
    "-n",
    "300",
  ]);
  if (!res.ok) return [];
  const counts = new Map();
  for (const rawLine of res.stdout.split(/\r?\n/u)) {
    const file = normalizePosixPath(rawLine);
    if (!file || checkPrivatePathPrefix(file)) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([filePath, touchCount]) => ({ path: filePath, touchCount }))
    .sort((a, b) => b.touchCount - a.touchCount || a.path.localeCompare(b.path, "en"))
    .slice(0, MAX_HOT_FILES);
}

/** Compute nearest-rank percentile over a sorted ascending array of finite numbers. */
export function computeNearestRankPercentile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sortedValues.length);
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1));
  return Math.round(sortedValues[index]);
}

function detectTaskReworked(task) {
  if (Number.isSafeInteger(task.reworkCount) && task.reworkCount > 0) return true;
  if (Number.isSafeInteger(task.iteration) && task.iteration > 1) return true;
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  if (reviews.some((rev) => rev?.verdict === "changes_requested")) return true;
  const executions = Array.isArray(task.executions) ? task.executions : [];
  return executions.some((exec) => exec?.state === "changes_requested");
}

function extractTaskDurationMs(task) {
  if (typeof task.durationMs === "number" && Number.isFinite(task.durationMs) && task.durationMs >= 0) {
    return task.durationMs;
  }
  if (typeof task.createdAt === "string" && typeof task.completedAt === "string") {
    const start = Date.parse(task.createdAt);
    const end = Date.parse(task.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start;
    }
  }
  return null;
}

/** 1. Compute rolling task baselines (P50/P90 duration, rework rate, top-20 hot files). */
export function computeTaskBaselines(tasks, hotFilesOverride = null) {
  const list = Array.isArray(tasks) ? tasks : [];
  const durations = [];
  let completedCount = 0;
  let reworkedCount = 0;
  const fileCounts = new Map();

  for (const task of list) {
    if (!task || typeof task !== "object") continue;
    if (task.status === "done") completedCount += 1;
    if (detectTaskReworked(task)) reworkedCount += 1;
    const dur = extractTaskDurationMs(task);
    if (dur !== null) durations.push(dur);

    const touched = Array.isArray(task.touchedFiles) ? task.touchedFiles : [];
    for (const rawFile of touched) {
      const file = normalizePosixPath(rawFile);
      if (!file || checkPrivatePathPrefix(file)) continue;
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }

  durations.sort((a, b) => a - b);
  let topHotFiles;
  if (Array.isArray(hotFilesOverride) && hotFilesOverride.length > 0) {
    topHotFiles = hotFilesOverride
      .filter((item) => item && typeof item.path === "string" && !checkPrivatePathPrefix(item.path))
      .map((item) => ({ path: normalizePosixPath(item.path), touchCount: Math.max(1, Math.round(item.touchCount)) }))
      .sort((a, b) => b.touchCount - a.touchCount || a.path.localeCompare(b.path, "en"))
      .slice(0, MAX_HOT_FILES);
  } else {
    topHotFiles = [...fileCounts.entries()]
      .map(([filePath, touchCount]) => ({ path: filePath, touchCount }))
      .sort((a, b) => b.touchCount - a.touchCount || a.path.localeCompare(b.path, "en"))
      .slice(0, MAX_HOT_FILES);
  }

  return {
    sampleSize: list.length,
    completedCount,
    reworkedCount,
    p50DurationMs: computeNearestRankPercentile(durations, 50),
    p90DurationMs: computeNearestRankPercentile(durations, 90),
    reworkRate: list.length > 0 ? Number((reworkedCount / list.length).toFixed(4)) : null,
    topHotFiles,
  };
}

/** 2. Audit `tools/test-quarantine.json` for expired entries and closed `ownerTask` tombstones. */
export function auditTestQuarantineEntries(entries, taskStatuses, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const maxAgeDays = options.maxQuarantineDays ?? DEFAULT_MAX_QUARANTINE_DAYS;
  const nowMs = options.nowMs ?? Date.now();
  const expired = [];
  const closedOwnerTasks = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const parsedDate = Date.parse(`${entry.quarantinedAt}T00:00:00.000Z`);
    const ageDays = Number.isFinite(parsedDate) ? Math.floor((nowMs - parsedDate) / 86_400_000) : maxAgeDays + 1;
    if (ageDays > maxAgeDays) {
      expired.push({
        test: String(entry.test),
        ownerTask: String(entry.ownerTask),
        quarantinedAt: String(entry.quarantinedAt),
        ageDays,
        maxAgeDays,
      });
    }
    const ownerStatus = taskStatuses?.[entry.ownerTask];
    if (typeof ownerStatus === "string" && CLOSED_TASK_STATUSES.has(ownerStatus)) {
      closedOwnerTasks.push({
        test: String(entry.test),
        ownerTask: String(entry.ownerTask),
        ownerStatus,
        quarantinedAt: String(entry.quarantinedAt),
      });
    }
  }

  return {
    totalEntries: list.length,
    maxAgeDays,
    expired,
    closedOwnerTasks,
  };
}

function walkAllowlistPathNodes(value, source, field, collector) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const relPath = typeof entry?.[field] === "string" ? entry[field] : null;
      if (relPath !== null) {
        collector.push({
          source: `${source}[${index}].${field}`,
          relativePath: relPath,
          hitCount: Number.isSafeInteger(entry.hitCount) ? entry.hitCount : null,
        });
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkAllowlistPathNodes(child, `${source}.${key}`, field, collector);
    }
  }
}

function countAllowlistSectionEntries(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, child) => sum + countAllowlistSectionEntries(child), 0);
  }
  return 0;
}

function inspectFileSymbolSection(repoRoot, fileName, section, sectionValue, unreached) {
  const keys = Array.isArray(sectionValue)
    ? sectionValue.map((item) => (typeof item === "string" ? item : (item?.key ?? item?.value ?? "")))
    : sectionValue && typeof sectionValue === "object"
      ? Object.keys(sectionValue)
      : [];
  let checked = 0;
  for (const key of keys) {
    if (typeof key !== "string" || !key.includes("#")) continue;
    checked += 1;
    const [rawFile, symbol] = key.split("#");
    const relPath = normalizePosixPath(rawFile);
    const absPath = path.join(repoRoot, ...relPath.split("/"));
    if (!existsSync(absPath)) {
      unreached.push({
        file: fileName,
        section,
        entry: key,
        hitCount: 0,
        observability: "observable",
        reason: "target_file_missing",
      });
      continue;
    }
    if (symbol && symbol.trim() !== "" && !symbol.trim().startsWith("<")) {
      const body = readFileSync(absPath, "utf8");
      if (!body.includes(symbol)) {
        unreached.push({
          file: fileName,
          section,
          entry: key,
          hitCount: 0,
          observability: "observable",
          reason: "target_symbol_not_found",
        });
      }
    }
  }
  return checked;
}

/**
 * 3. Read-only `UNREACHED_ALLOW=0` audit reusing `allowlistJsonPolicies`.
 * Marks non-path gate sections that require internal gate instrumentation as `unobservable`
 * without modifying `tools/gates/*.mjs`.
 */
export function auditUnreachedAllowlists(repoRoot, options = {}) {
  const unreached = [];
  const unobservable = [];
  let observableCount = 0;
  let totalChecked = 0;

  if (Array.isArray(options.fixtureAllowlists)) {
    for (const item of options.fixtureAllowlists) {
      totalChecked += 1;
      if (item.observability === "unobservable") {
        unobservable.push({
          file: String(item.file ?? "fixture"),
          section: String(item.section ?? "entries"),
          entryCount: Number.isSafeInteger(item.entryCount) ? item.entryCount : 1,
          observability: "unobservable",
          reason: String(item.reason ?? "requires gate-internal hitCount instrumentation"),
        });
        continue;
      }
      observableCount += 1;
      const explicitZero = item.hitCount === 0;
      const missingPath =
        typeof item.relativePath === "string" &&
        !existsSync(path.join(repoRoot, ...normalizePosixPath(item.relativePath).split("/")));
      if (explicitZero || missingPath) {
        unreached.push({
          file: String(item.file ?? "fixture"),
          section: String(item.section ?? "entries"),
          entry: String(item.entry ?? item.relativePath ?? "<unnamed>"),
          hitCount: 0,
          observability: "observable",
          reason: explicitZero ? "zero_hit" : "path_not_found",
        });
      }
    }
    return {
      totalChecked,
      observableCount,
      unobservableCount: unobservable.length,
      unreached,
      unobservable,
    };
  }

  const allowlistDir = options.allowlistDir ?? path.join(repoRoot, "tools", "gate-allowlists");
  if (!existsSync(allowlistDir)) {
    return { totalChecked: 0, observableCount: 0, unobservableCount: 0, unreached: [], unobservable: [] };
  }

  const jsonFiles = readdirSync(allowlistDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const fileSymbolSections = new Set(["consumeKnownError", "catchSubstitutions", "exceptions"]);

  for (const fileName of jsonFiles) {
    const policy = allowlistJsonPolicies[fileName];
    const parsed = readJsonQuiet(path.join(allowlistDir, fileName));
    if (!policy || !parsed?.entries) continue;

    for (const [section, field] of Object.entries(policy.pathSections)) {
      const nodes = [];
      walkAllowlistPathNodes(parsed.entries[section], `${fileName}:entries.${section}`, field, nodes);
      for (const node of nodes) {
        totalChecked += 1;
        observableCount += 1;
        const absPath = path.join(repoRoot, ...normalizePosixPath(node.relativePath).split("/"));
        if (node.hitCount === 0 || !existsSync(absPath)) {
          unreached.push({
            file: fileName,
            section,
            entry: node.relativePath,
            hitCount: 0,
            observability: "observable",
            reason: node.hitCount === 0 ? "zero_hit" : "path_not_found",
          });
        }
      }
    }

    for (const section of policy.nonPathSections) {
      const sectionValue = parsed.entries[section];
      const entryCount = countAllowlistSectionEntries(sectionValue);
      if (entryCount === 0) continue;

      if (fileSymbolSections.has(section)) {
        const checked = inspectFileSymbolSection(repoRoot, fileName, section, sectionValue, unreached);
        totalChecked += checked;
        observableCount += checked;
        continue;
      }

      totalChecked += entryCount;
      unobservable.push({
        file: fileName,
        section,
        entryCount,
        observability: "unobservable",
        reason: "requires gate-internal hitCount instrumentation (not modified per CH1 read-only boundary)",
      });
    }
  }

  return {
    totalChecked,
    observableCount,
    unobservableCount: unobservable.length,
    unreached,
    unobservable,
  };
}

/** 4. Audit `closeout-readiness` gateWitness overrides for `null waiver` exposure & draft disputes. */
export function auditWaiverExposure(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const nullWaivers = [];
  const disputeDrafts = [];
  let totalWaivers = 0;
  let receiptBoundWaiverCount = 0;

  for (const task of list) {
    const witnesses = Array.isArray(task?.gateWitnesses) ? task.gateWitnesses : [];
    for (const witness of witnesses) {
      if (!witness || typeof witness !== "object" || witness.override === undefined || witness.override === null) {
        continue;
      }
      totalWaivers += 1;
      const waivedReceiptId = witness.override.waivedReceiptId ?? null;
      if (waivedReceiptId === null) {
        const actorId = witness.actor?.principal?.personId ?? "unknown";
        const entry = {
          taskId: String(task.taskId ?? witness.taskId ?? "unknown"),
          executionId: String(witness.executionId ?? "unknown"),
          gateId: String(witness.gateId ?? "unknown"),
          witnessId: String(witness.witnessId ?? witness.receiptId ?? "unknown"),
          verifiedAt: String(witness.verifiedAt ?? ""),
          actor: String(actorId),
          rationale: String(witness.override.rationale ?? ""),
        };
        nullWaivers.push(entry);
        const disputeHash = cryptoHash(
          "sha256",
          `${entry.taskId}:${entry.executionId}:${entry.gateId}:${entry.witnessId}`,
          "hex",
        ).slice(0, 10);
        disputeDrafts.push({
          disputeId: `waiver-dispute-${disputeHash}`,
          taskId: entry.taskId,
          gateId: entry.gateId,
          rationale: entry.rationale,
          recommendedAction: "verify_automated_gate_coverage_and_record_dispute",
        });
      } else {
        receiptBoundWaiverCount += 1;
      }
    }
  }

  return {
    totalWaivers,
    nullWaiverCount: nullWaivers.length,
    receiptBoundWaiverCount,
    nullWaivers,
    disputeDrafts,
  };
}

/** 5. Audit high-risk / standing-policy Decisions for missing or hollow `rejected[].whyNot`. */
export function auditDecisionWhyNot(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const hollowDecisions = [];
  let highRiskAudited = 0;

  for (const decision of list) {
    if (!decision || typeof decision !== "object") continue;
    if (decision.state === "draft" || decision.state === "rejected" || decision.state === "superseded") {
      continue;
    }
    const elevatedRisk = decision.riskTier === "high" || decision.decisionClass === "standing_policy";
    if (!elevatedRisk) continue;
    highRiskAudited += 1;

    const issues = [];
    const rejected = Array.isArray(decision.rejected) ? decision.rejected : [];
    if (rejected.length === 0) {
      issues.push("missing_rejected_alternatives");
    } else {
      for (const [index, alt] of rejected.entries()) {
        const trimmedWhyNot = typeof alt?.whyNot === "string" ? alt.whyNot.trim() : "";
        if (trimmedWhyNot.length < MIN_WHY_NOT_LENGTH || HOLLOW_WHY_NOT_MARKERS.has(trimmedWhyNot.toLowerCase())) {
          issues.push(`hollow_why_not:${alt?.id ?? `rejected[${index}]`}`);
        }
      }
    }

    if (issues.length > 0) {
      hollowDecisions.push({
        decisionId: String(decision.decisionId ?? "unknown"),
        title: String(decision.title ?? ""),
        riskTier: String(decision.riskTier ?? "unknown"),
        decisionClass: String(decision.decisionClass ?? "ordinary"),
        state: String(decision.state ?? "unknown"),
        issues,
      });
    }
  }

  return {
    totalAudited: list.length,
    highRiskAudited,
    hollowDecisions,
  };
}

function extractFactReferencedPaths(fact) {
  const candidates = new Set();
  const sources = [
    fact.evidenceSource,
    fact.source,
    fact.statement,
    ...(Array.isArray(fact.anchors) ? fact.anchors : []),
  ];
  for (const item of sources) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const regex = new RegExp(CODE_PATH_PATTERN.source, CODE_PATH_PATTERN.flags);
    for (const match of item.matchAll(regex)) {
      if (match[1]) candidates.add(normalizePosixPath(match[1]));
    }
  }
  return [...candidates].sort();
}

/** 6. Audit active/standing Facts for unfinalized source tasks or dangling repository paths. */
export function auditFactContagion(facts, taskStatuses, repoRoot) {
  const list = Array.isArray(facts) ? facts : [];
  const flags = [];
  let totalAudited = 0;

  for (const fact of list) {
    if (!fact || typeof fact !== "object") continue;
    if (
      fact.archived === true ||
      fact.invalidated === true ||
      fact.state === "archived" ||
      fact.state === "invalidated"
    ) {
      continue;
    }
    totalAudited += 1;

    const factFlags = [];
    const taskId = typeof fact.taskId === "string" && fact.taskId.trim() !== "" ? fact.taskId.trim() : null;
    const taskStatus = taskId ? (taskStatuses?.[taskId] ?? "unknown") : null;
    if (taskId && taskStatus !== "done") {
      factFlags.push("unfinalized_source_task");
    }

    const danglingPaths = [];
    for (const relPath of extractFactReferencedPaths(fact)) {
      if (!existsSync(path.join(repoRoot, ...relPath.split("/")))) {
        danglingPaths.push(relPath);
      }
    }
    if (danglingPaths.length > 0) {
      factFlags.push("dangling_code_path");
    }

    if (factFlags.length > 0) {
      flags.push({
        factId: String(fact.factId ?? "unknown"),
        taskId,
        taskStatus,
        flags: factFlags,
        danglingPaths,
        statementPreview: String(fact.statement ?? "").slice(0, 140),
      });
    }
  }

  return {
    totalAudited,
    flaggedCount: flags.length,
    flags,
  };
}

/** Build a sanitized `retro-baselines/v1` document guaranteed to have 0 private path/ID leaks. */
export function buildSanitizedBaselinesDocument(taskBaselines, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const sanitizedHotFiles = (taskBaselines.topHotFiles ?? [])
    .filter((entry) => entry && typeof entry.path === "string" && !checkPrivatePathPrefix(entry.path))
    .map((entry) => ({
      path: sanitizeText(normalizePosixPath(entry.path)),
      touchCount: entry.touchCount,
    }))
    .slice(0, MAX_HOT_FILES);

  const doc = {
    schema: RETRO_BASELINES_SCHEMA,
    version: 1,
    generatedAt,
    windowDays,
    metrics: {
      sampleSize: taskBaselines.sampleSize,
      completedCount: taskBaselines.completedCount,
      reworkedCount: taskBaselines.reworkedCount,
      p50DurationMs: taskBaselines.p50DurationMs,
      p90DurationMs: taskBaselines.p90DurationMs,
      reworkRate: taskBaselines.reworkRate,
    },
    topHotFiles: sanitizedHotFiles,
  };

  rejectPrivateLeakage(doc, RETRO_BASELINES_SCHEMA);
  const issues = collectRetroBaselinesIssues(doc);
  if (issues.length > 0) {
    throw new AuditError(`Generated baselines failed schema validation:\n- ${issues.join("\n- ")}`, EXIT_GATE_FAILURE);
  }
  return doc;
}

/** Run the full offline read-only retro audit (live repo/projection or fixture snapshot). */
export function runAudit(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxQuarantineDays = options.maxQuarantineDays ?? DEFAULT_MAX_QUARANTINE_DAYS;
  const strict = options.strict === true;
  const nowDate = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(nowDate.getTime())) {
    throw new AuditError(`Invalid --now timestamp: ${String(options.now)}`, EXIT_INVALID_INPUT, "invalid_now");
  }
  const nowMs = nowDate.getTime();
  const generatedAt = nowDate.toISOString();
  const sinceIso = new Date(nowMs - windowDays * 86_400_000).toISOString();

  let tasks = [];
  let taskStatuses = {};
  let decisions = [];
  let facts = [];
  let quarantineEntries;
  let hotFilesOverride = null;
  let fixtureAllowlists = null;

  if (options.snapshot) {
    const snap = options.snapshot;
    tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
    taskStatuses = { ...(snap.taskStatuses ?? {}) };
    for (const task of tasks) {
      if (task?.taskId && task?.status && !(task.taskId in taskStatuses)) {
        taskStatuses[task.taskId] = task.status;
      }
    }
    decisions = Array.isArray(snap.decisions) ? snap.decisions : [];
    facts = Array.isArray(snap.facts) ? snap.facts : [];
    quarantineEntries = Array.isArray(snap.quarantine) ? snap.quarantine : [];
    if (Array.isArray(snap.hotFiles)) hotFilesOverride = snap.hotFiles;
    if (Array.isArray(snap.allowlists)) fixtureAllowlists = snap.allowlists;
  } else {
    quarantineEntries = options.quarantinePath
      ? (JSON.parse(readFileSync(path.resolve(options.quarantinePath), "utf8")).tests ?? [])
      : existsSync(path.join(repoRoot, "tools", "test-quarantine.json"))
        ? readTestQuarantine(repoRoot)
        : [];

    const canonicalRoot = resolveCanonicalGitRoot(repoRoot);
    const projectionPath = resolveProjectionPath(canonicalRoot, options.projectionPath);
    if (projectionPath) {
      const ledger = loadLedgerFromProjection(
        projectionPath,
        canonicalRoot,
        sinceIso,
        quarantineEntries.map((entry) => entry.ownerTask).filter(Boolean),
      );
      tasks = ledger.tasks;
      taskStatuses = ledger.taskStatuses;
      decisions = ledger.decisions;
      facts = ledger.facts;
    }
    hotFilesOverride = collectGitHotFiles(repoRoot, sinceIso);
  }

  const taskBaselines = computeTaskBaselines(tasks, hotFilesOverride);
  const quarantineAudit = auditTestQuarantineEntries(quarantineEntries, taskStatuses, { maxQuarantineDays, nowMs });
  const unreachedAllowlists = auditUnreachedAllowlists(repoRoot, {
    allowlistDir: options.allowlistDir,
    fixtureAllowlists,
  });
  const waiverExposure = auditWaiverExposure(tasks);
  const decisionWhyNotAudit = auditDecisionWhyNot(decisions);
  const factContagionFlags = auditFactContagion(facts, taskStatuses, repoRoot);

  const strictViolations = quarantineAudit.expired.length + unreachedAllowlists.unreached.length;
  const report = {
    schema: RETRO_AUDIT_REPORT_SCHEMA,
    version: 1,
    generatedAt,
    windowDays,
    strict,
    summary: {
      expiredQuarantineCount: quarantineAudit.expired.length,
      closedOwnerQuarantineCount: quarantineAudit.closedOwnerTasks.length,
      unreachedAllowlistCount: unreachedAllowlists.unreached.length,
      unobservableAllowlistCount: unreachedAllowlists.unobservable.length,
      nullWaiverCount: waiverExposure.nullWaiverCount,
      hollowDecisionCount: decisionWhyNotAudit.hollowDecisions.length,
      contagiousFactCount: factContagionFlags.flaggedCount,
      strictViolations,
    },
    taskBaselines,
    quarantineAudit,
    unreachedAllowlists,
    waiverExposure,
    decisionWhyNotAudit,
    factContagionFlags,
  };

  const reportIssues = collectRetroAuditReportIssues(report);
  if (reportIssues.length > 0) {
    throw new AuditError(`Audit report failed schema validation:\n- ${reportIssues.join("\n- ")}`, EXIT_GATE_FAILURE);
  }

  let baselinesDoc = null;
  let baselinesPath = null;
  if (options.emitBaselines) {
    baselinesDoc = buildSanitizedBaselinesDocument(taskBaselines, { generatedAt, windowDays });
    if (typeof options.emitBaselines === "string") {
      baselinesPath = path.resolve(options.emitBaselines);
      persistUtf8FileSync(baselinesPath, `${JSON.stringify(baselinesDoc, null, 2)}\n`);
    }
  }

  let reportPath = null;
  if (typeof options.outPath === "string" && options.outPath.trim() !== "") {
    reportPath = path.resolve(options.outPath);
    persistUtf8FileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const exitCode = strict && strictViolations > 0 ? EXIT_GATE_FAILURE : EXIT_OK;
  return { report, baselinesDoc, baselinesPath, reportPath, exitCode };
}

export function formatAuditHelp() {
  return [
    "Usage: node tools/retro/cli.mjs audit [options]",
    "",
    "Options:",
    "  --repo-root <path>            Repository root (default: current repo)",
    "  --projection <path>           Explicit read-only task.sqlite projection path",
    "  --snapshot <path>             Offline JSON fixture snapshot for deterministic testing",
    "  --since-days <n>              Rolling baseline window in days (default: 60)",
    "  --max-quarantine-days <n>     Max allowed age for test-quarantine entries (default: 14)",
    "  --now <iso>                   Override current timestamp (ISO-8601)",
    "  --strict                      Exit 1 if expired quarantine or UNREACHED_ALLOW > 0",
    "  --emit-baselines <path>       Emit sanitized retro-baselines/v1 JSON to path",
    "  --out <path>                  Write retro-audit-report/v1 JSON to path",
    "  -h, --help                    Show this help text",
  ].join("\n");
}

function parsePositiveIntegerFlag(raw, name) {
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new AuditError(`Invalid ${name} value: ${String(raw)} (expected positive integer)`, EXIT_INVALID_INPUT);
  }
  return num;
}

export async function runAuditCli(argv = [], io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "repo-root": { type: "string" },
        projection: { type: "string" },
        snapshot: { type: "string" },
        "since-days": { type: "string" },
        "max-quarantine-days": { type: "string" },
        now: { type: "string" },
        strict: { type: "boolean", default: false },
        "emit-baselines": { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT_INVALID_INPUT;
  }

  const vals = parsed.values;
  if (vals.help) {
    stdout(formatAuditHelp());
    return EXIT_OK;
  }

  try {
    const windowDays = vals["since-days"]
      ? parsePositiveIntegerFlag(vals["since-days"], "--since-days")
      : DEFAULT_WINDOW_DAYS;
    const maxQuarantineDays = vals["max-quarantine-days"]
      ? parsePositiveIntegerFlag(vals["max-quarantine-days"], "--max-quarantine-days")
      : DEFAULT_MAX_QUARANTINE_DAYS;
    let snapshot = null;
    if (vals.snapshot) {
      const snapPath = path.resolve(vals.snapshot);
      if (!existsSync(snapPath)) {
        throw new AuditError(`Snapshot file not found: ${snapPath}`, EXIT_INVALID_INPUT, "snapshot_not_found");
      }
      snapshot = JSON.parse(readFileSync(snapPath, "utf8"));
    }

    const result = runAudit({
      repoRoot: vals["repo-root"],
      projectionPath: vals.projection,
      snapshot,
      windowDays,
      maxQuarantineDays,
      now: vals.now,
      strict: vals.strict,
      emitBaselines: vals["emit-baselines"] || false,
      outPath: vals.out,
    });
    stdout(JSON.stringify(result.report, null, 2));
    return result.exitCode;
  } catch (error) {
    if (error instanceof SanitizeError) {
      stderr(error.message);
      return EXIT_GATE_FAILURE;
    }
    if (error instanceof AuditError) {
      stderr(error.message);
      return error.exitCode;
    }
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT_GATE_FAILURE;
  }
}
