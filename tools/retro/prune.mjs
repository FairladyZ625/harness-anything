/**
 * Offline read-only rule, allowlist, quarantine, and fact retirement proposal generator.
 *
 * Implements dec_D8EECF29C93D0C300252060A10 (CH1, CH4):
 * - Consumes a `retro-audit-report/v1` document (from `--audit` or in-memory `runAudit`) and
 *   optional recent `retro-eval-report/v1` history (`--eval-history`).
 * - Emits a structured `retro-prune-plan/v1` JSON proposal without mutating any repository
 *   files, allowlists, quarantine files, markdown rules, or ledger entities.
 */
import { hash as cryptoHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAudit } from "./audit.mjs";
import {
  RETRO_AUDIT_REPORT_SCHEMA,
  RETRO_EVAL_REPORT_SCHEMA,
  RETRO_PRUNE_PLAN_SCHEMA,
  VALID_PRUNE_ACTIONS,
  VALID_PRUNE_PRIORITIES,
  collectRetroAuditReportIssues,
  collectRetroPrunePlanIssues,
} from "./lib/schemas.mjs";

const EXIT_OK = 0;
const EXIT_GATE_FAILURE = 1;
const EXIT_INVALID_INPUT = 2;

export class PruneError extends Error {
  constructor(message, exitCode = EXIT_INVALID_INPUT, code = "prune_error") {
    super(message);
    this.name = "PruneError";
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

function shortProposalId(prefix, key) {
  const digest = cryptoHash("sha256", `${prefix}:${key}`, "hex").slice(0, 10);
  return `${prefix}-${digest}`;
}

function parseJsonFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new PruneError(`${label} not found: ${resolved}`, EXIT_INVALID_INPUT, "file_not_found");
  }
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PruneError(`Failed to parse ${label} (${resolved}): ${detail}`, EXIT_INVALID_INPUT, "invalid_json");
  }
}

function loadEvalReportsFromPaths(paths) {
  const reports = [];
  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath);
    if (!existsSync(resolved)) {
      throw new PruneError(`Eval history path not found: ${resolved}`, EXIT_INVALID_INPUT, "eval_history_not_found");
    }
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const files = readdirSync(resolved)
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const file of files) {
        const doc = parseJsonFile(path.join(resolved, file), `eval report ${file}`);
        if (doc?.schema === RETRO_EVAL_REPORT_SCHEMA) {
          reports.push(doc);
        }
      }
    } else {
      const doc = parseJsonFile(resolved, "eval report");
      if (doc?.schema !== RETRO_EVAL_REPORT_SCHEMA) {
        throw new PruneError(
          `Expected ${RETRO_EVAL_REPORT_SCHEMA} in ${resolved}, got ${String(doc?.schema)}`,
          EXIT_INVALID_INPUT,
          "invalid_eval_report",
        );
      }
      reports.push(doc);
    }
  }
  return reports;
}

function buildStaleRuleProposals(evalReports) {
  if (!Array.isArray(evalReports) || evalReports.length < 2) return [];
  const categoryStats = new Map();

  for (const report of evalReports) {
    const outcomes = Array.isArray(report?.outcomes) ? report.outcomes : [];
    const seenCategories = new Set();
    for (const outcome of outcomes) {
      const category =
        typeof outcome?.category === "string" && outcome.category.trim() !== "" ? outcome.category : null;
      if (!category) continue;
      if (!categoryStats.has(category)) {
        categoryStats.set(category, { reportsSeen: 0, positiveHits: 0, falsePositives: 0 });
      }
      const stat = categoryStats.get(category);
      if (!seenCategories.has(category)) {
        stat.reportsSeen += 1;
        seenCategories.add(category);
      }
      if (outcome.bucket === "positive" && outcome.outcome === "pass") {
        stat.positiveHits += 1;
      }
      if ((outcome.bucket === "negative" || outcome.bucket === "clean-control") && outcome.outcome === "fail") {
        stat.falsePositives += 1;
      }
    }
  }

  const proposals = [];
  for (const [category, stat] of [...categoryStats.entries()].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
    if (stat.reportsSeen >= 2 && stat.positiveHits === 0) {
      proposals.push({
        proposalId: shortProposalId("prune-rule", category),
        action: "retire_stale_rule",
        priority: stat.falsePositives > 0 ? "medium" : "low",
        target: `rule-category:${category}`,
        reason:
          stat.falsePositives > 0
            ? `Category "${category}" had 0 positive catches and ${stat.falsePositives} false positives across ${stat.reportsSeen} eval reports.`
            : `Category "${category}" had 0 positive catches across ${stat.reportsSeen} consecutive eval reports.`,
        evidence: {
          reportsSeen: stat.reportsSeen,
          positiveHits: stat.positiveHits,
          falsePositives: stat.falsePositives,
        },
        recommendedCommand: "Review and retire or tighten corresponding semantic rule in a dedicated PR",
      });
    }
  }
  return proposals;
}

