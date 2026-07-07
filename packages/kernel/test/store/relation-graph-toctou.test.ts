import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withTempStore } from "./helpers.ts";

test("relation graph projection tolerates facts.md that vanishes after task enumeration", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-vanished-facts", "Task Vanished Facts");
    const factsPath = path.join(rootDir, "harness/tasks/task-vanished-facts/facts.md");
    writeFileSync(factsPath, [
      "# Facts",
      "",
      "- {fact_id: F-DEADBEEF, statement: \"This fact disappears during a concurrent scan.\", source: \"test\", observedAt: \"2026-07-03T00:00:00.000Z\", confidence: high}",
      ""
    ].join("\n"), "utf8");
    const preloadPath = writeVanishedReadPreload(rootDir, factsPath);

    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", [
      "import { buildRelationGraphProjection } from './packages/kernel/src/index.ts';",
      "const graph = buildRelationGraphProjection({ rootDir: process.env.HA_ROOT });",
      "console.log(JSON.stringify({ edgeCount: graph.edges.length, factAnchorCount: graph.factAnchors.length }));"
    ].join("\n")], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, HA_ROOT: rootDir, NODE_OPTIONS: `--require ${preloadPath}` }
    });

    assert.deepEqual(JSON.parse(stdout), { edgeCount: 0, factAnchorCount: 0 });
  });
});

function writeIndex(rootDir: string, taskDirName: string, title: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskDirName);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskDirName}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-03T00:00:00.000Z",
    "  bindingFingerprint: ",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeVanishedReadPreload(rootDir: string, vanishedPath: string): string {
  const preloadPath = path.join(rootDir, "vanished-preload.cjs");
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    `const vanishedPath = ${JSON.stringify(vanishedPath)};`,
    "const originalReadFileSync = fs.readFileSync;",
    "fs.readFileSync = function patchedReadFileSync(filePath, ...args) {",
    "  if (String(filePath) === vanishedPath) {",
    "    const error = new Error(`ENOENT: no such file or directory, open '${vanishedPath}'`);",
    "    error.code = 'ENOENT';",
    "    error.path = vanishedPath;",
    "    throw error;",
    "  }",
    "  return originalReadFileSync.call(this, filePath, ...args);",
    "};",
    "syncBuiltinESMExports();",
    ""
  ].join("\n"), "utf8");
  return preloadPath;
}
