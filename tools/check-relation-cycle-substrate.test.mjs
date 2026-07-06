import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-relation-cycle-substrate.mjs");

test("relation cycle substrate check accepts the repository canonical detector", () => {
  const result = runChecker(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /single entity-relation cycle substrate/);
});

test("relation cycle substrate check rejects a second relation-edge DFS implementation", () => {
  const root = makeFixtureRoot();
  try {
    writeCanonicalDetector(root);
    mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
    writeFileSync(path.join(root, "packages/cli/src/commands/relation-cycle.ts"), [
      "import type { RelationGraphEdgeRow } from '../../../../kernel/src/index.ts';",
      "export function detectRelationCycleAgain(edges: ReadonlyArray<RelationGraphEdgeRow>) {",
      "  const visiting = new Set<string>();",
      "  const visited = new Set<string>();",
      "  const stack = [];",
      "  function visit(ref: string) {",
      "    if (visiting.has(ref)) return stack;",
      "    if (visited.has(ref)) return null;",
      "    visiting.add(ref);",
      "    for (const edge of edges) { if (edge.sourceRef === ref) visit(edge.targetRef); }",
      "    visited.add(ref);",
      "    return null;",
      "  }",
      "  return visit(edges[0]?.sourceRef ?? '');",
      "}"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /relation-cycle\.ts/);
    assert.match(result.stderr, /must delegate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relation cycle substrate check allows wrappers that delegate to the canonical detector", () => {
  const root = makeFixtureRoot();
  try {
    writeCanonicalDetector(root);
    mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
    writeFileSync(path.join(root, "packages/cli/src/commands/relation-cycle.ts"), [
      "import { detectRelationGraphCycles, type RelationGraphEdgeRow } from '../../../../kernel/src/index.ts';",
      "export function detectPendingRelationCycle(edges: ReadonlyArray<RelationGraphEdgeRow>) {",
      "  return detectRelationGraphCycles(edges)[0] ?? null;",
      "}"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-f8b-cycle-"));
  mkdirSync(path.join(root, "packages/kernel/src/projection"), { recursive: true });
  mkdirSync(path.join(root, "tools"), { recursive: true });
  return root;
}

function writeCanonicalDetector(root) {
  writeFileSync(path.join(root, "packages/kernel/src/projection/relation-graph-projection.ts"), [
    "export interface RelationGraphEdgeRow { readonly sourceRef: string; readonly targetRef: string; readonly relationType: string; readonly state: string; }",
    "export function detectRelationGraphCycles(edges: ReadonlyArray<RelationGraphEdgeRow>) {",
    "  return edges.length > 0 ? [] : [];",
    "}"
  ].join("\n"), "utf8");
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8",
    env: process.env
  });
}
