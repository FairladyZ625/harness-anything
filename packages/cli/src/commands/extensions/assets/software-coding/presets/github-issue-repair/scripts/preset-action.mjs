#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const input = normalizeInputs(context.inputs ?? {});
const acquisition = await loadIssueSource(input);
const selected = selectIssue(acquisition.issues, input);
const report = buildReport(input, acquisition, selected);
const ok = report.status === "ready";

writeFileSync(path.join(artifactsDir, "github-issue-repair-plan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "github-issue-repair-plan.md"), renderMarkdown(report), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok,
  rows: selected ? 1 : 0,
  warnings: acquisition.warnings,
  report,
  error: ok ? undefined : {
    code: "preset_script_result_failed",
    hint: blockedHint(report)
  }
}, null, 2)}\n`, "utf8");

function normalizeInputs(raw) {
  const repo = stringInput(raw.repo);
  if (!repo) fail("repo_required", "Input repo is required.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("invalid_repo", "Input repo must be owner/name.");
  }
  const state = enumInput(raw.state, ["open", "closed", "all"], "open");
  const limit = integerInput(raw.limit, 10, 1, 50);
  const fetchMode = enumInput(raw.fetchMode, ["disabled", "best-effort"], "disabled");
  return {
    repo,
    state,
    limit,
    labels: splitCsv(raw.labels),
    excludeLabels: splitCsv(raw.excludeLabels),
    issue: stringInput(raw.issue || "next"),
    fixtureFile: optionalString(raw.fixtureFile),
    issueJson: optionalString(raw.issueJson),
    fetchMode
  };
}

async function loadIssueSource(input) {
  if (input.issueJson) {
    return {
      mode: "issueJson",
      ok: true,
      issues: readIssueJson(input.issueJson),
      warnings: [],
      message: "Loaded a deterministic issueJson input from the task outputRoot."
    };
  }
  if (input.fixtureFile) {
    return {
      mode: "fixtureFile",
      ok: true,
      issues: readFixtureIssues(input.fixtureFile),
      warnings: [],
      message: "Loaded a deterministic fixtureFile input from the task outputRoot."
    };
  }
  if (input.fetchMode === "best-effort") {
    try {
      const issues = await fetchGitHubIssues(input);
      return {
        mode: "github-api",
        ok: true,
        issues,
        warnings: ["GitHub fetch is best-effort in the preset sandbox; fixtureFile or issueJson is the reliable path."],
        message: "Fetched issues from the GitHub API."
      };
    } catch (error) {
      return {
        mode: "github-api",
        ok: false,
        issues: [],
        warnings: ["GitHub fetch failed or is unavailable in the preset sandbox; provide fixtureFile or issueJson for deterministic intake."],
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return {
    mode: "none",
    ok: false,
    issues: [],
    warnings: ["No deterministic GitHub issue input was provided. Pass issueJson or fixtureFile, or explicitly set fetchMode=best-effort."],
    message: "Network fetch is disabled by default so the preset does not imply live GitHub access from the sandbox."
  };
}

function readIssueJson(relativePath) {
  const target = safeOutputPath(relativePath, "issueJson");
  if (!existsSync(target)) fail("fixture_missing", `issueJson file does not exist under task outputRoot: ${relativePath}`);
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.issue && typeof parsed.issue === "object") {
    return [normalizeIssue(parsed.issue)];
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "number" in parsed) return [normalizeIssue(parsed)];
  fail("fixture_invalid", "issueJson must be a GitHub issue object or an object with an issue object.");
}

function readFixtureIssues(relativePath) {
  const target = safeOutputPath(relativePath, "fixtureFile");
  if (!existsSync(target)) fail("fixture_missing", `Fixture file does not exist under task outputRoot: ${relativePath}`);
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  if (Array.isArray(parsed)) return parsed.map(normalizeIssue);
  if (Array.isArray(parsed?.issues)) return parsed.issues.map(normalizeIssue);
  fail("fixture_invalid", "Fixture file must be an array or an object with an issues array.");
}

async function fetchGitHubIssues(input) {
  const [owner, repo] = input.repo.split("/");
  if (/^\d+$/u.test(input.issue)) {
    return [normalizeIssue(await githubJson(`/repos/${owner}/${repo}/issues/${input.issue}`))];
  }
  const params = new URLSearchParams({
    state: input.state,
    per_page: String(input.limit),
    sort: "updated",
    direction: "desc"
  });
  if (input.labels.length > 0) params.set("labels", input.labels.join(","));
  const rows = await githubJson(`/repos/${owner}/${repo}/issues?${params.toString()}`);
  if (!Array.isArray(rows)) throw new Error("GitHub issues API did not return an array.");
  return rows.filter((issue) => !issue.pull_request).map(normalizeIssue);
}

async function githubJson(pathname) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "harness-anything-github-issue-repair",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status} ${response.statusText}.`);
  }
  return response.json();
}

