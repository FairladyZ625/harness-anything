#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const input = normalizeInputs(context.inputs ?? {});
const issues = input.fixtureFile ? readFixtureIssues(input.fixtureFile) : await fetchGitHubIssues(input);
const selected = selectIssue(issues, input);
const report = buildReport(input, issues, selected);

writeFileSync(path.join(artifactsDir, "github-issue-repair-plan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "github-issue-repair-plan.md"), renderMarkdown(report), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: selected !== undefined,
  rows: selected ? 1 : 0,
  report,
  error: selected ? undefined : {
    code: "preset_script_result_failed",
    hint: "No eligible GitHub issue was found for the declared selection inputs."
  }
}, null, 2)}\n`, "utf8");

function normalizeInputs(raw) {
  const repo = stringInput(raw.repo || "FairladyZ625/harness-anything");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("invalid_repo", "Input repo must be owner/name.");
  }
  const state = enumInput(raw.state, ["open", "closed", "all"], "open");
  const limit = integerInput(raw.limit, 10, 1, 50);
  return {
    repo,
    state,
    limit,
    labels: splitCsv(raw.labels),
    excludeLabels: splitCsv(raw.excludeLabels),
    issue: stringInput(raw.issue || "next"),
    fixtureFile: optionalString(raw.fixtureFile)
  };
}

function readFixtureIssues(relativePath) {
  const target = safeOutputPath(relativePath);
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
  if (!Array.isArray(rows)) fail("github_response_invalid", "GitHub issues API did not return an array.");
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
    fail("github_request_failed", `GitHub request failed with ${response.status} ${response.statusText}.`);
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

function buildReport(input, issues, selected) {
  return {
    schema: "github-issue-repair-plan/v1",
    taskId: context.taskId,
    status: selected ? "ready" : "blocked",
    generatedAt: new Date().toISOString(),
    source: {
      repo: input.repo,
      state: input.state,
      issue: input.issue,
      labels: input.labels,
      excludeLabels: input.excludeLabels,
      fetchedCount: issues.length
    },
    selectedIssue: selected ? {
      number: selected.number,
      title: selected.title,
      state: selected.state,
      url: selected.url,
      author: selected.author,
      labels: selected.labels,
      updatedAt: selected.updatedAt,
      bodyPreview: preview(selected.body)
    } : null,
    repairPlan: selected ? repairPlan(input.repo, selected) : [],
    prompt: selected ? repairPrompt(input.repo, selected) : ""
  };
}

function repairPlan(repo, issue) {
  return [
    `Create or reuse a task package for GitHub issue #${issue.number}: ${issue.title}.`,
    "Read the contributing path, root README, named files, and tests adjacent to the suspected code.",
    "Reproduce or narrow the issue before editing; if it cannot be reproduced, record the blocker instead of guessing.",
    "Implement the smallest coherent fix inside the issue scope.",
    "Run focused checks first, then the repository gate required by the contribution docs.",
    `Open or update a PR that references ${repo}#${issue.number}, includes verification evidence, and leaves merge authority with maintainers.`
  ];
}

function repairPrompt(repo, issue) {
  return [
    `Repair GitHub issue ${repo}#${issue.number}: ${issue.title}`,
    "",
    "Issue URL:",
    issue.url,
    "",
    "Labels:",
    issue.labels.length > 0 ? issue.labels.join(", ") : "none",
    "",
    "Body:",
    issue.body || "(empty)",
    "",
    "Constraints:",
    "- Keep the change inside the issue scope.",
    "- Do not merge, force-push, or direct-push to main.",
    "- Run relevant checks and report exact results.",
    "- Reference the issue in the PR body."
  ].join("\n");
}

function renderMarkdown(report) {
  const lines = [
    "# GitHub Issue Repair Plan",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.source.repo}`,
    ""
  ];
  if (!report.selectedIssue) {
    lines.push("## Selected Issue", "", "- None");
    return `${lines.join("\n")}\n`;
  }
  const issue = report.selectedIssue;
  lines.push(
    "## Selected Issue",
    "",
    `- #${issue.number}: ${issue.title}`,
    `- URL: ${issue.url}`,
    `- State: ${issue.state}`,
    `- Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "none"}`,
    "",
    "## Repair Plan",
    ""
  );
  for (const step of report.repairPlan) lines.push(`- ${step}`);
  lines.push("", "## Agent Prompt", "", "```text", report.prompt, "```");
  return `${lines.join("\n")}\n`;
}

function normalizeIssue(raw) {
  if (!raw || typeof raw !== "object") fail("issue_invalid", "Issue rows must be objects.");
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    state: String(raw.state ?? "open"),
    url: String(raw.html_url ?? raw.url ?? ""),
    author: String(raw.user?.login ?? raw.author ?? ""),
    labels: Array.isArray(raw.labels) ? raw.labels.map((label) => typeof label === "string" ? label : String(label?.name ?? "")).filter(Boolean) : [],
    updatedAt: String(raw.updated_at ?? raw.updatedAt ?? "1970-01-01T00:00:00.000Z"),
    body: String(raw.body ?? ""),
    pullRequest: Boolean(raw.pull_request ?? raw.pullRequest)
  };
}

function safeOutputPath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("..")) fail("fixture_path_invalid", "fixtureFile must stay under task outputRoot.");
  const target = path.resolve(context.outputRoot, normalized);
  const outputRoot = path.resolve(context.outputRoot);
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) fail("fixture_path_invalid", "fixtureFile must stay under task outputRoot.");
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
  return allowed.includes(normalized) ? normalized : fallback;
}

function integerInput(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function preview(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function fail(code, message) {
  writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
    ok: false,
    error: { code, hint: message }
  }, null, 2)}\n`, "utf8");
  console.error(`${code}: ${message}`);
  process.exit(1);
}
