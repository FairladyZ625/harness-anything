// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import test from "node:test";
import { createPackageBoundaryPlugin, packageBoundaryMessageIds } from "./eslint-package-boundaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adjacencyRuleId = "package-boundaries/adjacency";
const pathsRuleId = "package-boundaries/paths";
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    plugins: { "package-boundaries": createPackageBoundaryPlugin(root) },
    rules: { [adjacencyRuleId]: "error", [pathsRuleId]: "warn" }
  }
});

test("package boundary ESLint rule reports every governed violation class", async () => {
  const cases = [
    ["packages/kernel/src/fixture.ts", "import '@harness-anything/gui';", packageBoundaryMessageIds.forbiddenEdge],
    ["packages/application/src/fixture.ts", "import '../../kernel/src/index.ts';", packageBoundaryMessageIds.crossPackageRelative],
    ["packages/cli/src/fixture.ts", "import '@harness-anything/kernel/write-coordination/write-helpers';", packageBoundaryMessageIds.unregisteredDeepSubpath],
    ["packages/gui/src/main/fixture.ts", "new URL('../../../daemon/src/index.ts', import.meta.url);", packageBoundaryMessageIds.crossPackageSourcePath],
    ["packages/gui/src/main/fixture.ts", "const target = `../../../daemon/src/index.ts`;", packageBoundaryMessageIds.crossPackageSourcePath]
  ];
  for (const [file, source, messageId] of cases) {
    const [result] = await eslint.lintText(source, { filePath: path.join(root, file) });
    const expectedRuleId = messageId === packageBoundaryMessageIds.forbiddenEdge ? adjacencyRuleId : pathsRuleId;
    assert.ok(result.messages.some((message) => message.ruleId === expectedRuleId && message.messageId === messageId), `${messageId} positive control`);
  }
});

test("package boundary ESLint rule accepts allowed roots and registered subpaths", async () => {
  const [result] = await eslint.lintText("import '@harness-anything/kernel';", { filePath: path.join(root, "packages/application/src/fixture.ts") });
  assert.equal(result.messages.filter((message) => message.ruleId === adjacencyRuleId || message.ruleId === pathsRuleId).length, 0);
});

test("package boundary ESLint rule inspects every module-bearing handler", async () => {
  const cases = [
    ["export named", "export { value } from '@harness-anything/kernel/private';"],
    ["export all", "export * from '@harness-anything/kernel/private';"],
    ["dynamic import", "void import('@harness-anything/kernel/private');"],
    ["require", "require('@harness-anything/kernel/private');"],
    ["TypeScript import type", "type Private = import('@harness-anything/kernel/private').Private;"]
  ];
  for (const [label, source] of cases) {
    const [result] = await eslint.lintText(source, { filePath: path.join(root, "packages/application/src/fixture.ts") });
    assert.ok(
      result.messages.some((message) => message.ruleId === pathsRuleId && message.messageId === packageBoundaryMessageIds.unregisteredDeepSubpath),
      `${label} positive control`
    );
  }
});
