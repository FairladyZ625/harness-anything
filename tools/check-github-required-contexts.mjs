#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseManifestBranchProtectionContexts } from "./check-mergify-queue-contexts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gateManifestPath = path.join(repoRoot, "tools/gate-manifest.json");
const DEFAULT_BRANCH = "main";
const DEFAULT_API_BASE = "https://api.github.com";

export function checkGithubRequiredContexts({
  branchRules,
  gateManifestText = readFileSync(gateManifestPath, "utf8")
}) {
  const apiResult = extractGitHubRequiredStatusCheckContexts(branchRules);
  const apiContexts = apiResult.contexts;
  const requiredContexts = parseManifestBranchProtectionContexts(gateManifestText);
  const errors = [];
  const missing = requiredContexts.filter((context) => !apiContexts.includes(context));
  const extra = apiContexts.filter((context) => !requiredContexts.includes(context));

  if (requiredContexts.length === 0) {
    errors.push("gate manifest declares no branch-protection contexts");
  }
  if (!apiResult.hasRequiredStatusCheckRule) {
    errors.push("GitHub branch rules include no required_status_checks rule");
  }
  if (apiContexts.length === 0) {
    errors.push("GitHub branch rules declare no required status check contexts");
  }

  if (missing.length > 0) {
    errors.push(`missing required contexts in GitHub branch rules: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(`extra GitHub branch-rule contexts not declared by gate manifest: ${extra.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    apiContexts,
    requiredContexts
  };
}

export function extractGitHubRequiredStatusCheckContexts(branchRules) {
  if (!Array.isArray(branchRules)) {
    throw new TypeError("GitHub branch rules response must be an array");
  }

  const contexts = [];
  const seen = new Set();
  let hasRequiredStatusCheckRule = false;

  for (const rule of branchRules) {
    if (rule?.type !== "required_status_checks") {
      continue;
    }
    hasRequiredStatusCheckRule = true;
    for (const entry of rule.parameters?.required_status_checks ?? []) {
      const context = typeof entry === "string" ? entry : entry?.context;
      if (typeof context !== "string" || context.trim() === "") {
        continue;
      }
      if (!seen.has(context)) {
        seen.add(context);
        contexts.push(context);
      }
    }
  }

  return { hasRequiredStatusCheckRule, contexts };
}

export async function fetchGitHubBranchRules({
  repo,
  branch = DEFAULT_BRANCH,
  token = process.env.GITHUB_TOKEN,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch
}) {
  if (!repo || !/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
    throw new Error("repository must be provided as owner/name");
  }
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to read GitHub branch rules");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable");
  }

  const url = `${apiBase.replace(/\/+$/u, "")}/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`;
  const response = await fetchImpl(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "harness-anything-required-context-check"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    const detail = body.trim() ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`GitHub branch rules request failed (${response.status} ${response.statusText})${detail}`);
  }

  return response.json();
}

function parseArgs(argv) {
  const options = {
    repo: process.env.GITHUB_REPOSITORY ?? null,
    branch: process.env.GITHUB_REF_NAME === DEFAULT_BRANCH ? process.env.GITHUB_REF_NAME : DEFAULT_BRANCH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--branch") {
      options.branch = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown check-github-required-contexts option: ${arg}`);
  }

  return options;
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  const branchRules = await fetchGitHubBranchRules(options);
  const result = checkGithubRequiredContexts({ branchRules });
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`GitHub required context check passed (${result.apiContexts.length} contexts).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
