import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI preset discovery honors project over user over bundled presets", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/user-presets/standard-task/preset.json", {
      id: "standard-task",
      title: "User Standard Task",
      version: "1.0.0"
    });
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
      id: "standard-task",
      title: "Project Standard Task",
      version: "2.0.0"
    });

    const result = runJson(rootDir, ["preset", "list"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "preset-list");
    const standard = result.presets.find((preset: Record<string, unknown>) => preset.id === "standard-task");
    assert.equal(standard.title, "Project Standard Task");
    assert.equal(standard.layer, "project");
    assert.equal(result.presets.some((preset: Record<string, unknown>) => preset.id === "module"), true);
  });
});

test("CLI preset CRUD validates, installs, audits, and removes project presets", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "source-preset");
    writePreset(sourceDir, "preset.json", {
      id: "custom-task",
      title: "Custom Task",
      version: "1.0.0"
    });

    const installed = runJson(rootDir, ["preset", "install", sourceDir, "--project"]);
    assert.equal(installed.ok, true);
    assert.equal(installed.command, "preset-install");
    assert.equal(installed.preset.id, "custom-task");

    const inspected = runJson(rootDir, ["preset", "inspect", "custom-task"]);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.preset.layer, "project");

    const checked = runJson(rootDir, ["preset", "check", "custom-task"]);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.issues, []);

    const audit = runJson(rootDir, ["preset", "audit"]);
    assert.equal(audit.ok, true);
    assert.equal(audit.report.totalResolved, 10);

    const removed = runJson(rootDir, ["preset", "uninstall", "custom-task", "--project"]);
    assert.equal(removed.ok, true);
    assert.equal(removed.command, "preset-uninstall");

    const missing = runJson(rootDir, ["preset", "inspect", "custom-task"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "preset_not_found");
  });
});

test("CLI new-task wires explicit coding vertical preset and module without relations", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"]);

    const created = runJson(rootDir, [
      "new-task",
      "--title",
      "Billing Task",
      "--vertical",
      "software/coding",
      "--preset",
      "module",
      "--module",
      "billing"
    ]);

    assert.equal(created.ok, true);
    assert.equal(created.command, "new-task");
    assert.equal(created.preset.id, "module");
    assert.equal(created.module.key, "billing");
    assert.equal(created.report.vertical, "software/coding");
    assert.equal(created.report.preset, "module");
    assert.equal(created.generated.includes("INDEX.md"), true);
    assert.equal(created.generated.includes("task_plan.md"), true);
    assert.equal(created.generated.includes("module.md"), true);

    const index = readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8");
    assert.match(index, /vertical: software\/coding/);
    assert.match(index, /preset: module/);
    assert.equal(index.includes("parent"), false);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /# Billing Task/);

    const moduleSelection = readFileSync(path.join(rootDir, created.packagePath, "module.md"), "utf8");
    assert.match(moduleSelection, /Module key: billing/);
    assert.match(moduleSelection, /does not create parent\/child, DAG, or relation semantics/);
  });
});

test("CLI standard task preset materializes rich planning documents", () => {
  withTempRoot((rootDir) => {
    const inspected = runJson(rootDir, ["preset", "inspect", "standard-task"]);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.preset.kind, "template-content");
    assert.equal(inspected.preset.manifest.schema, "preset-manifest/v2");

    const created = runJson(rootDir, [
      "new-task",
      "--title",
      "Rich Task",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);

    assert.equal(created.ok, true);
    assert.equal(created.generated.includes("closeout.md"), true);
  });
});

test("CLI new-task honors harness.yaml custom authored layout", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/harness.yaml", [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: .harness-private/coding-agent-harness",
      "  localRoot: .harness-local",
      "tasks:",
      "  root: .harness-private/coding-agent-harness/tasks",
      ""
    ].join("\n"));

    const created = runJson(rootDir, [
      "new-task",
      "--title",
      "Private Layout Task",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);

    assert.equal(created.ok, true);
    assert.match(created.packagePath, /^\.harness-private\/coding-agent-harness\/tasks\/task_/u);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "closeout.md")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness-local", "write-journal", "writes.jsonl")), true);
  });
});

test("CLI new-task honors explicit authored root context without global pollution", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, [
      "--authored-root",
      ".custom-harness",
      "new-task",
      "--title",
      "Explicit Layout Task",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);

    assert.equal(created.ok, true);
    assert.match(created.packagePath, /^\.custom-harness\/tasks\/task_/u);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "INDEX.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness", "tasks")), false);

    const defaultRun = runJson(rootDir, [
      "new-task",
      "--title",
      "Default Layout Task",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);
    assert.match(defaultRun.packagePath, /^harness\/tasks\/task_/u);
  });
});

