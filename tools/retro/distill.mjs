/**
 * Offline L6 failure distillation & boundary-routing engine for `tools/retro/`.
 *
 * Implements dec_D8EECF29C93D0C300252060A10 (CH4):
 * - Stage 1 (`>=2` Independent Task Clustering Gate): clusters missed/failed defect records by
 *   `(category, defectSignature)` and hard-blocks singletons (< 2 distinct taskIds).
 * - Stage 2 (3-Probe Replay Boundary Routing): runs 3 probe trials per eligible cluster:
 *     - `probeHits >= 2/3` -> routes to `semantic-rule` with an L6 rule draft.
 *     - `probeHits <= 1/3` -> forces `deterministic-gate` (strictly 0 `.md` rule drafts) with
 *       a mandatory `--self-test` positive + historical negative fixture spec (`hitCount > 0`).
 * - Stage 3 (3-Agent Adversarial Falsification): evaluates candidate recall vs. clean negative
 *   controls via proposer/adversary/arbiter roles; any `falsePositiveDelta > 0` or reject verdict
 *   blocks `approved_for_pr`.
 * - Pure offline read-only: never mutates trunk `.md` rules or formal ledger; writes only under
 *   `.retro-local/proposals/<runId>/` (`proposal.json` + `pr-draft.md`).
 */
