// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { taskPackagePath } from "../../src/layout/index.ts";
import { withTempStore } from "../store/helpers.ts";

const taskId = "task_01KZ6MD2SMMHH91WC3RMRPV4P2";

test("taskPackagePath reaches all supported bare and slug package shapes", () => {
  const cases = [
    {
      name: "bare-with-INDEX",
      setup: (rootDir: string) => {
        writeTaskIndex(rootDir, taskId, taskId);
      },
      expected: (rootDir: string) => path.join(rootDir, "harness/tasks", taskId)
    },
    {
      name: "orphan-bare-no-INDEX",
      setup: (rootDir: string) => {
        mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
      },
      expected: (rootDir: string) => path.join(rootDir, "harness/tasks", taskId)
    },
    {
      name: "slug-only",
      setup: (rootDir: string) => {
        writeTaskIndex(rootDir, `${taskId}-slug`, taskId);
      },
      expected: (rootDir: string) => path.join(rootDir, "harness/tasks", `${taskId}-slug`)
    },
    {
      name: "bare+slug",
      setup: (rootDir: string) => {
        mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
        writeTaskIndex(rootDir, `${taskId}-slug`, taskId);
      },
      expected: (rootDir: string) => path.join(rootDir, "harness/tasks", `${taskId}-slug`)
    }
  ] as const;

  for (const fixture of cases) {
    withTempStore((rootDir) => {
      fixture.setup(rootDir);
      assert.equal(taskPackagePath(rootDir, taskId), fixture.expected(rootDir), fixture.name);
    });
  }
});

function writeTaskIndex(rootDir: string, directoryName: string, taskIdValue: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", directoryName);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), `---\ntask_id: ${taskIdValue}\n---\n`, "utf8");
}