function selectIssue(issues, input) {
  const candidates = issues
    .filter((issue) => !issue.pullRequest)
    .filter((issue) => input.state === "all" || issue.state === input.state)
    .filter((issue) => input.labels.length === 0 || input.labels.every((label) => issue.labels.includes(label)))
    .filter((issue) => input.excludeLabels.every((label) => !issue.labels.includes(label)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if (/^\d+$/u.test(input.issue)) return candidates.find((issue) => issue.number === Number(input.issue));
  return candidates[0];
}

function buildReport(input, acquisition, selected) {
  const source = {
    repo: input.repo,
    state: input.state,
    issue: input.issue,
    labels: input.labels,
    excludeLabels: input.excludeLabels,
    fetchedCount: acquisition.issues.length,
    acquisition: {
      mode: acquisition.mode,
      ok: acquisition.ok,
      message: acquisition.message
    }
  };
  if (!selected) {
    return {
      schema: "github-issue-repair-intake/v1",
      taskId: context.taskId,
      status: "blocked",
      generatedAt: new Date().toISOString(),
      source,
      issueSnapshot: null,
      triageRepairBrief: {
        taskType: "fix",
        disposition: "blocked",
        summary: acquisition.ok
          ? "No eligible GitHub issue matched the declared filters."
          : acquisition.message,
        labels: [],
        repository: input.repo
      },
      reproducibility: {
        judgement: "not-assessed",
        evidence: [],
        nextAction: "Provide a deterministic issueJson or fixtureFile input, or relax the selection filters."
      },
      sourceInvestigationPlan: [],
      acceptanceCriteria: [],
      stopConditions: [
        "Stop until a concrete GitHub issue snapshot is available from issueJson, fixtureFile, or an explicitly requested best-effort fetch.",
        "Do not infer a repair task from an empty issue selection."
      ]
    };
  }
  const snapshot = issueSnapshot(selected);
  return {
    schema: "github-issue-repair-intake/v1",
    taskId: context.taskId,
    status: "ready",
    generatedAt: new Date().toISOString(),
    source,
    issueSnapshot: snapshot,
    triageRepairBrief: triageRepairBrief(input.repo, selected),
    reproducibility: reproducibilityJudgement(selected),
    sourceInvestigationPlan: sourceInvestigationPlan(selected),
    acceptanceCriteria: acceptanceCriteria(input.repo, selected),
    stopConditions: stopConditions(selected)
  };
}

function issueSnapshot(issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    author: issue.author,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    body: issue.body,
    bodySummary: summarizeBody(issue.body),
    bodyPreview: preview(issue.body)
  };
}

function triageRepairBrief(repo, issue) {
  const labelText = issue.labels.length > 0 ? issue.labels.join(", ") : "none";
  return {
    taskType: "fix",
    disposition: "repair-intake",
    repository: repo,
    issueRef: `${repo}#${issue.number}`,
    title: issue.title,
    summary: `Create a Harness repair task for ${repo}#${issue.number}: ${issue.title}.`,
    prioritySignals: prioritySignals(issue),
    labels: issue.labels,
    firstTriageQuestion: `Can the failure described in #${issue.number} be reproduced or narrowed from the issue body, linked files, or adjacent tests?`,
    scopeBoundary: `Repair the behavior requested by #${issue.number}; labels at intake: ${labelText}.`
  };
}

function reproducibilityJudgement(issue) {
  const commands = extractCommands(issue.body);
  const evidence = [];
  if (commands.length > 0) evidence.push(`Issue body includes command-like snippets: ${commands.join("; ")}`);
  if (/\b(repro(?:duce|duction)?|steps?|run|command|expected|actual|fails?|error|stack trace|traceback|crash)\b/iu.test(issue.body)) {
    evidence.push("Issue body contains reproduction or failure vocabulary.");
  }
  if (issue.body.trim().length === 0) {
    return {
      judgement: "insufficient-detail",
      evidence: [],
      commands,
      nextAction: "Ask for or locate a concrete failing scenario before editing code."
    };
  }
  if (evidence.length > 0) {
    return {
      judgement: "reproducible-from-issue",
      evidence,
      commands,
      nextAction: "Run or translate the described reproduction before making the fix."
    };
  }
  return {
    judgement: "needs-local-reproduction",
    evidence: ["Issue body has context but no explicit reproduction steps were detected."],
    commands,
    nextAction: "Search source and tests using issue title terms, then create the smallest failing local check."
  };
}

function sourceInvestigationPlan(issue) {
  const terms = investigationTerms(issue);
  const references = extractPathReferences(issue.body);
  return [
    {
      step: "snapshot",
      action: `Read the full body, labels, linked references, and comments for issue #${issue.number}.`,
      reason: "Preserve the external report before turning it into a local Harness task."
    },
    {
      step: "locate-source",
      action: references.length > 0
        ? `Open the referenced paths first: ${references.join(", ")}.`
        : `Search the repository for issue terms: ${terms.join(", ")}.`,
      reason: "Find the smallest owned code surface before changing behavior."
    },
    {
      step: "reproduce",
      action: "Run the issue reproduction or create a focused failing check that demonstrates the reported behavior.",
      reason: "A fix task needs observable failure evidence or an explicit not-reproducible blocker."
    },
    {
      step: "repair",
      action: "Implement the smallest coherent fix and update focused tests around the failing behavior.",
      reason: "Keep the repair scoped to the GitHub issue rather than turning the issue body into a broad prompt."
    },
    {
      step: "verify",
      action: "Run the focused test/check first, then the repository lane required for the touched surface.",
      reason: "Acceptance depends on exact verification evidence, not only code changes."
    }
  ];
}

function acceptanceCriteria(repo, issue) {
  const criteria = [
    `The reported behavior in ${repo}#${issue.number} is reproduced, narrowed, or explicitly recorded as not reproducible with evidence.`,
    "The fix changes only the source/test surface needed for the issue scope.",
    "Focused tests or checks cover the repaired behavior.",
    "Final task evidence lists exact verification commands and outcomes.",
    `Any PR or handoff references ${repo}#${issue.number}.`
  ];
  if (issue.labels.includes("bug")) criteria.unshift("The bug no longer reproduces under the captured failing scenario.");
  return criteria;
}

function stopConditions(issue) {
  return [
    "Stop if the issue cannot be reproduced or narrowed enough to define a failing behavior.",
    "Stop if the repair requires product, architecture, or maintainer decisions not present in the issue.",
    "Stop if the likely fix would modify CI/gate authority or contribution documentation outside the assigned scope.",
    "Stop if the issue turns out to be a pull request, duplicate, or non-fix request after reading the full source.",
    issue.body.trim().length === 0
      ? "Stop until the empty issue body is supplemented by comments, linked evidence, or maintainer direction."
      : "Stop if linked issue evidence contradicts the selected repair scope."
  ];
}

function prioritySignals(issue) {
  const signals = [];
  if (issue.labels.includes("bug")) signals.push("bug");
  if (issue.labels.includes("regression")) signals.push("regression");
  if (issue.labels.includes("agent-ready")) signals.push("agent-ready");
  if (signals.length === 0) signals.push("label-review-needed");
  return signals;
}

function investigationTerms(issue) {
  return [...new Set(issue.title
    .split(/[^A-Za-z0-9_.:-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4)
    .slice(0, 8))];
}

function extractPathReferences(body) {
  return [...new Set([...body.matchAll(/\b(?:packages|tools|docs-release|harness|src|test)\/[A-Za-z0-9_./-]+/gu)]
    .map((match) => match[0].replace(/[),.;:]+$/u, ""))
    .filter((reference) => !reference.includes(".."))
    .slice(0, 8))];
}

function extractCommands(body) {
  const fenced = [...body.matchAll(/`([^`\n]+)`/gu)]
    .map((match) => match[1].trim())
    .filter((snippet) => /^(?:npm|npx|node|pnpm|yarn|ha|git|tsc)\b/u.test(snippet));
  const lines = body.split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[$>]|[-*]\s*)/u, "").trim())
    .filter((line) => /^(?:npm|npx|node|pnpm|yarn|ha|git|tsc)\b/u.test(line));
  return [...new Set([...fenced, ...lines])].slice(0, 5);
}

function renderMarkdown(report) {
  const lines = [
    "# GitHub Issue Repair Intake",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.source.repo}`,
    `Source: ${report.source.acquisition.mode} (${report.source.acquisition.ok ? "ok" : "blocked"})`,
    ""
  ];
  if (!report.issueSnapshot) {
    lines.push(
      "## Intake Blocker",
      "",
      report.triageRepairBrief.summary,
      "",
      "## Stop Conditions",
      ""
    );
    for (const condition of report.stopConditions) lines.push(`- ${condition}`);
    return `${lines.join("\n")}\n`;
  }
  const issue = report.issueSnapshot;
  lines.push(
    "## Issue Snapshot",
    "",
    `- #${issue.number}: ${issue.title}`,
    `- URL: ${issue.url}`,
    `- State: ${issue.state}`,
    `- Author: ${issue.author || "unknown"}`,
    `- Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "none"}`,
    `- Updated: ${issue.updatedAt}`,
    "",
    "## Triage / Repair Brief",
    "",
    report.triageRepairBrief.summary,
    "",
    `Task type: ${report.triageRepairBrief.taskType}`,
    `Scope: ${report.triageRepairBrief.scopeBoundary}`,
    "",
    "## Reproducibility",
    "",
    `Judgement: ${report.reproducibility.judgement}`,
    `Next action: ${report.reproducibility.nextAction}`,
    ""
  );
  if (report.reproducibility.evidence.length > 0) {
    lines.push("Evidence:");
    for (const item of report.reproducibility.evidence) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push("## Source Investigation Plan", "");
  for (const step of report.sourceInvestigationPlan) lines.push(`- ${step.step}: ${step.action}`);
  lines.push("", "## Acceptance Criteria", "");
  for (const criterion of report.acceptanceCriteria) lines.push(`- ${criterion}`);
  lines.push("", "## Stop Conditions", "");
  for (const condition of report.stopConditions) lines.push(`- ${condition}`);
  return `${lines.join("\n")}\n`;
}

function normalizeIssue(raw) {
  if (!raw || typeof raw !== "object") fail("issue_invalid", "Issue rows must be objects.");
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    state: String(raw.state ?? "open").toLowerCase(),
    url: String(raw.html_url ?? raw.url ?? ""),
    author: String(raw.user?.login ?? raw.author ?? ""),
    labels: Array.isArray(raw.labels) ? raw.labels.map((label) => typeof label === "string" ? label : String(label?.name ?? "")).filter(Boolean) : [],
    createdAt: String(raw.created_at ?? raw.createdAt ?? "1970-01-01T00:00:00.000Z"),
    updatedAt: String(raw.updated_at ?? raw.updatedAt ?? "1970-01-01T00:00:00.000Z"),
    body: String(raw.body ?? ""),
    pullRequest: Boolean(raw.pull_request ?? raw.pullRequest)
  };
}

