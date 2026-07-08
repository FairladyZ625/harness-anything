import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boundaryMessage = "Kernel/application physical I/O must be routed through an explicit port implementation file.";

test("ESLint rejects new kernel/application physical I/O imports outside explicit port implementation files", async () => {
  const eslint = new ESLint({ cwd: repoRoot });

  const cases = [
    {
      filePath: "packages/kernel/src/domain/port-boundary-fixture.ts",
      source: 'import { readFileSync } from "node:fs";\nexport const value = readFileSync;\n'
    },
    {
      filePath: "packages/application/src/port-boundary-fixture.ts",
      source: 'import { execFileSync } from "node:child_process";\nexport const value = execFileSync;\n'
    },
    {
      filePath: "packages/kernel/src/domain/port-boundary-dynamic-fixture.ts",
      source: 'export const load = () => import("node:fs/promises");\n'
    },
    {
      filePath: "packages/application/src/port-boundary-require-fixture.js",
      source: 'const cp = require("child_process");\nexport const value = cp;\n'
    }
  ];

  for (const testCase of cases) {
    const [result] = await eslint.lintText(testCase.source, {
      filePath: path.join(repoRoot, testCase.filePath)
    });
    assert.ok(
      result.messages.some((message) => message.message.includes(boundaryMessage)),
      `${testCase.filePath} should report the physical I/O boundary`
    );
  }
});

test("ESLint preserves precise file-level physical I/O exemptions", async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(
    'import { execFileSync } from "node:child_process";\nexport const value = execFileSync;\n',
    {
      filePath: path.join(repoRoot, "packages/kernel/src/store/local-version-control-system.ts")
    }
  );

  assert.equal(
    result.messages.some((message) => message.message.includes(boundaryMessage)),
    false
  );
});
