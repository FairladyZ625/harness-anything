// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import test from "node:test";
import { createPackageBoundaryPlugin, packageBoundaryMessageIds } from "./eslint-package-boundaries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruleId = "package-boundaries/enforce";
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    plugins: { "package-boundaries": createPackageBoundaryPlugin(root) },
    rules: { [ruleId]: "warn" }
  }
});
const configuredEslint = new ESLint({ cwd: root });

test("package boundary ESLint rule reports every governed violation class", async () => {
  const cases = [
    ["packages/kernel/src/fixture.ts", "import '@harness-anything/gui';", packageBoundaryMessageIds.forbiddenEdge],
    ["packages/application/src/fixture.ts", "import '../../kernel/src/index.ts';", packageBoundaryMessageIds.crossPackageRelative],
    ["packages/cli/src/fixture.ts", "import '@harness-anything/kernel/write-coordination/write-helpers';", packageBoundaryMessageIds.unregisteredDeepSubpath],
    ["packages/gui/src/main/fixture.ts", "new URL('../../../daemon/src/index.ts', import.meta.url);", packageBoundaryMessageIds.crossPackageSourcePath]
  ];
  for (const [file, source, messageId] of cases) {
    const [result] = await eslint.lintText(source, { filePath: path.join(root, file) });
    assert.ok(result.messages.some((message) => message.ruleId === ruleId && message.messageId === messageId), `${messageId} positive control`);
  }
});

test("package boundary ESLint rule accepts allowed roots and registered subpaths", async () => {
  const [result] = await eslint.lintText("import '@harness-anything/kernel';", { filePath: path.join(root, "packages/application/src/fixture.ts") });
  assert.equal(result.messages.filter((message) => message.ruleId === ruleId).length, 0);
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
      result.messages.some((message) => message.ruleId === ruleId && message.messageId === packageBoundaryMessageIds.unregisteredDeepSubpath),
      `${label} positive control`
    );
  }
});

test("kernel import debt overrides allow only the registered edge", async () => {
  const cases = [
    {
      file: "packages/adapters/local/src/index.ts",
      allowed: "import '@harness-anything/kernel/store/index';",
      forbidden: "import '../../../kernel/src/persistence/markdown/markdown-artifact-store.ts';"
    },
    {
      file: "packages/adapters/multica/test/multica-readonly-adopt.test.ts",
      allowed: "import '../../../kernel/src/store/index.ts';",
      forbidden: "import '../../../kernel/src/persistence/markdown/markdown-artifact-store.ts';"
    }
  ];

  for (const fixture of cases) {
    const [allowed] = await configuredEslint.lintText(fixture.allowed, { filePath: path.join(root, fixture.file) });
    assert.equal(
      allowed.messages.filter((message) => message.ruleId === "no-restricted-imports").length,
      0,
      `${fixture.file} registered edge`
    );

    const [forbidden] = await configuredEslint.lintText(fixture.forbidden, { filePath: path.join(root, fixture.file) });
    assert.ok(
      forbidden.messages.some((message) => message.ruleId === "no-restricted-imports"),
      `${fixture.file} other deep import positive control`
    );
  }
});
