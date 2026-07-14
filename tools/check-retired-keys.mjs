#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findRetiredAttributionFields } from "../packages/kernel/src/domain/retired-attribution-field-cleanup.ts";
import { resolveHarnessLayout } from "../packages/kernel/src/layout/index.ts";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

export function checkRetiredKeys(root = DEFAULT_ROOT) {
  const layout = resolveHarnessLayout(root);
  // A checker that scans nothing must never report "passed". The canonical ledger lives in
  // harness/, a private git-ignored subrepo absent from public checkouts, so an empty scan is
  // expected there — but it is a skip, not a pass. And a ledger root that exists yet yields zero
  // documents means the instrument is pointed at the wrong place; that is louder than any finding.
  const ledgerPresent = existsSync(layout.tasksRoot) || existsSync(layout.decisionsRoot);
  if (!ledgerPresent) return { ok: true, skipped: true, findings: [], counts: { tasks: 0, decisions: 0, retiredKeys: 0 } };

  const documents = [
    ...listAuthoredDocuments(layout.tasksRoot, "INDEX.md", "task-index"),
    ...listAuthoredDocuments(layout.decisionsRoot, "decision.md", "decision")
  ];
  if (documents.length === 0) {
    throw new Error(
      `ledger root exists (${layout.authoredRoot}) but holds 0 authored documents; ` +
      "the checker scanned nothing, so a green result would be meaningless"
    );
  }

  const findings = [];
  const counts = { tasks: 0, decisions: 0, retiredKeys: 0 };

  for (const document of documents) {
    if (document.kind === "task-index") counts.tasks += 1;
    else counts.decisions += 1;

    let keys;
    try {
      keys = findRetiredAttributionFields(readFileSync(document.path, "utf8"), document.kind);
    } catch (error) {
      findings.push(`${relativePath(layout.authoredRoot, document.path)}: cannot parse authored frontmatter: ${error.message}`);
      continue;
    }
    for (const key of keys) {
      counts.retiredKeys += 1;
      findings.push(`${relativePath(layout.authoredRoot, document.path)}: retired top-level key ${key}`);
    }
  }

  return { ok: findings.length === 0, skipped: false, findings, counts };
}

function listAuthoredDocuments(root, fileName, kind) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, fileName))
    .filter((file) => existsSync(file))
    .sort()
    .map((file) => ({ path: file, kind }));
}

function relativePath(authoredRoot, file) {
  return path.relative(authoredRoot, file).split(path.sep).join("/");
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return { root: DEFAULT_ROOT };
  if (argv[rootIndex + 1] === undefined) throw new Error("--root requires a path");
  if (argv.length !== 2 || rootIndex !== 0) throw new Error("usage: check-retired-keys [--root <project-root>]");
  return { root: path.resolve(argv[rootIndex + 1]) };
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const audit = checkRetiredKeys(root);
  if (audit.skipped) {
    console.log(
      "Retired key check SKIPPED: no canonical ledger in this checkout (harness/ is a private, " +
      "git-ignored subrepo). Nothing was scanned — this is not a pass."
    );
    return;
  }
  if (!audit.ok) {
    for (const finding of audit.findings) console.error(`retired key check: ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Retired key check passed: ${audit.counts.tasks} task INDEX.md, ` +
    `${audit.counts.decisions} decision.md, ${audit.counts.retiredKeys} retired keys.`
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Retired key check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
