// harness-test-tier: fast
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout, sha256Text } from "@harness-anything/kernel";
import { applyCanonicalTree } from "../../src/canonical-tree-materialization.ts";

function captureAuthoredReads<T>(authoredRoot: string, fn: () => T): { result: T; readPaths: string[] } {
  const normalizedRoot = path.resolve(authoredRoot) + path.sep;
  const readPaths: string[] = [];
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function trackedReadFileSync(filePath: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    if (typeof filePath === "string") {
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(normalizedRoot)) {
        readPaths.push(resolved.slice(normalizedRoot.length).split(path.sep).join("/"));
      }
    }
    return (originalReadFileSync as (...args: unknown[]) => unknown).call(this, filePath, ...rest) as ReturnType<
      typeof fs.readFileSync
    >;
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    return { result: fn(), readPaths };
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}

test("applyCanonicalTree skips disk reads when changedPaths is empty and revision is unchanged", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-canonical-empty-"));
  try {
    const layout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "authored" } });
    const markerPath = path.join(rootDir, "fleet-materialized.json");
    const bodies = new Map<string, string>([
      ["tasks/task_a/task_plan.md", "# Task A\n"],
      ["tasks/task_b/task_plan.md", "# Task B\n"],
    ]);
    const entries = new Map([...bodies].map(([logical, body]) => [logical, { sha256: sha256Text(body) }]));
    applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 10,
      entries,
      readContent: (logical) => Buffer.from(bodies.get(logical)!),
    });

    const { result, readPaths } = captureAuthoredReads(layout.authoredRoot, () =>
      applyCanonicalTree({
        layout,
        markerPath,
        generation: 1,
        revision: 10,
        entries,
        changedPaths: [],
        readContent: (logical) => Buffer.from(bodies.get(logical)!),
      }),
    );
    assert.deepEqual(result.dirtyPaths, []);
    assert.deepEqual(result.settlements, []);
    assert.deepEqual(readPaths, [], "empty changedPaths must perform 0 readFileSync on materialized files");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("applyCanonicalTree detects immediate and post-racy-window same-byte-length local tampers", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-canonical-tamper-"));
  try {
    const layout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "authored" } });
    const markerPath = path.join(rootDir, "fleet-materialized.json");
    const logical = "tasks/task_tamper/task_plan.md";
    const originalBody = "AAAA-original-content\n";
    const tamperedSameLength = "BBBB-tampered-content\n";
    const centerUpdatedBody = "CCCC-center-updated!!\n";
    assert.equal(Buffer.byteLength(originalBody), Buffer.byteLength(tamperedSameLength));

    const entriesV1 = new Map([[logical, { sha256: sha256Text(originalBody) }]]);
    applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: entriesV1,
      readContent: () => Buffer.from(originalBody),
    });

    // 1. Immediate same-byte-length overwrite within the same timer tick (racy window).
    const filePath = path.join(layout.authoredRoot, ...logical.split("/"));
    writeFileSync(filePath, tamperedSameLength);

    const immediateFull = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: entriesV1,
      readContent: () => Buffer.from(originalBody),
    });
    assert.deepEqual(
      immediateFull.dirtyPaths,
      [logical],
      "immediate same-byte-length tamper within racy window must be detected",
    );
    assert.equal(readFileSync(filePath, "utf8"), tamperedSameLength);

    // 2. Restore clean file, backdate mtime outside racy window, verify stat fast-path skips readFileSync.
    writeFileSync(filePath, originalBody);
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(filePath, oldTime, oldTime);
    // First full pass populates stats for the backdated file.
    const populate = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: entriesV1,
      readContent: () => Buffer.from(originalBody),
    });
    assert.deepEqual(populate.dirtyPaths, []);

    // Second full pass with unchanged center blob and file outside racy window skips readFileSync.
    const { result: fastPass, readPaths: fastReads } = captureAuthoredReads(layout.authoredRoot, () =>
      applyCanonicalTree({
        layout,
        markerPath,
        generation: 1,
        revision: 1,
        entries: entriesV1,
        readContent: () => Buffer.from(originalBody),
      }),
    );
    assert.deepEqual(fastPass.dirtyPaths, []);
    assert.deepEqual(fastReads, [], "clean file outside racy window must skip readFileSync via stat fast-path");

    // 3. Post-racy-window same-byte-length tamper updates mtimeMs and must be detected on both full and incremental passes.
    writeFileSync(filePath, tamperedSameLength);
    const postRacyFull = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: entriesV1,
      readContent: () => Buffer.from(originalBody),
    });
    assert.deepEqual(postRacyFull.dirtyPaths, [logical], "post-racy same-byte-length tamper must be detected");

    const entriesV2 = new Map([[logical, { sha256: sha256Text(centerUpdatedBody) }]]);
    const postRacyIncremental = applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 2,
      entries: entriesV2,
      changedPaths: [logical],
      readContent: () => Buffer.from(centerUpdatedBody),
    });
    assert.deepEqual(
      postRacyIncremental.dirtyPaths,
      [logical],
      "incremental center update must preserve locally tampered same-size file",
    );
    assert.equal(readFileSync(filePath, "utf8"), tamperedSameLength);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("applyCanonicalTree incremental pass reads only selected paths and leaves unrelated files untouched", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-canonical-narrow-"));
  try {
    const layout = resolveHarnessLayout({ rootDir, layoutOverrides: { authoredRoot: "authored" } });
    const markerPath = path.join(rootDir, "fleet-materialized.json");
    const bodies = new Map<string, string>([
      ["tasks/task_one/task_plan.md", "# Task 1\n"],
      ["tasks/task_two/task_plan.md", "# Task 2\n"],
      ["tasks/task_three/task_plan.md", "# Task 3\n"],
    ]);
    const entriesV1 = new Map([...bodies].map(([logical, body]) => [logical, { sha256: sha256Text(body) }]));
    applyCanonicalTree({
      layout,
      markerPath,
      generation: 1,
      revision: 1,
      entries: entriesV1,
      readContent: (logical) => Buffer.from(bodies.get(logical)!),
    });

    const updatedBody = "# Task 1 updated\n";
    bodies.set("tasks/task_one/task_plan.md", updatedBody);
    const entriesV2 = new Map([
      ["tasks/task_one/task_plan.md", { sha256: sha256Text(updatedBody) }],
      ["tasks/task_two/task_plan.md", { sha256: sha256Text(bodies.get("tasks/task_two/task_plan.md")!) }],
    ]);

    const { result, readPaths } = captureAuthoredReads(layout.authoredRoot, () =>
      applyCanonicalTree({
        layout,
        markerPath,
        generation: 1,
        revision: 2,
        entries: entriesV2,
        changedPaths: ["tasks/task_one/task_plan.md", "tasks/task_three/task_plan.md"],
        readContent: (logical) => Buffer.from(bodies.get(logical)!),
      }),
    );
    assert.deepEqual(result.dirtyPaths, []);
    assert.deepEqual(
      readPaths.sort(),
      ["tasks/task_one/task_plan.md", "tasks/task_three/task_plan.md"],
      "incremental pass must only read explicitly changed/deleted paths",
    );
    assert.equal(readFileSync(path.join(layout.authoredRoot, "tasks/task_one/task_plan.md"), "utf8"), updatedBody);
    assert.equal(existsSync(path.join(layout.authoredRoot, "tasks/task_three/task_plan.md")), false);
    assert.equal(existsSync(path.join(layout.authoredRoot, "tasks/task_three")), false);
    assert.ok(existsSync(path.join(layout.authoredRoot, "tasks/task_two/task_plan.md")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