function safeOutputPath(relativePath, inputName) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) fail("fixture_path_invalid", `${inputName} must stay under task outputRoot.`);
  const target = path.resolve(context.outputRoot, normalized);
  const outputRoot = path.resolve(context.outputRoot);
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) fail("fixture_path_invalid", `${inputName} must stay under task outputRoot.`);
  return target;
}

function splitCsv(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function stringInput(value) {
  return String(value ?? "").trim();
}

function optionalString(value) {
  const normalized = stringInput(value);
  return normalized.length > 0 ? normalized : undefined;
}

function enumInput(value, allowed, fallback) {
  const normalized = stringInput(value || fallback);
  if (!allowed.includes(normalized)) fail("invalid_json_input", `Input must be one of: ${allowed.join(", ")}.`);
  return normalized;
}

function integerInput(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function summarizeBody(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "(empty)";
  const firstParagraph = normalized.split(/\n\s*\n/u).map((part) => part.trim()).find(Boolean) ?? normalized;
  return preview(firstParagraph, 360);
}

function preview(value, max = 280) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function blockedHint(report) {
  if (!report.issueSnapshot) return report.triageRepairBrief.summary;
  return "GitHub issue repair intake is blocked.";
}

function fail(code, message) {
  writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
    ok: false,
    error: { code, hint: message }
  }, null, 2)}\n`, "utf8");
  console.error(`${code}: ${message}`);
  process.exit(1);
}
