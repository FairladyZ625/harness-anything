// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasContractEvidence,
  eventStoreEvidence,
  missingEventStoreEvidence,
} from "../../implementation-contract-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

test("contract markers require an exact ID beside a test declaration", () => {
  assert.equal(hasContractEvidence('// harness-contract: sample.id\ntest("any title", () => {});', "sample.id"), true);
  for (const source of [
    'test("sample.id", () => {});',
    '// harness-contract: sample.id.extra\ntest("title", () => {});',
    '// harness-contract: sample.id\nconst unrelated = true;\ntest("title", () => {});',
  ])
    assert.equal(hasContractEvidence(source, "sample.id"), false);
  assert.deepEqual(missingEventStoreEvidence(eventStoreEvidence.join("\n"), ""), []);
  for (const point of ["before_event_write", "after_event_write", "after_head_write", "after_git_commit"])
    assert.deepEqual(missingEventStoreEvidence(eventStoreEvidence.filter((value) => value !== point).join("\n"), ""), [
      point,
    ]);
});

test("implementation contracts remain on the required boundaries path", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"));
  const gate = manifest.gates.find((entry) => entry.id === "check-implementation-contracts");
  assert.equal(gate.tier, "pr-required");
  assert.ok(gate.githubContext.requiredContexts.includes("boundaries"));
  assert.ok(gate.githubContext.workflowJobs.includes("boundaries"));
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["harness:check-implementation-contracts"], "node tools/check-implementation-contracts.mjs");
  assert.match(
    readFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), "utf8"),
    /node tools\/run-manifest-gates\.mjs --workflow-job boundaries/,
  );
});

test("real implementation gate accepts renamed titles and rejects each missing or misplaced contract marker", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "implementation-contract-"));
  try {
    const files = globSync(["packages/**/*", "package.json", "package-lock.json", "tsconfig.json"], {
      cwd: root,
      withFileTypes: true,
      exclude: ["**/node_modules/**", "**/dist/**"],
    })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
    const anchors = [];
    for (const file of files) {
      const destination = path.join(fixture, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, file), destination);
      if (!file.endsWith(".test.ts")) continue;
      const source = readFileSync(destination, "utf8");
      for (const match of source.matchAll(/^[ \t]*\/\/ harness-contract: ([a-z0-9.-]+)$/gm))
        anchors.push({ file, marker: match[0], id: match[1] });
    }
    assert.equal(anchors.length, 15);
    const run = () =>
      spawnSync(process.execPath, [path.join(root, "tools/check-implementation-contracts.mjs")], {
        cwd: fixture,
        encoding: "utf8",
      });
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stderr);
    let renamedCount = 0;
    for (const file of new Set(anchors.map((anchor) => anchor.file))) {
      const destination = path.join(fixture, file);
      writeFileSync(
        destination,
        readFileSync(destination, "utf8").replace(
          /(\/\/ harness-contract: [a-z0-9.-]+\r?\n\s*test\(\s*)(?:"[^"\n]*"|`[^`\n]*`)/g,
          (_title, declaration) => {
            renamedCount += 1;
            return `${declaration}"freely edited human title"`;
          },
        ),
      );
    }
    assert.equal(renamedCount, 15);
    const renamed = run();
    assert.equal(renamed.status, 0, renamed.stderr);
    assert.equal(renamed.stdout, baseline.stdout);
    for (const { file, marker, id } of anchors) {
      const destination = path.join(fixture, file);
      const source = readFileSync(destination, "utf8");
      writeFileSync(destination, source.replace(marker, ""));
      // The ID still exists beside a test in another file: file identity must matter.
      writeFileSync(path.join(fixture, "packages/misplaced.test.ts"), `${marker}\ntest("moved", () => {});\n`);
      const missing = run();
      assert.equal(missing.status, 1, missing.stdout);
      assert.match(missing.stderr, new RegExp(`missing test contract marker ${id.replaceAll(".", "\\.")}`));
      writeFileSync(destination, source);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
