import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI milestone-dossier gather script writes focused dossier data from relation graph projection", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Milestone Dossier", "--vertical", "software/coding", "--preset", "milestone-dossier"]);
    writeFile(rootDir, `${created.packagePath}/facts.md`, [
      "# Facts",
      "",
      "- {fact_id: F-DEADBEEF, statement: \"Gather has anchored coverage.\", source: \"test fixture\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
      ""
    ].join("\n"));
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_GATHER",
      "--title",
      "Gather Decision",
      "--question",
      "Should gather read relation coverage?",
      "--chosen",
      "Read relation coverage",
      "--rejected",
      "Rebuild a separate graph",
      "--why-not",
      "The relation graph projection is already the source of truth",
      "--evidence-relation",
      `C1:supersedes-fact:fact/${created.taskId}/F-DEADBEEF:Fact F-DEADBEEF supersedes gather claim`
    ]);
    runJson(rootDir, ["task", "list"]);

    const result = runJson(rootDir, ["script", "run", "preset:milestone-dossier:gather", "--task", created.taskId, "--input", "decisionId=dec_GATHER"]);

    assert.equal(result.ok, true);
    assert.equal(result.script.id, "preset:milestone-dossier:gather");
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("artifacts/dossier.data.json")), true);
    const data = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "artifacts", "dossier.data.json"), "utf8"));
    assert.equal(data.schema, "milestone-dossier-data/v1");
    assert.equal(data.coordinationTaskId, created.taskId);
    assert.equal(data.decisionId, "dec_GATHER");
    assert.equal(data.coverageRows.some((row: Record<string, unknown>) => row.claimRef === "decision/dec_GATHER/C1" && row.status === "covered"), true);
    assert.equal(data.facts.some((fact: Record<string, unknown>) => fact.factRef === `fact/${created.taskId}/F-DEADBEEF`), true);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-script-dossier-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