test("CLI new-task honors private self-host harness structure layout", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness-private/coding-agent-harness/harness.yaml", [
      "version: 2",
      "structure:",
      "  harnessRoot: coding-agent-harness",
      "  tasksRoot: coding-agent-harness/tasks",
      "  generatedRoot: coding-agent-harness/governance/generated",
      ""
    ].join("\n"));

    const created = runJson(rootDir, [
      "new-task",
      "--title",
      "Self Host Task",
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);

    assert.equal(created.ok, true);
    assert.match(created.packagePath, /^\.harness-private\/coding-agent-harness\/tasks\/task_/u);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "closeout.md")), true);
  });
});

test("CLI new-task fails closed on ambiguous preset and legacy/module input", () => {
  withTempRoot((rootDir) => {
    const missingModule = runJson(rootDir, ["new-task", "--title", "Module Task", "--vertical", "software/coding", "--preset", "module"], false);
    assert.equal(missingModule.ok, false);
    assert.equal(missingModule.error.code, "missing_module");

    const mixedLegacy = runJson(rootDir, ["new-task", "--from-legacy", "legacy-1", "--preset", "standard-task"], false);
    assert.equal(mixedLegacy.ok, false);
    assert.equal(mixedLegacy.error.code, "legacy_rebuild_preset_forbidden");
  });
});

test("CLI preset install rejects non-additive project overrides before writing", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "source-preset");
    writePreset(sourceDir, "preset.json", {
      id: "standard-task",
      title: "Bad Standard Task",
      version: "9.0.0",
      templateSelections: [conflictingTaskPlanSelection()]
    });

    const installed = runJson(rootDir, ["preset", "install", sourceDir, "--project"], false);

    assert.equal(installed.ok, false);
    assert.equal(installed.command, "preset-install");
    assert.equal(installed.error.code, "preset_manifest_invalid");
    assert.equal(installed.issues.some((issue: Record<string, unknown>) => issue.code === "preset_required_template_conflict"), true);
    assert.equal(existsSync(path.join(rootDir, ".harness/presets/standard-task/preset.json")), false);
  });
});

test("CLI preset check and run reject invalid project overrides before writes", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/presets/module/preset.json", {
      id: "module",
      title: "Bad Module",
      version: "9.0.0",
      templateSelections: [conflictingTaskPlanSelection()]
    });

    const checked = runJson(rootDir, ["preset", "check", "module"], false);
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "preset_manifest_invalid");
    assert.equal(checked.issues.some((issue: Record<string, unknown>) => issue.code === "preset_required_template_conflict"), true);

    const scaffolded = runJson(rootDir, ["preset", "run", "module", "scaffold", "--task", "task-1"], false);
    assert.equal(scaffolded.ok, false);
    assert.equal(scaffolded.command, "preset-run");
    assert.equal(scaffolded.error.code, "preset_manifest_invalid");
    assert.equal(existsSync(path.join(rootDir, ".harness/evidence/presets/module")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness/generated/preset-scaffold/task-1/module.md")), false);
  });
});

test("CLI preset validation reserves task package hard-gate paths", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/presets/standard-task/preset.json", {
      id: "standard-task",
      title: "Bad Standard Task",
      version: "9.0.0",
      templateSelections: [reservedIndexSelection()]
    });

    const checked = runJson(rootDir, ["preset", "check", "standard-task"], false);
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, "preset_manifest_invalid");
    assert.equal(checked.issues.some((issue: Record<string, unknown>) => issue.code === "reserved_materialized_path"), true);

    const created = runJson(rootDir, ["new-task", "--title", "Bad Task", "--vertical", "software/coding", "--preset", "standard-task"], false);
    assert.equal(created.ok, false);
    assert.equal(created.error.code, "preset_materialization_failed");
    assert.equal(created.issues.some((issue: Record<string, unknown>) => issue.code === "reserved_materialized_path"), true);
  });
});