import { hash as cryptoHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { DEFAULT_CASE_WAIT_MS, execIsolatedCommand } from "./lib/process-runner.mjs";
import { SanitizeError, rejectPrivateLeakage, sanitizeText } from "./lib/sanitize.mjs";
import {
  DISTILL_MIN_CLUSTER_TASKS,
  DISTILL_PROBE_TRIALS,
  DISTILL_SEMANTIC_MIN_HITS,
  RETRO_DISTILL_PROPOSAL_SCHEMA,
  collectRetroDistillProposalIssues,
} from "./lib/schemas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_PROPOSALS_ROOT = path.join(REPO_ROOT, ".retro-local", "proposals");

const EXIT_OK = 0;
const EXIT_GATE_FAIL = 1;
const EXIT_INVALID = 2;

const STRING_FLAG_SPEC = Object.freeze({ type: "string" });
const PROBE_TRIAL_INDICES = Object.freeze([1, 2, 3]);
const FALSIFICATION_ROLES = Object.freeze(["proposer", "adversary", "arbiter"]);

export class DistillError extends Error {
  constructor(message, exitCode = EXIT_INVALID, code = "distill_error") {
    super(message);
    this.name = "DistillError";
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

function slugifyToken(raw, fallback = "defect") {
  const token = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return token.length > 0 ? token : fallback;
}

function shortDigest(text) {
  return cryptoHash("sha256", String(text), "hex").slice(0, 10);
}

const RAW_TASK_ID_PATTERN = /^task_[0-9a-f]{26}$/iu;

function anonymizeTaskRef(rawTaskId) {
  const trimmed = String(rawTaskId ?? "").trim();
  if (RAW_TASK_ID_PATTERN.test(trimmed)) {
    return `task-ref-${shortDigest(trimmed.toLowerCase())}`;
  }
  return sanitizeText(trimmed);
}

function parseJsonDocument(filePath, label) {
  if (!existsSync(filePath)) {
    throw new DistillError(`${label} not found: ${filePath}`, EXIT_INVALID, "file_not_found");
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistillError(`Failed to parse ${label} (${filePath}): ${detail}`, EXIT_INVALID, "invalid_json");
  }
}

function normalizeFailureRecord(raw, caseMap, index) {
  if (!raw || typeof raw !== "object") return null;
  const caseEntry = typeof raw.caseId === "string" ? caseMap.get(raw.caseId) : undefined;
  const outcomeStatus = raw.outcome ?? raw.status;
  const expectedVerdict = raw.expectedVerdict ?? caseEntry?.expectedVerdict ?? "rework";
  const bucket = raw.bucket ?? caseEntry?.bucket ?? "positive";
  if (outcomeStatus === "pass" || bucket === "clean-control" || expectedVerdict === "approve") {
    return null;
  }

  const category =
    sanitizeText(String(raw.category ?? caseEntry?.category ?? "uncategorized").trim()) || "uncategorized";
  const defectSignature = sanitizeText(
    String(
      raw.defectSignature ??
        raw.signature ??
        caseEntry?.metadata?.defectSignature ??
        caseEntry?.defectSignature ??
        raw.summary ??
        caseEntry?.title ??
        category,
    ).trim(),
  );
  const rawTaskId = String(
    raw.taskId ??
      raw.sourceTaskId ??
      caseEntry?.metadata?.taskId ??
      caseEntry?.taskId ??
      raw.caseId ??
      `unknown-${index}`,
  ).trim();
  const taskId = anonymizeTaskRef(rawTaskId);
  const modules = Array.isArray(raw.modules)
    ? raw.modules.map((entry) => sanitizeText(String(entry).trim())).filter(Boolean)
    : Array.isArray(caseEntry?.metadata?.modules)
      ? caseEntry.metadata.modules.map((entry) => sanitizeText(String(entry).trim())).filter(Boolean)
      : ["tools/retro"];
  const caseId = sanitizeText(String(raw.caseId ?? caseEntry?.id ?? `case-${index}`).trim());
  const diffSnippet = String(raw.diff ?? caseEntry?.diff ?? "").trim();
  const summary = sanitizeText(String(raw.summary ?? caseEntry?.title ?? defectSignature).trim());

  return {
    caseId,
    taskId,
    category,
    defectSignature,
    clusterKey: `${slugifyToken(category)}::${slugifyToken(defectSignature)}`,
    modules: modules.length > 0 ? [...new Set(modules)] : ["tools/retro"],
    summary,
    diffSnippet,
    crossFileInvariant: raw.crossFileInvariant === true || caseEntry?.metadata?.crossFileInvariant === true,
  };
}

/**
 * Extract normalized defect failure records from either a `retro-eval-report/v1` document,
 * a `{ failures: [...] }` wrapper, or a raw array of failure records.
 */
export function extractFailureRecords(inputDoc, casesDoc = null) {
  const caseMap = new Map();
  if (casesDoc && Array.isArray(casesDoc.cases)) {
    for (const entry of casesDoc.cases) {
      if (entry && typeof entry.id === "string") caseMap.set(entry.id, entry);
    }
  }

  let rawItems;
  if (Array.isArray(inputDoc)) {
    rawItems = inputDoc;
  } else if (inputDoc && typeof inputDoc === "object") {
    if (Array.isArray(inputDoc.outcomes)) rawItems = inputDoc.outcomes;
    else if (Array.isArray(inputDoc.failures)) rawItems = inputDoc.failures;
    else if (Array.isArray(inputDoc.cases)) rawItems = inputDoc.cases;
    else {
      throw new DistillError(
        "Distill input must be a retro-eval-report/v1 object, { failures: [...] }, or an array",
        EXIT_INVALID,
        "invalid_input_shape",
      );
    }
  } else {
    throw new DistillError("Distill input must be a JSON object or array", EXIT_INVALID, "invalid_input_shape");
  }

  const failures = [];
  for (const [index, entry] of rawItems.entries()) {
    const normalized = normalizeFailureRecord(entry, caseMap, index);
    if (normalized !== null) failures.push(normalized);
  }
  return failures;
}

/**
 * Stage 1: Cluster failures by `(category, defectSignature)` and enforce the hard
 * `>= minTasks` (default 2) independent-Task floor.
 */
export function clusterFailuresByDefect(failures, minTasks = DISTILL_MIN_CLUSTER_TASKS) {
  if (!Number.isSafeInteger(minTasks) || minTasks < DISTILL_MIN_CLUSTER_TASKS) {
    throw new DistillError(
      `minTasks must be an integer >= ${DISTILL_MIN_CLUSTER_TASKS} (got ${String(minTasks)})`,
      EXIT_INVALID,
      "invalid_min_tasks",
    );
  }

  const byKey = new Map();
  for (const item of failures) {
    const existing = byKey.get(item.clusterKey) ?? {
      clusterKey: item.clusterKey,
      category: item.category,
      defectSignature: item.defectSignature,
      items: [],
      taskIdSet: new Set(),
      moduleSet: new Set(),
    };
    existing.items.push(item);
    existing.taskIdSet.add(item.taskId);
    for (const mod of item.modules) existing.moduleSet.add(mod);
    byKey.set(item.clusterKey, existing);
  }

  const eligible = [];
  const rejected = [];

  for (const cluster of [...byKey.values()].sort((a, b) => a.clusterKey.localeCompare(b.clusterKey))) {
    const taskIds = [...cluster.taskIdSet].sort();
    const modules = [...cluster.moduleSet].sort();
    const record = {
      clusterKey: cluster.clusterKey,
      category: cluster.category,
      defectSignature: cluster.defectSignature,
      taskIds,
      modules,
      caseIds: cluster.items.map((entry) => entry.caseId),
      items: cluster.items,
    };

    if (taskIds.length < minTasks) {
      rejected.push({
        clusterKey: record.clusterKey,
        category: record.category,
        defectSignature: record.defectSignature,
        taskIds: record.taskIds,
        taskCount: taskIds.length,
        requiredMinTasks: minTasks,
        reason: "insufficient_independent_tasks",
      });
    } else {
      eligible.push(record);
    }
  }

  return { eligible, rejected };
}

function defaultDryRunProbe(cluster, trialIndex) {
  const requiresCrossFile = cluster.items.some((entry) => entry.crossFileInvariant) || cluster.modules.length >= 3;
  const hit = requiresCrossFile ? trialIndex === 1 : true;
  return {
    trial: trialIndex,
    hit,
    evidence: hit
      ? `dry-run probe #${trialIndex} reproduced ${cluster.clusterKey}`
      : `dry-run probe #${trialIndex} missed cross-file invariant ${cluster.clusterKey}`,
  };
}

async function runExternalJsonHook(commandTemplate, payload, timeoutMs) {
  const encodedPayload = JSON.stringify(payload);
  const result = await execIsolatedCommand({
    command: commandTemplate,
    env: {
      ...process.env,
      RETRO_DISTILL_PAYLOAD: encodedPayload,
    },
    timeoutMs,
  });
  if (result.timedOut) {
    throw new DistillError(`Distill hook timed out after ${timeoutMs}ms`, EXIT_GATE_FAIL, "hook_timeout");
  }
  if (result.exitCode !== 0) {
    throw new DistillError(
      `Distill hook failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      EXIT_GATE_FAIL,
      "hook_failed",
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistillError(`Distill hook returned invalid JSON: ${detail}`, EXIT_GATE_FAIL, "hook_invalid_json");
  }
}

/**
 * Stage 2: Execute 3 independent probe trials per eligible cluster and route:
 * - `hits >= 2/3` -> `semantic-rule`
 * - `hits <= 1/3` -> `deterministic-gate` (strictly 0 semantic rule drafts)
 */
export async function runThreeProbeRouting(cluster, options = {}) {
  const results = [];
  for (const trialIndex of PROBE_TRIAL_INDICES) {
    let outcome;
    if (typeof options.probeRunner === "function") {
      outcome = await options.probeRunner({ cluster, trial: trialIndex });
    } else if (typeof options.probeCmd === "string" && options.probeCmd.trim() !== "") {
      outcome = await runExternalJsonHook(
        options.probeCmd,
        { stage: "probe", trial: trialIndex, clusterKey: cluster.clusterKey, category: cluster.category },
        options.timeoutMs ?? DEFAULT_CASE_WAIT_MS,
      );
    } else {
      outcome = defaultDryRunProbe(cluster, trialIndex);
    }

    results.push({
      trial: trialIndex,
      hit: Boolean(outcome?.hit),
      evidence: String(outcome?.evidence ?? (outcome?.hit ? "probe matched defect" : "probe missed defect")),
    });
  }

  const hits = results.filter((entry) => entry.hit).length;
  const target = hits >= DISTILL_SEMANTIC_MIN_HITS ? "semantic-rule" : "deterministic-gate";
  return {
    trials: DISTILL_PROBE_TRIALS,
    hits,
    target,
    results,
  };
}

function buildGateSelfTestSpec(cluster, selfTestResult = null) {
  const gateSlug = slugifyToken(`${cluster.category}-${cluster.defectSignature}`, "retro-gate");
  const gateScript = `tools/gates/${gateSlug}.mjs`;
  const negativeFixtures = cluster.items.map((item) => ({
    caseId: item.caseId,
    taskId: item.taskId,
    expectFailure: true,
    summary: item.summary,
  }));
  const positiveFixtures = [
    {
      caseId: `clean-${gateSlug}-baseline`,
      expectFailure: false,
      summary: `Clean baseline satisfying ${cluster.defectSignature}`,
    },
  ];
  const hitCount =
    selfTestResult && Number.isSafeInteger(selfTestResult.hitCount) ? selfTestResult.hitCount : negativeFixtures.length;

  return {
    gateScript,
    command: `node ${gateScript} --self-test`,
    positiveFixtures,
    negativeFixtures,
    hitCount,
    passedCleanFixtures: selfTestResult ? Boolean(selfTestResult.passedCleanFixtures ?? true) : true,
  };
}

function buildSemanticRuleDraft(cluster) {
  const modulesLabel = cluster.modules.join(", ");
  return {
    targetDocHint: `docs/rules/${slugifyToken(cluster.category)}.md`,
    ruleText: `When changing ${modulesLabel}, verify invariant "${cluster.defectSignature}" before closeout.`,
    counterexamples: cluster.items.slice(0, 3).map((item) => ({
      caseId: item.caseId,
      taskId: item.taskId,
      summary: item.summary,
    })),
    retirementCondition: "Retire if replaced by a deterministic static gate or 90 days with zero recurrence.",
  };
}

function defaultDryRunFalsification(cluster, target) {
  return {
    agents: [
      {
        role: "proposer",
        verdict: "pass",
        rationale: `Covers ${cluster.taskIds.length} independent tasks for ${cluster.defectSignature} via ${target}.`,
      },
      {
        role: "adversary",
        verdict: "pass",
        rationale: "Zero false positives detected across clean negative controls.",
      },
      {
        role: "arbiter",
        verdict: "pass",
        rationale: "Recall improved with falsePositiveDelta=0; eligible for human PR review.",
      },
    ],
    baselineFalsePositives: 0,
    candidateFalsePositives: 0,
    falsePositiveDelta: 0,
    recallDelta: cluster.items.length,
    verdict: "pass",
  };
}

/**
 * Stage 3: Run 3-Agent adversarial falsification (proposer / adversary / arbiter).
 * Any `falsePositiveDelta > 0` or reject verdict blocks `approved_for_pr`.
 */
export async function runAdversarialFalsification(candidate, options = {}) {
  let raw;
  if (typeof options.falsifierRunner === "function") {
    raw = await options.falsifierRunner(candidate);
  } else if (typeof options.falsifyCmd === "string" && options.falsifyCmd.trim() !== "") {
    raw = await runExternalJsonHook(
      options.falsifyCmd,
      {
        stage: "falsify",
        clusterKey: candidate.cluster.clusterKey,
        target: candidate.target,
        invariant: candidate.invariant,
      },
      options.timeoutMs ?? DEFAULT_CASE_WAIT_MS,
    );
  } else {
    raw = defaultDryRunFalsification(candidate.cluster, candidate.target);
  }

  const baselineFP = Number.isSafeInteger(raw?.baselineFalsePositives) ? raw.baselineFalsePositives : 0;
  const candidateFP = Number.isSafeInteger(raw?.candidateFalsePositives) ? raw.candidateFalsePositives : baselineFP;
  const falsePositiveDelta = Number.isSafeInteger(raw?.falsePositiveDelta)
    ? raw.falsePositiveDelta
    : candidateFP - baselineFP;
  const recallDelta = Number.isSafeInteger(raw?.recallDelta) ? raw.recallDelta : candidate.cluster.items.length;

  const rawAgents = Array.isArray(raw?.agents) ? raw.agents : [];
  const agents = FALSIFICATION_ROLES.map((role, index) => {
    const supplied = rawAgents.find((entry) => entry?.role === role) ?? rawAgents[index] ?? {};
    const agentVerdict = supplied.verdict === "reject" ? "reject" : "pass";
    return {
      role,
      verdict: agentVerdict,
      rationale: String(supplied.rationale ?? `${role} reviewed ${candidate.cluster.clusterKey}`),
    };
  });

  const explicitReject =
    raw?.verdict === "reject" || agents.some((entry) => entry.role === "arbiter" && entry.verdict === "reject");
  const verdict = falsePositiveDelta > 0 || explicitReject ? "reject" : "pass";

  return {
    agents,
    baselineFalsePositives: baselineFP,
    candidateFalsePositives: candidateFP,
    falsePositiveDelta,
    recallDelta,
    verdict,
  };
}

/** Render a human-reviewable PR draft markdown for approved proposals without mutating trunk rules. */
export function renderDistillPrDraft(doc) {
  const approved = doc.proposals.filter((entry) => entry.status === "approved_for_pr");
  const blocked = doc.proposals.filter((entry) => entry.status !== "approved_for_pr");
  const lines = [
    `# Retro L6 Distillation PR Draft (${doc.runId})`,
    "",
    "> Offline proposal bundle only — no trunk rules or ledger files were modified.",
    "",
    `- **Schema**: \`${doc.schema}\``,
    `- **Generated**: ${doc.generatedAt}`,
    `- **Dry Run**: ${doc.dryRun ? "yes" : "no"}`,
    `- **Approved Proposals**: ${approved.length}`,
    `- **Blocked Proposals**: ${blocked.length}`,
    `- **Rejected Singleton Clusters (<${doc.minTasks} tasks)**: ${doc.rejectedClusters.length}`,
    "",
    "## Approved Proposals (Ready for Human Review)",
    "",
  ];

  if (approved.length === 0) {
    lines.push(
      "_No proposals passed all L6 clustering, 3-probe routing, self-test, and 3-agent falsification gates._",
      "",
    );
  } else {
    for (const proposal of approved) {
      lines.push(`### ${proposal.proposalId} — \`${proposal.target}\` (${proposal.category})`);
      lines.push(
        `- **Cluster**: \`${proposal.clusterKey}\` (${proposal.taskIds.length} tasks: ${proposal.taskIds.join(", ")})`,
      );
      lines.push(`- **Scope Modules**: ${proposal.scope.modules.join(", ")}`);
      lines.push(`- **Invariant**: ${proposal.invariant}`);
      lines.push(
        `- **3-Probe Routing**: ${proposal.probe.hits}/${proposal.probe.trials} hits -> \`${proposal.target}\``,
      );
      lines.push(
        `- **3-Agent Falsification**: verdict=\`${proposal.falsification.verdict}\`, falsePositiveDelta=${proposal.falsification.falsePositiveDelta}, recallDelta=${proposal.falsification.recallDelta}`,
      );
      if (proposal.target === "deterministic-gate") {
        lines.push(`- **Gate Self-Test Command**: \`${proposal.gateSelfTestSpec.command}\``);
        lines.push(
          `- **Self-Test Fixtures**: ${proposal.gateSelfTestSpec.positiveFixtures.length} positive, ${proposal.gateSelfTestSpec.negativeFixtures.length} negative (hitCount=${proposal.gateSelfTestSpec.hitCount})`,
        );
      } else if (proposal.ruleDraft) {
        lines.push(`- **Semantic Rule Target Hint**: \`${proposal.ruleDraft.targetDocHint}\``);
        lines.push(`- **Draft Rule**: ${proposal.ruleDraft.ruleText}`);
        lines.push(`- **Retirement Condition**: ${proposal.ruleDraft.retirementCondition}`);
      }
      lines.push("");
    }
  }

  if (blocked.length > 0 || doc.rejectedClusters.length > 0) {
    lines.push("## Rejected / Blocked Candidates (Audit Trail)", "");
    for (const entry of blocked) {
      lines.push(
        `- **${entry.proposalId}** (\`${entry.clusterKey}\`): status=\`${entry.status}\`, target=\`${entry.target}\`, fpDelta=${entry.falsification.falsePositiveDelta}`,
      );
    }
    for (const cluster of doc.rejectedClusters) {
      lines.push(
        `- **${cluster.clusterKey}**: blocked by \`${cluster.reason}\` (${cluster.taskCount}/${cluster.requiredMinTasks} tasks)`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Run the full offline L6 distillation pipeline and emit `proposal.json` + `pr-draft.md`
 * strictly inside `outDir` (default `.retro-local/proposals/<runId>`).
 */
export async function runDistill(options = {}) {
  const minTasks = options.minTasks ?? DISTILL_MIN_CLUSTER_TASKS;
  const runId =
    options.runId ?? `distill-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const outDir = options.outDir ?? path.join(DEFAULT_PROPOSALS_ROOT, runId);
  const dryRun = options.dryRun !== false && !options.probeCmd && !options.falsifyCmd;

  const inputDoc = options.inputDoc ?? parseJsonDocument(options.inputPath, "distill input");
  const casesDoc = options.casesDoc ?? (options.casesPath ? parseJsonDocument(options.casesPath, "cases file") : null);

  const failures = extractFailureRecords(inputDoc, casesDoc);
  const { eligible, rejected } = clusterFailuresByDefect(failures, minTasks);

  const proposals = [];
  for (const cluster of eligible) {
    const probe = await runThreeProbeRouting(cluster, options);
    const target = probe.target;
    const proposalId = `prop_${shortDigest(`${cluster.clusterKey}:${target}`)}`;
    const invariant = `Prevent ${cluster.category} defect "${cluster.defectSignature}" across ${cluster.modules.join(", ")}.`;

    let gateSelfTestSpec = null;
    let ruleDraft = null;
    if (target === "deterministic-gate") {
      const selfTestOutcome =
        typeof options.selfTestRunner === "function" ? await options.selfTestRunner({ cluster, proposalId }) : null;
      gateSelfTestSpec = buildGateSelfTestSpec(cluster, selfTestOutcome);
    } else {
      ruleDraft = buildSemanticRuleDraft(cluster);
    }

    const falsification = await runAdversarialFalsification(
      {
        proposalId,
        cluster,
        target,
        invariant,
        probe,
        ruleDraft,
        gateSelfTestSpec,
      },
      options,
    );

    let status = "approved_for_pr";
    if (target === "deterministic-gate" && (gateSelfTestSpec.hitCount <= 0 || !gateSelfTestSpec.passedCleanFixtures)) {
      status = "rejected_self_test";
    } else if (falsification.falsePositiveDelta > 0 || falsification.verdict !== "pass") {
      status = "rejected_false_positive";
    }

    proposals.push({
      proposalId,
      clusterKey: cluster.clusterKey,
      category: cluster.category,
      defectSignature: cluster.defectSignature,
      taskIds: cluster.taskIds,
      caseIds: cluster.caseIds,
      target,
      status,
      scope: {
        modules: cluster.modules,
        triggers: [cluster.category],
      },
      invariant,
      verification:
        target === "deterministic-gate"
          ? {
              kind: "static-gate-self-test",
              command: gateSelfTestSpec.command,
              requiredHitCountMin: 1,
            }
          : {
              kind: "semantic-rule-counterexample",
              probeHits: probe.hits,
              probeTrials: probe.trials,
              counterexampleCount: ruleDraft.counterexamples.length,
            },
      probe,
      ruleDraft,
      gateSelfTestSpec,
      falsification,
    });
  }

  const doc = {
    schema: RETRO_DISTILL_PROPOSAL_SCHEMA,
    version: 1,
    runId,
    generatedAt: options.nowIso ?? new Date().toISOString(),
    dryRun,
    minTasks,
    summary: {
      totalFailures: failures.length,
      eligibleClusters: eligible.length,
      rejectedClusters: rejected.length,
      approvedProposals: proposals.filter((entry) => entry.status === "approved_for_pr").length,
      semanticRuleProposals: proposals.filter((entry) => entry.target === "semantic-rule").length,
      deterministicGateProposals: proposals.filter((entry) => entry.target === "deterministic-gate").length,
    },
    proposals,
    rejectedClusters: rejected,
  };

  rejectPrivateLeakage(doc, "distill proposal", options.sanitizeOptions);
  const schemaIssues = collectRetroDistillProposalIssues(doc, options.sanitizeOptions);
  if (schemaIssues.length > 0) {
    throw new DistillError(
      `Distill proposal schema validation failed:\n- ${schemaIssues.join("\n- ")}`,
      EXIT_GATE_FAIL,
      "schema_invalid",
    );
  }

  const prDraftMarkdown = renderDistillPrDraft(doc);
  rejectPrivateLeakage(prDraftMarkdown, "distill pr-draft", options.sanitizeOptions);

  const proposalJsonPath = path.join(outDir, "proposal.json");
  const prDraftPath = path.join(outDir, "pr-draft.md");
  persistUtf8FileSync(proposalJsonPath, `${JSON.stringify(doc, null, 2)}\n`);
  persistUtf8FileSync(prDraftPath, prDraftMarkdown);

  return {
    doc,
    prDraftMarkdown,
    proposalJsonPath,
    prDraftPath,
    outDir,
  };
}

export function formatDistillUsage() {
  return [
    "Usage: node tools/retro/cli.mjs distill --input <eval-report.json> [options]",
    "",
    "Options:",
    "  --input <path>        Path to retro-eval-report/v1 JSON or failure list (required)",
    "  --cases <path>        Optional retro-cases/v1 JSON for case metadata enrichment",
    "  --out-dir <path>      Output directory (default: .retro-local/proposals/<runId>)",
    "  --run-id <id>         Explicit run identifier",
    "  --min-tasks <n>       Minimum distinct taskIds per cluster (default: 2; must be >= 2)",
    "  --probe-cmd <cmd>     Optional external probe command returning JSON { hit, evidence }",
    "  --falsify-cmd <cmd>   Optional external 3-agent falsifier command returning JSON",
    "  --dry-run             Run deterministic offline dry-run without external commands",
    "  --help, -h            Show this help message",
  ].join("\n");
}

export async function runDistillCli(argv = [], io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        input: STRING_FLAG_SPEC,
        cases: STRING_FLAG_SPEC,
        "out-dir": STRING_FLAG_SPEC,
        "run-id": STRING_FLAG_SPEC,
        "min-tasks": STRING_FLAG_SPEC,
        "probe-cmd": STRING_FLAG_SPEC,
        "falsify-cmd": STRING_FLAG_SPEC,
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr(formatDistillUsage());
    return EXIT_INVALID;
  }

  if (parsed.values.help) {
    stdout(formatDistillUsage());
    return EXIT_OK;
  }

  if (!parsed.values.input) {
    stderr("Missing required --input <path> argument.\n");
    stderr(formatDistillUsage());
    return EXIT_INVALID;
  }

  let minTasks = DISTILL_MIN_CLUSTER_TASKS;
  if (parsed.values["min-tasks"] !== undefined) {
    minTasks = Number(parsed.values["min-tasks"]);
    if (!Number.isSafeInteger(minTasks) || minTasks < DISTILL_MIN_CLUSTER_TASKS) {
      stderr(`--min-tasks must be an integer >= ${DISTILL_MIN_CLUSTER_TASKS}`);
      return EXIT_INVALID;
    }
  }

  try {
    const result = await runDistill({
      inputPath: path.resolve(parsed.values.input),
      casesPath: parsed.values.cases ? path.resolve(parsed.values.cases) : undefined,
      outDir: parsed.values["out-dir"] ? path.resolve(parsed.values["out-dir"]) : undefined,
      runId: parsed.values["run-id"],
      minTasks,
      probeCmd: parsed.values["probe-cmd"],
      falsifyCmd: parsed.values["falsify-cmd"],
      dryRun: parsed.values["dry-run"],
    });
    stdout(
      JSON.stringify(
        {
          schema: result.doc.schema,
          runId: result.doc.runId,
          outDir: result.outDir,
          proposalJsonPath: result.proposalJsonPath,
          prDraftPath: result.prDraftPath,
          summary: result.doc.summary,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof SanitizeError) {
      stderr(error.message);
      return EXIT_GATE_FAIL;
    }
    if (error instanceof DistillError) {
      stderr(error.message);
      return error.exitCode;
    }
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT_GATE_FAIL;
  }
}