/** Generate a strictly read-only `retro-prune-plan/v1` proposal from an audit report and optional eval history. */
export function buildPrunePlan(auditReport, evalReports = [], options = {}) {
  const auditIssues = collectRetroAuditReportIssues(auditReport);
  if (auditIssues.length > 0) {
    throw new PruneError(
      `Invalid audit report:\n- ${auditIssues.join("\n- ")}`,
      EXIT_INVALID_INPUT,
      "invalid_audit_report",
    );
  }

  const generatedAt = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const proposals = [];
  const seenQuarantine = new Set();

  for (const entry of auditReport.quarantineAudit.expired) {
    seenQuarantine.add(entry.test);
    proposals.push({
      proposalId: shortProposalId("prune-quarantine", entry.test),
      action: "remove_quarantine",
      priority: "high",
      target: `tools/test-quarantine.json#${entry.test}`,
      reason: `Quarantined test "${entry.test}" exceeded max age (${entry.ageDays}d > ${entry.maxAgeDays}d; ownerTask=${entry.ownerTask}).`,
      evidence: entry,
      recommendedCommand: `Re-enable or fix test "${entry.test}" and remove entry from tools/test-quarantine.json in a PR`,
    });
  }

  for (const entry of auditReport.quarantineAudit.closedOwnerTasks) {
    if (seenQuarantine.has(entry.test)) continue;
    seenQuarantine.add(entry.test);
    proposals.push({
      proposalId: shortProposalId("prune-quarantine", entry.test),
      action: "remove_quarantine",
      priority: "high",
      target: `tools/test-quarantine.json#${entry.test}`,
      reason: `Owner task ${entry.ownerTask} is already ${entry.ownerStatus}, leaving stale quarantine tombstone for "${entry.test}".`,
      evidence: entry,
      recommendedCommand: `Remove stale quarantine entry for "${entry.test}" from tools/test-quarantine.json in a PR`,
    });
  }

  for (const entry of auditReport.unreachedAllowlists.unreached) {
    const target = `tools/gate-allowlists/${entry.file}:${entry.section}:${entry.entry}`;
    proposals.push({
      proposalId: shortProposalId("prune-allowlist", target),
      action: "remove_allowlist_entry",
      priority: "high",
      target,
      reason: `Allowlist entry "${entry.entry}" in ${entry.file} (${entry.section}) has hitCount=0 (${entry.reason}).`,
      evidence: entry,
      recommendedCommand: `Remove unreached entry "${entry.entry}" from tools/gate-allowlists/${entry.file} in a PR`,
    });
  }

  for (const waiver of auditReport.waiverExposure.nullWaivers) {
    const target = `${waiver.taskId}/${waiver.executionId}/${waiver.gateId}`;
    proposals.push({
      proposalId: shortProposalId("prune-waiver", target),
      action: "review_waiver_dispute",
      priority: "medium",
      target,
      reason: `Gate "${waiver.gateId}" on ${waiver.taskId} passed via null waiver without automated receipt.`,
      evidence: waiver,
      recommendedCommand: `Audit null waiver on ${waiver.taskId} (${waiver.gateId}) and record follow-up remediation if needed`,
    });
  }

  for (const decision of auditReport.decisionWhyNotAudit.hollowDecisions) {
    proposals.push({
      proposalId: shortProposalId("prune-decision", decision.decisionId),
      action: "enrich_decision_whynot",
      priority: "medium",
      target: `decision/${decision.decisionId}`,
      reason: `Elevated-risk decision ${decision.decisionId} (${decision.riskTier}/${decision.decisionClass}) has hollow rejected.whyNot: ${decision.issues.join(", ")}.`,
      evidence: decision,
      recommendedCommand: `Amend decision ${decision.decisionId} with concrete rejected alternatives and whyNot rationale`,
    });
  }

  for (const flag of auditReport.factContagionFlags.flags) {
    const bothFlags = flag.flags.length >= 2;
    proposals.push({
      proposalId: shortProposalId("prune-fact", flag.factId),
      action: "quarantine_or_archive_fact",
      priority: bothFlags ? "high" : "medium",
      target: `fact/${flag.factId}`,
      reason: `Standing fact ${flag.factId} flagged for contagion risk: ${flag.flags.join(", ")}.`,
      evidence: flag,
      recommendedCommand: `Review and archive or re-verify fact ${flag.factId} via ha fact workflow`,
    });
  }

  proposals.push(...buildStaleRuleProposals(evalReports));

  const byAction = Object.fromEntries(VALID_PRUNE_ACTIONS.map((action) => [action, 0]));
  const byPriority = Object.fromEntries(VALID_PRUNE_PRIORITIES.map((priority) => [priority, 0]));
  for (const proposal of proposals) {
    if (proposal.action in byAction) byAction[proposal.action] += 1;
    if (proposal.priority in byPriority) byPriority[proposal.priority] += 1;
  }

  const plan = {
    schema: RETRO_PRUNE_PLAN_SCHEMA,
    version: 1,
    generatedAt,
    readOnly: true,
    sources: {
      auditSchema: auditReport.schema ?? RETRO_AUDIT_REPORT_SCHEMA,
      auditGeneratedAt: auditReport.generatedAt,
      evalReportCount: Array.isArray(evalReports) ? evalReports.length : 0,
    },
    summary: {
      totalProposals: proposals.length,
      byAction,
      byPriority,
    },
    proposals,
  };

  const issues = collectRetroPrunePlanIssues(plan);
  if (issues.length > 0) {
    throw new PruneError(`Generated prune plan failed schema validation:\n- ${issues.join("\n- ")}`, EXIT_GATE_FAILURE);
  }
  return plan;
}

