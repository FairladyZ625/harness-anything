// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "../../kernel/src/index.ts";
import {
  acceptBuiltinVerticalScriptPlan,
  prepareBuiltinVerticalScriptExecution,
  runPresetAction as runProjectedPresetAction,
} from "../src/index.ts";

import { write, writePackage } from "./preset-resolver.fixtures.ts";
const runPresetAction = (input: Parameters<typeof runProjectedPresetAction>[0]) =>
  runProjectedPresetAction({ ...input, settings: INITIAL_SETTINGS_V1 });
test("generic list, inspect, check, install, and uninstall actions share the canonical inventory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-actions-")),
    sourceRoot = path.join(rootDir, "source");
  try {
    const listed = (await runPresetAction({
      rootDir,
      action: { kind: "preset-list" },
    })) as Array<{
      id: string;
      title: string;
      description: string;
      verticalId: string;
      layer: string;
      source: string;
      validity: string;
      version?: string;
      kind?: string;
      defaultProfile?: string;
      profiles?: Array<{ id: string; title: string }>;
      entrypoints?: string[];
      issues: unknown[];
      issueCount?: number;
    }>;
    assert.equal(listed.length, 12);
    const standardRow = listed.find(({ id }) => id === "standard-task")!,
      // The golden row pins the display projection; profile entries come from
      // the same bundled manifest the catalog derives from, so a manifest
      // profile change tracks here instead of drifting behind a second
      // handwritten copy.
      standardManifest = JSON.parse(
        readFileSync(new URL("../assets/software-coding/presets/standard-task/preset.json", import.meta.url), "utf8"),
      ) as { profiles: Array<{ id: string; title: string }> };
    assert.deepEqual(
      { ...standardRow, source: path.basename(standardRow.source) },
      {
        id: "standard-task",
        title: "Standard Task",
        description: "Create the standard planning, facts, and closeout scaffold for general software work.",
        verticalId: "software/coding",
        layer: "bundled",
        source: "standard-task",
        validity: "valid",
        version: "3.0.0",
        kind: "template-content",
        defaultProfile: "baseline",
        profiles: standardManifest.profiles.map(({ id, title }) => ({
          id,
          title,
        })),
        outputShape: "repository-diff",
        completionGates: ["ci", "code-doc-reconciliation"],
        entrypoints: [],
        issues: [],
        issueCount: 0,
      },
    );
    const inspected = (await runPresetAction({
      rootDir,
      action: { kind: "preset-inspect", presetId: "standard-task" },
    })) as {
      manifest: { id: string };
      snapshot: { digest: string };
      entrypoints: string[];
    };
    assert.equal(inspected.manifest.id, "standard-task");
    assert.deepEqual(inspected.entrypoints, []);
    assert.match(inspected.snapshot.digest, /^sha256:/u);
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: { kind: "preset-check", presetId: "standard-task" },
      }),
      { valid: true, digest: inspected.snapshot.digest },
    );
    const stale = `sha256:${"0".repeat(64)}`;
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: {
          kind: "preset-check",
          presetId: "standard-task",
          snapshotDigest: stale,
        },
      }),
      {
        valid: false,
        code: "snapshot_mismatch",
        actualDigest: stale,
        expectedDigest: inspected.snapshot.digest,
        nextAction: "Run ha preset upgrade <task-id>.",
      },
    );
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: {
          kind: "preset-check",
          presetId: "standard-task",
          snapshotDigest: inspected.snapshot.digest,
        },
      }),
      { valid: true, digest: inspected.snapshot.digest },
    );
    writePackage(sourceRoot, "user-task", { version: "3.4.0" });
    const installed = (await runPresetAction({
      rootDir,
      action: {
        kind: "preset-install",
        packageSource: path.join(sourceRoot, "user-task"),
      },
    })) as {
      presetId: string;
      mode: string;
      changed: boolean;
      issues: unknown[];
    };
    assert.deepEqual(
      {
        presetId: installed.presetId,
        mode: installed.mode,
        changed: installed.changed,
        issues: installed.issues,
      },
      { presetId: "user-task", mode: "apply", changed: true, issues: [] },
    );
    assert.equal(
      (
        (await runPresetAction({
          rootDir,
          action: { kind: "preset-inspect", presetId: "user-task" },
        })) as { snapshot: { identity: { layer: string } } }
      ).snapshot.identity.layer,
      "user",
    );
    assert.deepEqual(
      await runPresetAction({
        rootDir,
        action: { kind: "preset-uninstall", presetId: "user-task" },
      }),
      { presetId: "user-task", mode: "apply", active: true, removed: true },
    );
    await assert.rejects(
      runPresetAction({
        rootDir,
        action: { kind: "preset-unknown", presetId: "standard-task" },
      }),
      (error: unknown) => (error as { code?: string }).code === "unsupported_command",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("builtin vertical validation is closed while custom verticals stay explicitly unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-validate-"));
  try {
    const builtin = (await runPresetAction({
      rootDir,
      action: { kind: "vertical-validate", verticalSource: "software/coding" },
    })) as {
      schema: string;
      source: string;
      available: boolean;
      valid: boolean;
      vertical?: { id: string };
      issues: unknown[];
    };
    assert.deepEqual(builtin, {
      schema: "vertical-validate-report/v1",
      source: "builtin:software/coding",
      available: true,
      valid: true,
      vertical: {
        id: "software/coding",
        title: "Software Coding",
        version: "1.3.0",
      },
      issues: [],
    });
    const custom = (await runPresetAction({
      rootDir,
      action: {
        kind: "vertical-validate",
        verticalSource: "./custom-vertical.json",
      },
    })) as {
      available: boolean;
      valid: boolean;
      issues: Array<{ code: string }>;
    };
    assert.equal(custom.available, false);
    assert.equal(custom.valid, false);
    assert.deepEqual(
      custom.issues.map(({ code }) => code),
      ["custom_vertical_unavailable"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("software coding declaration closes lifecycle, repository, projection, and discovery assets", () => {
  const vertical = JSON.parse(
    readFileSync(new URL("../assets/software-coding/vertical.json", import.meta.url), "utf8"),
  ) as {
    entityFieldExtensions?: Array<{ field: string; values: string[] }>;
    entityKinds: Array<{
      id: string;
      packageKind?: string;
      schemaRef?: string;
    }>;
    contractEntityKinds: string[];
    packageScaffolds: Array<{ entityKind: string }>;
    repositoryScaffold: {
      entityRoots: Array<{ entityKind: string; path: string; create: string }>;
      dirs: Array<{ path: string; create: string }>;
      agentsEntry?: {
        baseRef: string;
        overlayRef: string;
        materializeAs: string;
      };
    };
    scripts: Array<{ id: string; command: string }>;
    projectionSchemas: Array<{ id: string; schemaRef: string }>;
  };
  assert.deepEqual(
    vertical.entityFieldExtensions?.map(({ field, values }) => ({
      field,
      values,
    })),
    [{ field: "taskClass", values: ["milestone", "epic"] }],
  );
  assert.deepEqual(vertical.entityKinds, [
    {
      id: "task",
      entityType: "lifecycle",
      packageKind: "task-package/v2",
      contractEntity: true,
    },
    {
      id: "decision",
      entityType: "lifecycle",
      packageKind: "decision-event/v1",
      contractEntity: true,
    },
    {
      id: "fact",
      entityType: "schema",
      schemaRef: "schema://fact-event",
      contractEntity: true,
    },
  ]);
  assert.deepEqual(vertical.contractEntityKinds, ["task", "decision", "fact"]);
  assert.deepEqual(
    vertical.packageScaffolds.map(({ entityKind }) => entityKind),
    ["task", "decision"],
  );
  assert.deepEqual(vertical.repositoryScaffold.entityRoots, [
    { entityKind: "task", path: "{{paths.tasksRoot}}", create: "init" },
    { entityKind: "decision", path: "{{paths.decisionsRoot}}", create: "lazy" },
  ]);
  assert.deepEqual(vertical.repositoryScaffold.dirs, [
    { path: "{{paths.standardsRoot}}", create: "init" },
    { path: "{{paths.contextRoot}}", create: "init" },
    { path: "{{paths.contextRoot}}/architecture", create: "init" },
    { path: "{{paths.adrRoot}}", create: "init" },
    { path: "{{paths.milestonesRoot}}", create: "init" },
    { path: "{{paths.sessionsRoot}}", create: "lazy" },
  ]);
  assert.deepEqual(vertical.repositoryScaffold.agentsEntry, {
    materializeAs: "{{paths.rootDir}}/AGENTS.md",
    localePolicy: { prefer: "project", fallback: "en-US" },
    baseRef: "template://repository/agent-base@1",
    overlayRef: "template://repository/agent-overlay@1",
    repoSpecificsAnchor: "## Repository Specifics",
  });
  assert.deepEqual(
    vertical.scripts.map(({ id }) => id),
    [
      "vertical:software-coding:architecture-init",
      "vertical:software-coding:architecture-snapshot",
      "vertical:software-coding:architecture-check",
      "vertical:software-coding:repository-audit",
      "vertical:software-coding:adr-seed",
      "vertical:software-coding:adr-render",
      "vertical:software-coding:decision-conformance",
    ],
  );
  assert.ok(vertical.scripts.every(({ command }) => command.startsWith("scripts/") && command.endsWith(".mjs")));
  assert.deepEqual(vertical.projectionSchemas, [
    { id: "task-frontmatter", schemaRef: "schema://task-frontmatter" },
    { id: "decision-frontmatter", schemaRef: "schema://decision-frontmatter" },
    { id: "fact-event", schemaRef: "schema://fact-event" },
  ]);
  const catalog = JSON.parse(
      readFileSync(new URL("../assets/software-coding/template-catalog.json", import.meta.url), "utf8"),
    ) as { documents: Array<{ id: string; materializeAs: string }> },
    ids = new Set(catalog.documents.map(({ id }) => id));
  for (const id of [
    "repository/agent-base",
    "repository/agent-overlay",
    "repository/adr-template",
    "repository/architecture-manifest",
    "repository/architecture-likec4-config",
    "repository/architecture-likec4-model",
    "repository/architecture-likec4-specification",
    "repository/architecture-likec4-view-landscape",
    "repository/architecture-likec4-view-write-path",
    "repository/architecture-likec4-view-runtime",
  ])
    assert.equal(ids.has(id), true, id);
  assert.equal(
    catalog.documents.some(
      ({ materializeAs }) =>
        materializeAs.includes("{{paths.authoredRoot}}/standards") || materializeAs.startsWith("harness/standards"),
    ),
    false,
  );
});

test("builtin script preparation binds one declared command and rejects undeclared or out-of-scope plans", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-prepare-"));
  write(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n");
  try {
    const action = {
        schema: "vertical-script-action/v1",
        kind: "script-run",
        scriptId: "vertical:software-coding:adr-seed",
        taskId: null,
        inputs: { locale: "zh-CN" },
        dryRun: true,
      } as const,
      prepared = prepareBuiltinVerticalScriptExecution({
        rootDir,
        action,
        commitSha: "a".repeat(40),
      });
    assert.equal(path.basename(prepared.command), "adr-seed.mjs");
    assert.equal(
      prepared.readRoots.some((root) => root.endsWith(path.join("packages", "preset", "assets", "software-coding"))),
      true,
    );
    assert.deepEqual(prepared.writePatterns, ["decisions/adrs/**"]);
    assert.deepEqual(prepared.producePatterns, ["decisions/adrs/README.md", "decisions/adrs/0000-template.md"]);
    const accepted = acceptBuiltinVerticalScriptPlan(
      prepared,
      JSON.stringify({
        schema: "vertical-script-plan/v1",
        scriptId: action.scriptId,
        ok: true,
        status: "planned",
        report: {},
        warnings: [],
        changes: [
          {
            path: "decisions/adrs/0000-template.md",
            body: "# ADR\n",
            mediaType: "text/markdown",
            disposition: "create",
          },
        ],
      }),
    );
    assert.equal(accepted.changes.length, 1);
    assert.throws(
      () =>
        acceptBuiltinVerticalScriptPlan(
          prepared,
          JSON.stringify({
            ...accepted,
            changes: [{ ...accepted.changes[0], path: "tasks/escape.md" }],
          }),
        ),
      (error: unknown) => (error as { code?: string }).code === "script_scope_violation",
    );
    assert.throws(
      () =>
        prepareBuiltinVerticalScriptExecution({
          rootDir,
          action: {
            ...action,
            scriptId: "vertical:software-coding:not-declared",
          },
          commitSha: "a".repeat(40),
        }),
      (error: unknown) => (error as { code?: string }).code === "script_not_found",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("all seven declared builtin script assets emit accepted deterministic plans", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-assets-")),
    taskId = "task_01KZXSYDTJ3K1YE88294X33QNW",
    commitSha = "b".repeat(40);
  write(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n");
  write(
    path.join(rootDir, `harness/tasks/${taskId}/INDEX.md`),
    `---\nschema: task-package/v2\ntask_id: ${taskId}\n---\n# Script task\n`,
  );
  write(
    path.join(rootDir, "harness/decisions/decision-dec_SCRIPT/decision.md"),
    "---\ndecision_id: dec_SCRIPT\nstate: active\n---\n# Script execution decision\n",
  );
  try {
    const execute = (name: string, task: string | null = null, inputs: Record<string, string> = {}) => {
        const action = {
            schema: "vertical-script-action/v1",
            kind: "script-run",
            scriptId: `vertical:software-coding:${name}`,
            taskId: task,
            inputs,
            dryRun: true,
          } as const,
          prepared = prepareBuiltinVerticalScriptExecution({
            rootDir,
            action,
            commitSha,
          }),
          frame = execFileSync(
            process.execPath,
            [
              "--permission",
              ...prepared.readRoots.map((root) => `--allow-fs-read=${root}/*`),
              prepared.command,
              prepared.contextArgument,
            ],
            { cwd: rootDir, encoding: "utf8" },
          );
        return acceptBuiltinVerticalScriptPlan(prepared, frame);
      },
      materialize = (plan: ReturnType<typeof execute>) => {
        for (const change of plan.changes) write(path.join(rootDir, "harness", change.path), change.body);
      };
    const init = execute("architecture-init");
    assert.equal(init.changes.length, 7);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/architecture-manifest.json")), false);
    materialize(init);
    const snapshot = execute("architecture-snapshot", taskId);
    assert.deepEqual(
      snapshot.changes.map(({ path: target }) => target),
      [`tasks/${taskId}/artifacts/architecture/code-facts.json`],
    );
    materialize(snapshot);
    const check = execute("architecture-check", taskId);
    assert.equal(check.status, "fresh");
    assert.deepEqual(check.changes, []);
    const audit = execute("repository-audit");
    assert.equal(audit.status, "conformant");
    assert.deepEqual(audit.changes, []);
    const seed = execute("adr-seed", null, { locale: "zh-CN" });
    assert.equal(seed.changes.length, 2);
    materialize(seed);
    const adr = execute("adr-render", null, { decisionId: "dec_SCRIPT" });
    assert.deepEqual(
      adr.changes.map(({ path: target }) => target),
      ["decisions/adrs/dec_SCRIPT.md"],
    );
    const conformance = execute("decision-conformance");
    assert.equal(conformance.status, "conformant");
    assert.deepEqual(conformance.changes, []);
    assert.equal(conformance.report.decisionCount, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
