#!/usr/bin/env node
/**
 * PR governance declaration checker for ADR-0023 D5/D8.
 *
 * This checker classifies changed PR paths against the protected surfaces
 * declared in tools/gate-manifest.json. If a PR touches that governance surface,
 * the PR body must contain a governance declaration that cites an ADR, decision,
 * or task. Break-glass declarations must also record reason, scope, and a
 * follow-up governance task.
 *
 * Honest boundary: this is a presence-and-shape check only. It proves that a PR
 * body carries governance evidence fields for a protected-surface change; it
 * does not prove the declaration is true, sufficient, or correctly scoped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { shouldSkipPrBodyBilingualCheck } from "./check-pr-body-bilingual.mjs";

const DEFAULT_ROOT = process.cwd();
const DEFAULT_MANIFEST = "tools/gate-manifest.json";
const GOVERNANCE_HEADING = /^##\s+(?:Governance Declaration|Governance 声明|治理声明)\s*$/imu;
const NEXT_HEADING = /^##\s+/mu;
const GOVERNANCE_REFERENCE = /\b(?:ADR-\d{4}|task_[0-9A-Z]+|dec_[A-Z0-9_]+|E\d+|decision)\b/iu;
const BREAK_GLASS_YES = /\bbreak-glass\s*[:：]\s*(?:yes|true|required|needed|enabled|是|启用|需要)\b/iu;
const FIELD_PLACEHOLDER = /^(?:n\/a|na|none|no|not applicable|tbd|todo|\[.*\]|待补|无|不适用)$/iu;

export function deriveProtectedSurfaceRules(manifest) {
  const rawSurfaces = [];
  for (const gate of manifest.gates ?? []) {
    if (!gate.changeControl?.requiresGovernanceEvidence) {
      continue;
    }
    for (const surface of gate.changeControl.protectedSurfaces ?? []) {
      if (typeof surface === "string" && surface.trim().length > 0) {
        rawSurfaces.push(surface.trim());
      }
    }
  }

  const rulesByDisplay = new Map();
  for (const surface of rawSurfaces) {
    for (const display of normalizeManifestSurface(surface)) {
      if (!rulesByDisplay.has(display)) {
        rulesByDisplay.set(display, {
          display,
          manifestSurfaces: [],
          matcher: makeSurfaceMatcher(display)
        });
      }
      rulesByDisplay.get(display).manifestSurfaces.push(surface);
    }
  }

  return [...rulesByDisplay.values()].sort((left, right) => left.display.localeCompare(right.display));
}

export function classifyProtectedChanges(changedFiles, rules) {
  const matches = [];
  for (const file of changedFiles.map(normalizePath).filter(Boolean)) {
    const matchingRules = rules.filter((rule) => rule.matcher(file));
    if (matchingRules.length === 0) {
      continue;
    }
    matches.push({
      file,
      surfaces: matchingRules.map((rule) => rule.display)
    });
  }
  return matches;
}

export function checkPrGovernance({ body, changedFiles, manifest }) {
  const rules = deriveProtectedSurfaceRules(manifest);
  const protectedChanges = classifyProtectedChanges(changedFiles, rules);

  if (protectedChanges.length === 0) {
    return {
      ok: true,
      skipped: true,
      protectedChanges,
      rules,
      issues: []
    };
  }

  const sections = extractGovernanceSections(body);
  const sectionText = sections.join("\n\n");
  const issues = [];

  if (sections.length === 0) {
    issues.push("Protected-surface change requires a `## Governance Declaration` / `## 治理声明` section in the PR body.");
  } else if (!GOVERNANCE_REFERENCE.test(sectionText)) {
    issues.push("Governance declaration must cite at least one ADR, decision, or task reference.");
  }

  if (BREAK_GLASS_YES.test(sectionText)) {
    for (const field of [
      { label: "break-glass reason", patterns: ["Break-glass reason", "Reason", "Break-glass 原因", "原因"] },
      { label: "break-glass scope", patterns: ["Break-glass scope", "Scope", "Break-glass 范围", "范围"] }
    ]) {
      if (!hasLabeledValue(sectionText, field.patterns)) {
        issues.push(`Break-glass declaration must include a non-empty ${field.label}.`);
      }
    }
    const followUp = readLabeledValue(sectionText, ["Follow-up governance task", "Follow-up task", "后续治理任务"]);
    if (!followUp || !/\btask_[0-9A-Z]+\b/u.test(followUp)) {
      issues.push("Break-glass declaration must include a follow-up governance task id.");
    }
  }

  return {
    ok: issues.length === 0,
    skipped: false,
    protectedChanges,
    rules,
    issues
  };
}

function normalizeManifestSurface(surface) {
  const pathSurface = surface.split(":")[0];
  const normalized = normalizePath(pathSurface);
  const surfaces = [normalized];

  if (normalized.startsWith(".github/")) {
    surfaces.push(".github/**");
  }
  if (normalized.startsWith("tools/gate-allowlists/")) {
    surfaces.push("tools/gate-allowlists/**");
  }

  return [...new Set(surfaces.filter(Boolean))];
}

function makeSurfaceMatcher(surface) {
  if (surface.endsWith("/**")) {
    const prefix = surface.slice(0, -2);
    return (file) => file.startsWith(prefix);
  }
  if (surface.includes("*")) {
    const pattern = new RegExp(`^${escapeRegex(surface).replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*")}$`, "u");
    return (file) => pattern.test(file);
  }
  return (file) => file === surface;
}

function extractGovernanceSections(body) {
  const sections = [];
  const lines = body.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!GOVERNANCE_HEADING.test(lines[index])) {
      continue;
    }
    const sectionLines = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (NEXT_HEADING.test(lines[cursor])) {
        break;
      }
      sectionLines.push(lines[cursor]);
    }
    sections.push(sectionLines.join("\n"));
  }
  return sections;
}

function hasLabeledValue(text, labels) {
  return Boolean(readLabeledValue(text, labels));
}

function readLabeledValue(text, labels) {
  for (const label of labels) {
    const escaped = escapeRegex(label);
    const match = new RegExp(`^\\s*-?\\s*${escaped}\\s*[:：]\\s*(.+?)\\s*$`, "imu").exec(text);
    const value = match?.[1]?.trim();
    if (value && !FIELD_PLACEHOLDER.test(value)) {
      return value;
    }
  }
  return "";
}

function readChangedFiles({ root, changedFilesPath, changedFilesText, base, head }) {
  if (changedFilesText !== null) {
    return splitChangedFiles(changedFilesText);
  }
  if (changedFilesPath) {
    return splitChangedFiles(readFileSync(changedFilesPath, "utf8"));
  }
  if (base && head) {
    const result = spawnSync("git", ["diff", "--name-only", base, head, "--"], {
      cwd: root,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      throw new Error(`git diff --name-only failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return splitChangedFiles(result.stdout);
  }
  throw new Error("Provide changed files via --changed-files, --changed-files-text, or --base/--head.");
}

function splitChangedFiles(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function readBody({ bodyText, bodyPath, bodyEnv }) {
  if (bodyText !== null) return bodyText;
  if (bodyPath) return readFileSync(bodyPath, "utf8");
  if (bodyEnv) return process.env[bodyEnv] ?? "";
  return process.env.PR_BODY ?? "";
}

function normalizePath(value) {
  return String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
    manifest: DEFAULT_MANIFEST,
    bodyText: null,
    bodyPath: "",
    bodyEnv: "",
    changedFilesText: null,
    changedFilesPath: "",
    base: "",
    head: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      printHelp();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    if (token === "--root") args.root = value;
    else if (token === "--manifest") args.manifest = value;
    else if (token === "--body-text") args.bodyText = value;
    else if (token === "--body-file") args.bodyPath = value;
    else if (token === "--body-env") args.bodyEnv = value;
    else if (token === "--changed-files-text") args.changedFilesText = value;
    else if (token === "--changed-files") args.changedFilesPath = value;
    else if (token === "--base") args.base = value;
    else if (token === "--head") args.head = value;
    else if (token === "--base-env") args.base = process.env[value] ?? "";
    else if (token === "--head-env") args.head = process.env[value] ?? "";
    else throw new Error(`Unknown argument: ${token}`);
    index += 1;
  }

  args.root = path.resolve(args.root);
  args.manifest = path.resolve(args.root, args.manifest);
  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage: node tools/check-pr-governance.mjs --body-env PR_BODY --base-env PR_BASE_SHA --head-env PR_HEAD_SHA",
    "",
    "Checks whether changed PR paths touch manifest-derived protected surfaces.",
    "If they do, the PR body must include `## Governance Declaration` / `## 治理声明` with ADR/decision/task evidence.",
    "Break-glass declarations must include reason, scope, and a follow-up governance task."
  ].join("\n"));
  process.stdout.write("\n");
}

function printResult(result) {
  if (result.skipped) {
    process.stdout.write(`PR governance declaration check skipped: no protected surfaces touched (${result.rules.length} manifest-derived rules).\n`);
    return;
  }
  if (result.ok) {
    process.stdout.write(`PR governance declaration check passed: ${result.protectedChanges.length} protected path(s) declared.\n`);
    return;
  }

  process.stderr.write([
    "PR governance declaration check failed.",
    "Protected changed paths:",
    ...result.protectedChanges.map((change) => `- ${change.file} (${change.surfaces.join(", ")})`),
    "",
    ...result.issues,
    "",
    "How to fix: add `## Governance Declaration` / `## 治理声明` to the PR body, cite the authorizing ADR/decision/task, and fill break-glass fields only when used."
  ].join("\n"));
  process.stderr.write("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const body = readBody(args);
    if (shouldSkipPrBodyBilingualCheck({
      body,
      headRefName: process.env.PR_HEAD_REF ?? "",
      authorLogin: process.env.PR_AUTHOR_LOGIN ?? ""
    })) {
      process.stdout.write("PR governance declaration check skipped for Mergify merge-queue verification PR.\n");
      process.exit(0);
    }

    const manifest = readJson(args.manifest);
    const changedFiles = readChangedFiles(args);
    const result = checkPrGovernance({ body, changedFiles, manifest });
    printResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`PR governance declaration check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