export function formatPruneHelp() {
  return [
    "Usage: node tools/retro/cli.mjs prune [options]",
    "",
    "Options:",
    "  --audit <path>          Path to retro-audit-report/v1 JSON (if omitted, runs live read-only audit)",
    "  --eval-history <path>   Path to retro-eval-report/v1 JSON or directory (repeatable)",
    "  --repo-root <path>      Repository root when running live audit (default: current repo)",
    "  --out <path>            Write retro-prune-plan/v1 JSON to explicit path (default: stdout only)",
    "  -h, --help              Show this help text",
  ].join("\n");
}

export async function runPruneCli(argv = [], io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        audit: { type: "string" },
        "eval-history": { type: "string", multiple: true },
        "repo-root": { type: "string" },
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
    stdout(formatPruneHelp());
    return EXIT_OK;
  }

  try {
    const auditReport = vals.audit
      ? parseJsonFile(vals.audit, "audit report")
      : runAudit({ repoRoot: vals["repo-root"], strict: false }).report;
    const evalReports = vals["eval-history"] ? loadEvalReportsFromPaths(vals["eval-history"]) : [];
    const plan = buildPrunePlan(auditReport, evalReports);

    const rendered = `${JSON.stringify(plan, null, 2)}\n`;
    if (vals.out) {
      persistUtf8FileSync(path.resolve(vals.out), rendered);
    }
    stdout(rendered.trimEnd());
    return EXIT_OK;
  } catch (error) {
    if (error instanceof PruneError) {
      stderr(error.message);
      return error.exitCode;
    }
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT_GATE_FAILURE;
  }
}
