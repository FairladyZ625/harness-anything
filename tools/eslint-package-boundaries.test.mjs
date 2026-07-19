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

test("package boundary ESLint rule reports every governed violation class", async () => {
  const cases = [
    ["packages/kernel/src/fixture.ts", "import '@harness-anything/gui';", packageBoundaryMessageIds.forbiddenEdge],
    ["packages/application/src/fixture.ts", "import '../../kernel/src/index.ts';", packageBoundaryMessageIds.crossPackageRelative],
    ["packages/cli/src/fixture.ts", "import '@harness-anything/kernel/private';", packageBoundaryMessageIds.unregisteredDeepSubpath],
    ["packages/gui/src/main/fixture.ts", "new URL('../../../daemon/src/index.ts', import.meta.url);", packageBoundaryMessageIds.crossPackageSourcePath]
  ];
  for (const [file, source, messageId] of cases) {
    const [result] = await eslint.lintText(source, { filePath: path.join(root, file) });
    assert.ok(result.messages.some((message) => message.ruleId === ruleId && message.messageId === messageId), `${messageId} positive control`);
  }
});

test("package boundary ESLint rule accepts allowed roots and registered subpaths", async () => {
  const [result] = await eslint.lintText([
    "import '@harness-anything/kernel';",
    "import '@harness-anything/kernel/write-coordination/write-helpers';"
  ].join("\n"), { filePath: path.join(root, "packages/application/src/fixture.ts") });
  assert.equal(result.messages.filter((message) => message.ruleId === ruleId).length, 0);
});