test("CLI preset list inspect and audit surface invalid active overrides", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, ".harness/presets/module/preset.json", {
      id: "module",
      title: "Bad Module",
      version: "9.0.0",
      templateSelections: [conflictingTaskPlanSelection()]
    });

    const listed = runJson(rootDir, ["preset", "list"], false);
    assert.equal(listed.ok, false);
    assert.equal(listed.error.code, "preset_manifest_invalid");
    const listedModule = listed.presets.find((preset: Record<string, unknown>) => preset.id === "module");
    assert.equal(listedModule.layer, "project");
    assert.equal(listedModule.valid, false);

    const inspected = runJson(rootDir, ["preset", "inspect", "module"], false);
    assert.equal(inspected.ok, false);
    assert.equal(inspected.error.code, "preset_manifest_invalid");
    assert.equal(inspected.issues.some((issue: Record<string, unknown>) => issue.code === "preset_required_template_conflict"), true);

    const audited = runJson(rootDir, ["preset", "audit"], false);
    assert.equal(audited.ok, false);
    assert.equal(audited.error.code, "preset_manifest_invalid");
    assert.equal(audited.issues.some((issue: Record<string, unknown>) => issue.code === "preset_required_template_conflict"), true);
  });
});

test("CLI malformed project preset override fails closed with stable preset error", () => {
  withTempRoot((rootDir) => {
    const presetPath = path.join(rootDir, ".harness/presets/module/preset.json");
    mkdirSync(path.dirname(presetPath), { recursive: true });
    writeFileSync(presetPath, JSON.stringify({
      schema: "preset-manifest/v1",
      id: "module",
      title: "Malformed Module",
      vertical: "software/coding",
      version: "9.0.0",
      unknownField: true
    }), "utf8");

    const listed = runJson(rootDir, ["preset", "list"], false);
    assert.equal(listed.ok, false);
    assert.equal(listed.error.code, "preset_manifest_invalid");
    const module = listed.presets.find((preset: Record<string, unknown>) => preset.id === "module");
    assert.equal(module.valid, false);

    const run = runJson(rootDir, ["preset", "run", "module", "scaffold", "--task", "task-1"], false);
    assert.equal(run.ok, false);
    assert.equal(run.error.code, "preset_manifest_invalid");
    assert.equal(run.issues.some((issue: Record<string, unknown>) => issue.code === "unknown_extension_field"), true);

    const created = runJson(rootDir, ["new-task", "--title", "Bad Module Task", "--vertical", "software/coding", "--preset", "module", "--module", "billing"], false);
    assert.equal(created.ok, false);
    assert.equal(created.error.code, "preset_manifest_invalid");
  });
});

test("CLI malformed override directories do not fall back to builtin presets", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/presets/module"), { recursive: true });

    const missing = runJson(rootDir, ["preset", "inspect", "module"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "preset_manifest_invalid");
    assert.equal(missing.issues.some((issue: Record<string, unknown>) => issue.code === "preset_path_id_mismatch"), true);

    writePreset(rootDir, ".harness/presets/module/preset.json", {
      id: "other",
      title: "Wrong Id",
      version: "1.0.0",
      templateSelections: validTaskSelections()
    });
    const mismatch = runJson(rootDir, ["preset", "inspect", "module"], false);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, "preset_manifest_invalid");
    assert.equal(mismatch.issues.some((issue: Record<string, unknown>) => issue.code === "preset_path_id_mismatch"), true);

    const wrongDir = path.join(rootDir, ".harness/presets/wrong-dir/preset.json");
    mkdirSync(path.dirname(wrongDir), { recursive: true });
    writeFileSync(wrongDir, JSON.stringify(makePreset({
      id: "module",
      title: "Wrong Directory Module",
      version: "1.0.0",
      templateSelections: validTaskSelections()
    }), null, 2), "utf8");
    rmSync(path.join(rootDir, ".harness/presets/module"), { recursive: true, force: true });

    const claimedModule = runJson(rootDir, ["preset", "inspect", "module"], false);
    assert.equal(claimedModule.ok, false);
    assert.equal(claimedModule.error.code, "preset_manifest_invalid");
    assert.equal(claimedModule.issues.some((issue: Record<string, unknown>) => issue.code === "preset_path_id_mismatch"), true);

    const created = runJson(rootDir, ["new-task", "--title", "Blocked", "--vertical", "software/coding", "--preset", "module", "--module", "billing"], false);
    assert.equal(created.ok, false);
    assert.equal(created.error.code, "preset_manifest_invalid");
  });
});

