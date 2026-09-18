// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { settingValuePattern } from "../../kernel/src/index.ts";
import {
  listBundledAgentDeclarationIds,
  listRepositoryWorkflowNames,
  readBundledAgentDeclaration,
} from "../src/index.ts";

const write = (target: string, body = "name: probe\non: push\n") => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
};

test("workflow enumeration offers extension-less *.yml basenames that the settings schema accepts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workflows-"));
  try {
    const workflows = path.join(root, ".github", "workflows");
    write(path.join(workflows, "gui-release.yml"));
    write(path.join(workflows, "issue-intake.yml"));
    write(path.join(workflows, "pr-body.yml"));
    // .yaml 文件不产出取值:观察路径硬编码追加 .yml,.yaml 基名拼出的名字永远跑不起来。
    write(path.join(workflows, "yaml-only.yaml"));
    // 非 .yml 后缀与子目录里的 workflow 一律不进面。
    write(path.join(workflows, "notes.txt"));
    write(path.join(workflows, "nested/rebuild-gates.yml"));
    // 文件名剥掉后缀后不满足 settings 值 pattern 的(kernel 会拒)不进面。
    write(path.join(workflows, "bad name.yml"));
    write(path.join(workflows, ".hidden.yml"));
    // 指向别处的符号链接不进面(与 bundled agent 读取的符号链接拒绝一致)。
    symlinkSync(path.join(workflows, "gui-release.yml"), path.join(workflows, "linked.yml"));
    const names = listRepositoryWorkflowNames(root);
    assert.deepEqual(names, ["gui-release", "issue-intake", "pr-body"]);
    for (const name of names) {
      assert.match(name, new RegExp(settingValuePattern, "u"));
      assert.doesNotMatch(name, /\.ya?ml$/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow enumeration returns the empty face for a repository without .github/workflows", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workflows-empty-"));
  try {
    assert.deepEqual(listRepositoryWorkflowNames(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled agent ids are enumerable and every offered id resolves to a bundled declaration", () => {
  const ids = listBundledAgentDeclarationIds();
  assert.ok(ids.includes("closeout-reviewer"), `bundled face must offer the default reviewer: ${ids.join(", ")}`);
  for (const id of ids) assert.ok(readBundledAgentDeclaration(id)?.id === id);
});
