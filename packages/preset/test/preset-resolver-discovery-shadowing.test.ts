// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "../../kernel/src/index.ts";
import {
  compileRepoTaskPackage,
  installPresetPackage,
  runPresetAction as runProjectedPresetAction,
} from "../src/index.ts";

import { write, writePackage } from "./preset-resolver.fixtures.ts";
const runPresetAction = (input: Parameters<typeof runProjectedPresetAction>[0]) =>
  runProjectedPresetAction({ ...input, settings: INITIAL_SETTINGS_V1 });
test("template and script discovery expose builtin content with typed vertical execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-discovery-"));
  try {
    const templates = (await runPresetAction({
      rootDir,
      action: { kind: "template-list" },
    })) as Array<{
      templateRef: string;
      slot: string;
      materializeAs: string;
      locales: string[];
    }>;
    assert.equal(templates.length, 33);
    assert.deepEqual(
      templates,
      [...templates].sort((left, right) =>
        left.templateRef.localeCompare(right.templateRef),
      ),
    );
    assert.deepEqual(
      templates.find(
        ({ templateRef }) =>
          templateRef === "template://repository/architecture-manifest@1",
      ),
      {
        templateRef: "template://repository/architecture-manifest@1",
        slot: "repository.architecture.manifest",
        materializeAs:
          "{{paths.contextRoot}}/architecture/architecture-manifest.json",
        locales: ["en-US"],
      },
    );
    const rendered = (await runPresetAction({
      rootDir,
      action: {
        kind: "template-render",
        templateRef: "template://repository/architecture-manifest@1",
        locale: "zh-CN",
      },
    })) as {
      schema: string;
      source: string;
      templateRef: string;
      locale: string;
      path: string;
      body: string;
      digest: string;
    };
    assert.equal(rendered.schema, "template-render/v1");
    assert.equal(rendered.source, "builtin:software/coding");
    assert.equal(
      rendered.templateRef,
      "template://repository/architecture-manifest@1",
    );
    assert.equal(rendered.locale, "en-US");
    assert.equal(
      rendered.path,
      "{{paths.contextRoot}}/architecture/architecture-manifest.json",
    );
    assert.match(rendered.body, /"schema": "architecture-manifest\/v1"/u);
    assert.match(rendered.digest, /^sha256:[0-9a-f]{64}$/u);
    const scripts = (await runPresetAction({
      rootDir,
      action: { kind: "script-list" },
    })) as Array<{ id: string; purpose: string; execution: string }>;
    assert.equal(scripts.length, 7);
    assert.deepEqual(
      scripts.map(({ id }) => id),
      [...scripts.map(({ id }) => id)].sort(),
    );
    assert.ok(scripts.every(({ execution }) => execution === "available"));
    const inspected = (await runPresetAction({
      rootDir,
      action: {
        kind: "script-inspect",
        scriptId: "vertical:software-coding:architecture-check",
      },
    })) as {
      schema: string;
      declaration: { command: string; writes: string[] };
      execution: { available: boolean; code: string };
    };
    assert.equal(inspected.schema, "vertical-script-inspection/v1");
    assert.equal(
      inspected.declaration.command,
      "scripts/architecture-check.mjs",
    );
    assert.deepEqual(inspected.declaration.writes, []);
    assert.deepEqual(inspected.execution, {
      available: true,
      code: "script_run_available",
      nextAction:
        "Run ha script run vertical:software-coding:architecture-check [--dry-run].",
    });
    await assert.rejects(
      runPresetAction({
        rootDir,
        action: {
          kind: "script-run",
          scriptId: "vertical:software-coding:architecture-check",
        },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "unsupported_command",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("user shadow lifecycle dry-runs mutation, blocks invalid content, and reveals bundled on uninstall", async () => {
  const rootDir = mkdtempSync(
      path.join(tmpdir(), "ha-preset-shadow-lifecycle-"),
    ),
    sourceRoot = path.join(rootDir, "source", "standard-task"),
    userRoot = path.join(rootDir, ".harness/presets");
  try {
    writePackage(path.dirname(sourceRoot), "standard-task", {
      version: "3.1.0",
    });
    const validated = (await runPresetAction({
      rootDir,
      action: { kind: "preset-validate", packageSource: sourceRoot },
    })) as {
      schema: string;
      valid: boolean;
      source: string;
      preset?: { id: string; digest: string };
      issues: unknown[];
    };
    assert.equal(validated.schema, "preset-validate-report/v1");
    assert.equal(validated.valid, true);
    assert.equal(validated.source, sourceRoot);
    assert.equal(validated.preset?.id, "standard-task");
    assert.match(validated.preset?.digest ?? "", /^[0-9a-f]{64}$/u);
    assert.deepEqual(validated.issues, []);
    const dryInstall = (await runPresetAction({
      rootDir,
      action: {
        kind: "preset-install",
        packageSource: sourceRoot,
        dryRun: true,
      },
    })) as { mode: string; changed: boolean; presetId: string };
    assert.deepEqual(
      {
        mode: dryInstall.mode,
        changed: dryInstall.changed,
        presetId: dryInstall.presetId,
      },
      { mode: "dry-run", changed: true, presetId: "standard-task" },
    );
    assert.equal(existsSync(userRoot), false);
    await runPresetAction({
      rootDir,
      action: { kind: "preset-install", packageSource: sourceRoot },
    });
    const shadow = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list" },
    })) as Array<{
      id: string;
      layer: string;
      source: string;
      issues: unknown[];
    }>;
    assert.deepEqual(
      shadow.find(({ id }) => id === "standard-task") && {
        layer: shadow.find(({ id }) => id === "standard-task")!.layer,
        source: shadow.find(({ id }) => id === "standard-task")!.source,
        issues: shadow.find(({ id }) => id === "standard-task")!.issues,
      },
      {
        layer: "user",
        source: path.join(userRoot, "preset-objects", validated.preset!.digest),
        issues: [],
      },
    );
    write(
      path.join(
        userRoot,
        "preset-objects",
        validated.preset!.digest,
        "preset.json",
      ),
      "{}",
    );
    const blocked = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list" },
    })) as Array<{
      id: string;
      validity: string;
      errorCode?: string;
      issues: Array<{ code: string }>;
    }>;
    assert.deepEqual(
      blocked.find(({ id }) => id === "standard-task") && {
        validity: blocked.find(({ id }) => id === "standard-task")!.validity,
        errorCode: blocked.find(({ id }) => id === "standard-task")!.errorCode,
        issues: blocked
          .find(({ id }) => id === "standard-task")!
          .issues.map(({ code }) => code),
      },
      {
        validity: "blocked",
        errorCode: "shadow_invalid",
        issues: ["shadow_invalid"],
      },
    );
    const audited = (await runPresetAction({
      rootDir,
      action: { kind: "preset-audit" },
    })) as {
      blocked: number;
      issues: Array<{
        presetId: string;
        code: string;
        source: string;
        message: string;
      }>;
    };
    assert.equal(audited.blocked, 1);
    assert.match(
      audited.issues.find(({ presetId }) => presetId === "standard-task")
        ?.message ?? "",
      /preset\.json is missing required field "schema".*bundled standard-task remains blocked/u,
    );
    await assert.rejects(
      runPresetAction({
        rootDir,
        action: { kind: "preset-inspect", presetId: "standard-task" },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "shadow_invalid",
    );
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: {
          kind: "preset-uninstall",
          presetId: "standard-task",
          dryRun: true,
        },
      }),
      {
        presetId: "standard-task",
        mode: "dry-run",
        active: true,
        removed: false,
      },
    );
    assert.equal(
      existsSync(path.join(userRoot, "active/standard-task.json")),
      true,
    );
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: { kind: "preset-uninstall", presetId: "standard-task" },
      }),
      { presetId: "standard-task", mode: "apply", active: true, removed: true },
    );
    assert.equal(
      existsSync(
        path.join(userRoot, "preset-objects", validated.preset!.digest),
      ),
      true,
    );
    const revealed = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list" },
    })) as Array<{ id: string; layer: string }>;
    assert.equal(
      revealed.find(({ id }) => id === "standard-task")?.layer,
      "bundled",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("profile precedence is explicit action, then projected settings", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-profile-")),
    sourceRoot = path.join(rootDir, "source"),
    profiles = [
      {
        id: "baseline",
        title: "Baseline",
        completionGates: ["ci"],
        templateSelections: [],
      },
      {
        id: "relaxed",
        title: "Relaxed",
        completionGates: [],
        templateSelections: [],
      },
    ];
  try {
    writePackage(sourceRoot, "profile-task", {
      profiles,
      defaultProfile: "relaxed",
    });
    installPresetPackage({
      source: path.join(sourceRoot, "profile-task"),
      userRoot: path.join(rootDir, ".harness/presets"),
    });
    let settings = { ...INITIAL_SETTINGS_V1, defaultProfile: "relaxed" };
    const compile = (profileId?: string) =>
      compileRepoTaskPackage({
        rootDir,
        settings,
        taskId: "task-profile",
        action: {
          kind: "task-create",
          title: "Profile",
          presetId: "profile-task",
          ...(profileId ? { profileId } : {}),
        },
      }).snapshot.profile.id;
    assert.equal(compile(), "relaxed");
    settings = INITIAL_SETTINGS_V1;
    assert.equal(compile(), "baseline");
    assert.equal(compile("relaxed"), "relaxed");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