test("CLI preset install malformed source returns stable preset error before writing", () => {
  withTempRoot((rootDir) => {
    const sourceDir = path.join(rootDir, "bad-source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "preset.json"), JSON.stringify({
      schema: "preset-manifest/v1",
      id: "bad-source",
      title: "Bad Source",
      vertical: "software/coding",
      version: "1.0.0",
      unknownField: true
    }), "utf8");

    const installed = runJson(rootDir, ["preset", "install", sourceDir, "--project"], false);

    assert.equal(installed.ok, false);
    assert.equal(installed.command, "preset-install");
    assert.equal(installed.error.code, "preset_manifest_invalid");
    assert.equal(installed.issues.some((issue: Record<string, unknown>) => issue.code === "unknown_extension_field"), true);
    assert.equal(existsSync(path.join(rootDir, ".harness/presets/bad-source/preset.json")), false);
  });
});

test("CLI preset run rejects undeclared v2 actions instead of succeeding as no-ops", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["preset", "run", "module", "check", "--task", "task-1"], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "preset-run");
    assert.equal(result.error.code, "preset_action_forbidden");

    const rejected = runJson(rootDir, ["preset", "action", "module", "deploy", "--task", "task-1"], false);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "preset_action_forbidden");

    const action = runJson(rootDir, ["preset", "action", "module", "check", "--task", "task-1"], false);
    assert.equal(action.ok, false);
    assert.equal(action.error.code, "preset_action_forbidden");

    const invalidTask = runJson(rootDir, ["preset", "run", "module", "check", "--task", "../task"], false);
    assert.equal(invalidTask.ok, false);
    assert.equal(invalidTask.error.code, "invalid_registry_key");
  });
});

test("CLI module CRUD maintains generated module view and module-step state", () => {
  withTempRoot((rootDir) => {
    const registered = runJson(rootDir, ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**"]);
    assert.equal(registered.ok, true);
    assert.equal(registered.command, "module-register");
    assert.equal(registered.module.key, "billing");

    const listed = runJson(rootDir, ["module", "list"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.modules.length, 1);
    assert.equal(listed.modules[0].key, "billing");

    const inspected = runJson(rootDir, ["module", "inspect", "billing"]);
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.module.scopes, ["packages/billing/**"]);

    const scaffolded = runJson(rootDir, ["module", "scaffold", "billing"]);
    assert.equal(scaffolded.ok, true);
    assert.equal(scaffolded.path, "harness/modules/billing/module_plan.md");

    const stepped = runJson(rootDir, ["module-step", "billing", "BILL-01", "--state", "done"]);
    assert.equal(stepped.ok, true);
    assert.equal(stepped.module.steps[0].state, "done");

    const registry = readFileSync(path.join(rootDir, ".harness/generated/Module-Registry.md"), "utf8");
    assert.match(registry, /\| billing \| Billing \| active \|/);

    const removed = runJson(rootDir, ["module", "unregister", "billing"]);
    assert.equal(removed.ok, true);
    assert.equal(removed.module.status, "unregistered");
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-p2-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function writePreset(rootDir: string, relativePath: string, overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(makePreset(overrides), null, 2), "utf8");
}

function makePreset(overrides: {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly templateSelections?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schema: "preset-manifest/v1",
    id: overrides.id,
    title: overrides.title,
    vertical: "software/coding",
    version: overrides.version,
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: overrides.templateSelections ?? []
    }],
    defaultProfile: "baseline"
  };
}

function conflictingTaskPlanSelection(): Record<string, unknown> {
  return {
    slot: "task.plan",
    templateRef: "template://planning/progress@1",
    materializeAs: "task_plan.md",
    localePolicy: {
      prefer: "project",
      fallback: "en-US"
    }
  };
}

function reservedIndexSelection(): Record<string, unknown> {
  return {
    slot: "custom.index",
    templateRef: "template://planning/task-plan@1",
    materializeAs: "INDEX.md",
    localePolicy: {
      prefer: "project",
      fallback: "en-US"
    }
  };
}

function validTaskSelections(): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      slot: "task.plan",
      templateRef: "template://planning/task-plan@1",
      materializeAs: "task_plan.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    },
    {
      slot: "task.progress",
      templateRef: "template://planning/progress@1",
      materializeAs: "progress.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    },
    {
      slot: "task.review",
      templateRef: "template://planning/review@1",
      materializeAs: "review.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    },
    {
      slot: "task.closeout",
      templateRef: "template://planning/closeout@1",
      materializeAs: "closeout.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    },
    {
      slot: "task.references.index",
      templateRef: "template://planning/references-index@1",
      materializeAs: "references/INDEX.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    },
    {
      slot: "task.artifacts.index",
      templateRef: "template://planning/artifacts-index@1",
      materializeAs: "artifacts/INDEX.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    }
  ];
}
