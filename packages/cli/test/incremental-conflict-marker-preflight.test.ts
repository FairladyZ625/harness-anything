// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeIncrementalConflictMarkerPreflight,
  type IncrementalConflictMarkerPreflightScan
} from "../src/composition/incremental-conflict-marker-preflight.ts";

test("generation conflict preflight scans cumulative authored state once and later scans only deltas", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-conflict-marker-generation-"));
  const authoredRoot = path.join(rootDir, "harness");
  const scans: IncrementalConflictMarkerPreflightScan[] = [];
  try {
    mkdirSync(path.join(authoredRoot, "scale"), { recursive: true });
    writeFileSync(path.join(authoredRoot, "harness.yaml"), "schema: harness-anything/v1\n");
    writeFileSync(path.join(authoredRoot, ".gitignore"), "late.md\n");
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(path.join(authoredRoot, "scale", `${index}.txt`), "clean\n");
    }
    git(authoredRoot, "init", "-b", "main");
    git(authoredRoot, "config", "user.name", "Harness Test");
    git(authoredRoot, "config", "user.email", "harness@example.test");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-m", "seed cumulative authored state");

    const preflight = makeIncrementalConflictMarkerPreflight(
      { rootDir },
      { onScan: (scan) => scans.push(scan) }
    );

    assert.equal(preflight.read(), undefined);
    assert.equal(preflight.read(), undefined);
    assert.deepEqual(scans.map((scan) => scan.mode), ["full", "incremental"]);
    assert.equal(scans[0]!.candidateCount, undefined);
    assert.equal(scans[1]!.candidateCount, 2);

    mkdirSync(path.join(authoredRoot, "node_modules", "ignored-package"), { recursive: true });
    writeFileSync(
      path.join(authoredRoot, "node_modules", "ignored-package", "README.md"),
      conflictMarker()
    );
    assert.equal(preflight.read(), undefined);
    assert.equal(scans.at(-1)?.candidateCount, 2);

    writeFileSync(path.join(authoredRoot, "late.md"), conflictMarker());
    const lateWarning = preflight.read();
    assert.equal(lateWarning?.code, "conflict_marker_present");
    assert.match(lateWarning?.message ?? "", /harness\/late\.md/u);
    assert.equal(scans.at(-1)?.mode, "incremental");
    assert.equal(scans.at(-1)?.candidateCount, 3);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("generation conflict preflight observes committed deltas and root policy files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-conflict-marker-delta-"));
  const authoredRoot = path.join(rootDir, "harness");
  try {
    mkdirSync(authoredRoot, { recursive: true });
    writeFileSync(path.join(authoredRoot, "tracked.md"), "clean\n");
    git(authoredRoot, "init", "-b", "main");
    git(authoredRoot, "config", "user.name", "Harness Test");
    git(authoredRoot, "config", "user.email", "harness@example.test");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-m", "seed");

    const preflight = makeIncrementalConflictMarkerPreflight({ rootDir });
    assert.equal(preflight.read(), undefined);

    writeFileSync(path.join(authoredRoot, "tracked.md"), conflictMarker());
    git(authoredRoot, "add", "tracked.md");
    git(authoredRoot, "commit", "-m", "introduce marker");
    assert.equal(preflight.read()?.code, "conflict_marker_present");

    writeFileSync(path.join(authoredRoot, "tracked.md"), "clean again\n");
    git(authoredRoot, "add", "tracked.md");
    git(authoredRoot, "commit", "-m", "resolve marker");
    assert.equal(preflight.read(), undefined);

    writeFileSync(path.join(rootDir, "AGENTS.md"), conflictMarker());
    assert.equal(preflight.read()?.code, "conflict_marker_present");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function conflictMarker(): string {
  return "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n";
}

function git(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}
