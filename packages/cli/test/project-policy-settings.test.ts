// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_EXECUTION_CONSENT_TTL_MS,
  DEFAULT_MULTICA_STALE_TTL_MS,
  resolveExecutionConsentTtlMs,
  resolveMulticaStaleTtlMs
} from "../src/commands/project-policy-settings.ts";
import {
  readProjectHarnessSettings
} from "../src/commands/settings.ts";
import {
  DEFAULT_TASK_WIP_LIMIT,
  readTaskWipSnapshot,
  resolveTaskWipLimit
} from "../src/commands/task-wip-settings.ts";

test("task WIP limit resolves default and project YAML", () => {
  withRoot((rootDir) => {
    assert.deepEqual(resolveTaskWipLimit(rootDir), {
      ok: true,
      limit: DEFAULT_TASK_WIP_LIMIT
    });
    writeSettings(rootDir, [
      "settings:",
      "  tasks:",
      "    wipLimit: 7"
    ]);
    assert.deepEqual(resolveTaskWipLimit(rootDir), { ok: true, limit: 7 });
    assert.equal(readProjectHarnessSettings(rootDir).ok, true);
  });
});

test("task WIP limit rejects non-positive and non-integer project YAML", () => {
  for (const value of ["0", "-1", "1.5", "nope"]) {
    withRoot((rootDir) => {
      writeSettings(rootDir, [
        "settings:",
        "  tasks:",
        `    wipLimit: ${value}`
      ]);
      const result = resolveTaskWipLimit(rootDir);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.result.error?.hint ?? "", /settings\.tasks\.wipLimit must be a positive integer/u);
      }
    });
  }
});

test("task WIP snapshot reads the configured limit and authored task axes", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  tasks:",
      "    wipLimit: 4"
    ]);
    writeTaskIndex(rootDir, "task_IDEA", "Idea", "planned", "active");
    writeTaskIndex(rootDir, "task_ACTIVE", "Active", "active", "active");
    writeTaskIndex(rootDir, "task_CHILD", "Child", "planned", "active", "task_ACTIVE");
    writeTaskIndex(rootDir, "task_ARCHIVED", "Archived", "blocked", "archived");

    assert.deepEqual(readTaskWipSnapshot(rootDir), {
      limit: 4,
      tasks: [
        { taskId: "task_ACTIVE", title: "Active", status: "active", packageDisposition: "active", isContainer: true },
        { taskId: "task_ARCHIVED", title: "Archived", status: "blocked", packageDisposition: "archived", isContainer: false },
        { taskId: "task_CHILD", title: "Child", status: "planned", packageDisposition: "active", isContainer: false },
        { taskId: "task_IDEA", title: "Idea", status: "planned", packageDisposition: "active", isContainer: false }
      ]
    });
  });
});

test("execution consent TTL resolves default, YAML, then environment override", () => {
  withRoot((rootDir) => {
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {}), {
      ok: true,
      ttlMs: DEFAULT_EXECUTION_CONSENT_TTL_MS
    });
    writeSettings(rootDir, [
      "settings:",
      "  execution:",
      "    consentTtlMs: 7200000"
    ]);
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {}), { ok: true, ttlMs: 7_200_000 });
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {
      HARNESS_EXECUTION_CONSENT_TTL_MS: "3600000"
    }), { ok: true, ttlMs: 3_600_000 });
  });
});

test("execution consent TTL rejects invalid YAML and environment before use", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  execution:",
      "    consentTtlMs: 0"
    ]);
    const yaml = resolveExecutionConsentTtlMs(rootDir, {});
    assert.equal(yaml.ok, false);
    if (!yaml.ok) assert.match(yaml.result.error?.hint ?? "", /positive integer/u);
  });
  withRoot((rootDir) => {
    const env = resolveExecutionConsentTtlMs(rootDir, {
      HARNESS_EXECUTION_CONSENT_TTL_MS: ""
    });
    assert.equal(env.ok, false);
    if (!env.ok) assert.match(env.result.error?.hint ?? "", /HARNESS_EXECUTION_CONSENT_TTL_MS/u);
  });
});

test("Multica stale TTL resolves default, YAML, then environment override", () => {
  withRoot((rootDir) => {
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {}), {
      ok: true,
      ttlMs: DEFAULT_MULTICA_STALE_TTL_MS
    });
    writeSettings(rootDir, [
      "settings:",
      "  adapters:",
      "    multica:",
      "      staleTtlMs: 240000"
    ]);
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {}), { ok: true, ttlMs: 240_000 });
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {
      HARNESS_MULTICA_STALE_TTL_MS: "120000"
    }), { ok: true, ttlMs: 120_000 });
  });
});

test("Multica stale TTL rejects invalid YAML and environment before use", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  adapters:",
      "    multica:",
      "      staleTtlMs: nope"
    ]);
    const yaml = resolveMulticaStaleTtlMs(rootDir, {});
    assert.equal(yaml.ok, false);
    if (!yaml.ok) assert.match(yaml.result.error?.hint ?? "", /settings\.adapters\.multica\.staleTtlMs/u);
  });
  withRoot((rootDir) => {
    const env = resolveMulticaStaleTtlMs(rootDir, {
      HARNESS_MULTICA_STALE_TTL_MS: "-1"
    });
    assert.equal(env.ok, false);
    if (!env.ok) assert.match(env.result.error?.hint ?? "", /HARNESS_MULTICA_STALE_TTL_MS/u);
  });
});

test("daemon runtime policy values parse from project YAML and reject invalid values", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  daemonRuntime:",
      "    writeLockTtlMs: 120000",
      "    interactiveMicroBatchMs: 0",
      "    materializerPollMs: 10000"
    ]);
    const settings = readProjectHarnessSettings(rootDir);
    assert.equal(settings.ok, true);
    if (settings.ok) assert.deepEqual(settings.settings.daemonRuntime, {
      writeLockTtlMs: 120_000,
      interactiveMicroBatchMs: 0,
      materializerPollMs: 10_000
    });
  });
  withRoot((rootDir) => {
    writeSettings(rootDir, ["settings:", "  daemonRuntime:", "    writeLockTtlMs: 0"]);
    const settings = readProjectHarnessSettings(rootDir);
    assert.equal(settings.ok, false);
    if (!settings.ok) assert.match(settings.result.error?.hint ?? "", /settings\.daemonRuntime\.writeLockTtlMs/u);
  });
});

function withRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-project-policy-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeSettings(rootDir: string, lines: ReadonlyArray<string>): void {
  const harnessDir = path.join(rootDir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), `${lines.join("\n")}\n`, "utf8");
}

function writeTaskIndex(
  rootDir: string,
  taskId: string,
  title: string,
  status: "planned" | "active" | "blocked",
  packageDisposition: "active" | "archived",
  parent?: string
): void {
  const taskDir = path.join(rootDir, "harness", "tasks", `${taskId}-fixture`);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    ...(parent ? [`parent: ${parent}`] : []),
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    `packageDisposition: ${packageDisposition}`,
    "---",
    ""
  ].join("\n"), "utf8");
}
