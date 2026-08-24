// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  eventObjectTarget,
  makeTaskEventStore,
  makeTaskProjection,
  serializeCanonicalEvent,
  serializeEventHead,
  sha256Text,
  type TaskEventV1,
} from "../../kernel/src/index.ts";
import {
  compilePresetSnapshotUpgrade,
  compileTaskBootstrap,
  installPresetPackage,
  runPresetAction,
} from "../src/index.ts";
import {
  createRuntime,
  decodePresetPackageV3,
} from "../src/preset-resolver.ts";

import {
  git,
  makeFixture,
  templateCatalog,
  write,
  writePackage,
} from "./preset-resolver.fixtures.ts";
test("snapshot upgrade atomically replaces the complete snapshot and typed task contract without touching task prose", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-upgrade-")),
    sourceRoot = path.join(rootDir, "source"),
    userRoot = path.join(rootDir, ".harness/presets"),
    taskId = "task-upgrade";
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    writePackage(sourceRoot, "upgrade-task", { version: "3.1.0" });
    installPresetPackage({
      source: path.join(sourceRoot, "upgrade-task"),
      userRoot,
    });
    const bootstrap = compileTaskBootstrap({
        userRoot,
        verticalId: "software/coding",
        profileId: "baseline",
        locale: "en-US",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local",
        occurredAt: "2026-08-14T00:00:00.000Z",
        taskId,
        title: "Stable package",
        slug: "stable-package",
        presetId: "upgrade-task",
        workspaceRevision: 1,
        eventId: "event-upgrade-create",
        opId: "op-upgrade-create",
      }),
      historical: TaskEventV1 = {
        schema: "task-event/v1",
        eventId: "event-upgrade-create",
        workspaceRevision: 1,
        opId: "op-upgrade-create",
        taskId,
        type: "task_created",
        actor: bootstrap.event.actor,
        source: bootstrap.event.source,
        occurredAt: bootstrap.event.occurredAt,
        payload: {
          task: {
            ...bootstrap.event.payload.task,
            metadata: { ...bootstrap.metadata, longRunning: false },
          } as typeof bootstrap.event.payload.task,
          documentClaims: [],
        },
      },
      eventBody = serializeCanonicalEvent(historical),
      eventPath = path.join(rootDir, eventObjectTarget(historical.opId));
    mkdirSync(path.dirname(eventPath), { recursive: true });
    writeFileSync(eventPath, eventBody);
    writeFileSync(
      path.join(rootDir, "harness/events/head.json"),
      serializeEventHead({
        revision: 1,
        opId: historical.opId,
        eventDigest: `sha256:${sha256Text(eventBody)}`,
      }),
    );
    git(rootDir, "add", "harness/events");
    git(rootDir, "commit", "-qm", "historical task");
    const store = makeTaskEventStore({ repoId: "preset-upgrade", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.rebuild();
    const planPath = path.join(
        rootDir,
        "harness",
        bootstrap.packagePath,
        "task_plan.md",
      ),
      editedPlan = "# User plan\n\nKeep this prose.\n";
    mkdirSync(path.dirname(planPath), { recursive: true });
    writeFileSync(planPath, editedPlan);
    writePackage(sourceRoot, "upgrade-task", { version: "3.2.0" });
    installPresetPackage({
      source: path.join(sourceRoot, "upgrade-task"),
      userRoot,
    });
    const task = projection.read(taskId).snapshot.task!,
      contractPath = `${bootstrap.packagePath}/task-contract.json`,
      contract = {
        body: bootstrap.documents.find(
          ({ relativePath }) => relativePath === "task-contract.json",
        )!.body,
      };
    let upgraded: ReturnType<typeof compilePresetSnapshotUpgrade> | undefined;
    assert.doesNotThrow(() => {
      upgraded = compilePresetSnapshotUpgrade({
        userRoot,
        task,
        taskContractBody: contract.body,
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local",
        workspaceRevision: 2,
        eventId: "event-upgrade",
        opId: "op-upgrade",
        occurredAt: "2026-08-14T00:01:00.000Z",
      });
    }, "a persisted package slug must not be reported as a changed document set");
    assert.ok(upgraded);
    assert.notEqual(upgraded.snapshot.digest, task.presetSnapshotDigest);
    assert.equal(upgraded.snapshot.identity.version, "3.2.0");
    assert.equal(upgraded.event.payload.taskContractClaim.path, contractPath);
    assert.equal(
      Object.hasOwn(upgraded.event.payload.task.metadata ?? {}, "longRunning"),
      false,
    );
    assert.equal(
      JSON.parse(
        upgraded.blobs.find(
          ({ sha256 }) =>
            sha256 === upgraded!.event.payload.taskContractClaim.sha256,
        )!.body,
      ).packagePath,
      bootstrap.packagePath,
    );
    store.append(upgraded);
    projection.apply(upgraded.event, upgraded.plan);
    assert.equal(
      projection.read(taskId).snapshot.task?.presetSnapshotDigest,
      upgraded.snapshot.digest,
    );
    assert.deepEqual(
      projection.readPresetSnapshot(upgraded.snapshot.digest).snapshot,
      upgraded.snapshot,
    );
    assert.equal(
      JSON.parse(projection.readDocument(contractPath).document!.body)
        .presetSnapshotDigest,
      upgraded.snapshot.digest,
    );
    assert.equal(readFileSync(planPath, "utf8"), editedPlan);
    assert.throws(
      () =>
        compilePresetSnapshotUpgrade({
          userRoot,
          task: projection.read(taskId).snapshot.task!,
          taskContractBody:
            projection.readDocument(contractPath).document!.body,
          actor: { principal: { personId: "person-1" }, executor: null },
          source: "local",
          workspaceRevision: 3,
          eventId: "event-current",
          opId: "op-current",
          occurredAt: "2026-08-14T00:02:00.000Z",
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "snapshot_current",
    );
    const profiles = [
      {
        id: "baseline",
        title: "Baseline",
        completionGates: [],
        templateSelections: [
          {
            slot: "task.upgrade.evidence",
            templateRef: "template://upgrade/evidence@1",
            materializeAs: "upgrade-evidence.md",
            localePolicy: { prefer: "preset", fallback: "en-US" },
          },
        ],
      },
    ];
    writePackage(sourceRoot, "upgrade-task", { version: "3.3.0", profiles });
    write(
      path.join(sourceRoot, "upgrade-task/template-catalog.json"),
      JSON.stringify(
        templateCatalog(
          [
            {
              id: "upgrade/evidence",
              version: "1",
              documentKind: "upgrade-evidence",
              slot: "task.upgrade.evidence",
              materializeAs: "upgrade-evidence.md",
              frontmatterSchema: "task-package/v2",
              requiredAnchors: ["## Evidence"],
              fallbackLocale: "en-US",
              locales: [
                {
                  locale: "en-US",
                  anchors: ["## Evidence"],
                  bodyPath: "templates/upgrade-evidence.md",
                },
              ],
            },
          ],
          "upgrade-task",
        ),
      ),
    );
    write(
      path.join(sourceRoot, "upgrade-task/templates/upgrade-evidence.md"),
      "# Upgrade evidence\n\n## Evidence\n\nAdded by the changed preset definition.\n",
    );
    installPresetPackage({
      source: path.join(sourceRoot, "upgrade-task"),
      userRoot,
    });
    assert.throws(
      () =>
        compilePresetSnapshotUpgrade({
          userRoot,
          task: projection.read(taskId).snapshot.task!,
          taskContractBody:
            projection.readDocument(contractPath).document!.body,
          actor: { principal: { personId: "person-1" }, executor: null },
          source: "local",
          workspaceRevision: 3,
          eventId: "event-document-change",
          opId: "op-document-change",
          occurredAt: "2026-08-14T00:03:00.000Z",
        }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code ===
          "upgrade_document_set_changed" &&
        (error as Error).message ===
          "Preset upgrade changes the task document set and requires an explicit migration.",
    );
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("user template selections resolve only package-local canonical catalog bodies", async () => {
  const fixture = makeFixture(),
    sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source"),
    profile = [
      {
        id: "baseline",
        title: "Baseline",
        completionGates: [],
        templateSelections: [
          {
            slot: "task.user.impact",
            templateRef: "template://analysis/code-impact@1",
            materializeAs: "user-impact.md",
            localePolicy: { prefer: "preset", fallback: "en-US" },
          },
        ],
      },
    ];
  try {
    writePackage(sourceRoot, "user-impact", { profiles: profile });
    assert.throws(
      () =>
        installPresetPackage({
          source: path.join(sourceRoot, "user-impact"),
          userRoot: fixture.userRoot,
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "missing_template_catalog",
    );
    write(
      path.join(sourceRoot, "outside.md"),
      "# Outside\n\n## User Impact\n\nMust not be read.\n",
    );
    write(
      path.join(sourceRoot, "user-impact/template-catalog.json"),
      JSON.stringify(
        templateCatalog(
          [
            {
              id: "analysis/code-impact",
              version: "1",
              documentKind: "user-impact",
              slot: "task.user.impact",
              materializeAs: "user-impact.md",
              frontmatterSchema: "task-package/v2",
              requiredAnchors: ["## User Impact"],
              fallbackLocale: "en-US",
              locales: [
                {
                  locale: "en-US",
                  anchors: ["## User Impact"],
                  bodyPath: "../outside.md",
                },
              ],
            },
          ],
          "user-impact",
        ),
      ),
    );
    assert.throws(
      () =>
        installPresetPackage({
          source: path.join(sourceRoot, "user-impact"),
          userRoot: fixture.userRoot,
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "missing_template",
    );
    write(
      path.join(sourceRoot, "user-impact/template-catalog.json"),
      JSON.stringify(
        templateCatalog(
          [
            {
              id: "analysis/code-impact",
              version: "1",
              documentKind: "user-impact",
              slot: "task.user.impact",
              materializeAs: "user-impact.md",
              frontmatterSchema: "task-package/v2",
              requiredAnchors: ["## User Impact"],
              fallbackLocale: "en-US",
              locales: [
                {
                  locale: "en-US",
                  anchors: ["## User Impact"],
                  bodyPath: "templates/user-impact.md",
                },
              ],
            },
          ],
          "user-impact",
        ),
      ),
    );
    write(
      path.join(sourceRoot, "user-impact/templates/user-impact.md"),
      "# Local only\n\n## User Impact\n\nPackage body.\n",
    );
    installPresetPackage({
      source: path.join(sourceRoot, "user-impact"),
      userRoot: fixture.userRoot,
    });
    const resolved = createRuntime({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolveInternal({
      presetId: "user-impact",
      verticalId: "software/coding",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.match(
      resolved.documents.find(({ slot }) => slot === "task.user.impact")
        ?.body ?? "",
      /Package body/u,
    );
    assert.equal(resolved.snapshot.identity.layer, "user");
  } finally {
    fixture.cleanup();
  }
});

test("the same self-contained package has identical bundled and user snapshot content semantics", async () => {
  const fixture = makeFixture(),
    packageRoot = path.join(fixture.bundledRoot, "local-impact"),
    profile = [
      {
        id: "baseline",
        title: "Baseline",
        completionGates: [],
        templateSelections: [
          {
            slot: "task.user.impact",
            templateRef: "template://analysis/local-impact@1",
            materializeAs: "local-impact.md",
            localePolicy: { prefer: "preset", fallback: "en-US" },
          },
        ],
      },
    ];
  try {
    writePackage(fixture.bundledRoot, "local-impact", {
      profiles: profile,
      policyPath: "policy.json",
    });
    write(
      path.join(packageRoot, "policy.json"),
      JSON.stringify({ schema: "preset-policy/v1", requires: [] }),
    );
    write(
      path.join(packageRoot, "template-catalog.json"),
      JSON.stringify(
        templateCatalog(
          [
            {
              id: "analysis/local-impact",
              version: "1",
              documentKind: "local-impact",
              slot: "task.user.impact",
              materializeAs: "local-impact.md",
              frontmatterSchema: "task-package/v2",
              requiredAnchors: ["## Local Impact"],
              fallbackLocale: "en-US",
              locales: [
                {
                  locale: "en-US",
                  anchors: ["## Local Impact"],
                  bodyPath: "templates/local-impact.md",
                },
              ],
            },
          ],
          "local-impact",
        ),
      ),
    );
    write(
      path.join(packageRoot, "templates/local-impact.md"),
      "# Local only\n\n## Local Impact\n\nPackage body.\n",
    );
    const request = {
        presetId: "local-impact",
        verticalId: "software/coding",
        locale: "en-US",
        purpose: "task-create" as const,
      },
      bundled = createRuntime({
        bundledRoot: fixture.bundledRoot,
        userRoot: fixture.userRoot,
        assetsRoot: fixture.assetsRoot,
      }).resolveInternal(request);
    installPresetPackage({ source: packageRoot, userRoot: fixture.userRoot });
    const user = createRuntime({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
    }).resolveInternal(request);
    const semantics = ({ snapshot, documents }: typeof bundled) => ({
      profile: snapshot.profile,
      guidance: snapshot.guidance,
      scaffold: snapshot.scaffold,
      templates: snapshot.templates,
      entrypoints: snapshot.entrypoints,
      provenance: snapshot.provenance,
      documents,
    });
    assert.deepEqual(semantics(user), semantics(bundled));
    assert.equal(bundled.snapshot.identity.layer, "bundled");
    assert.equal(user.snapshot.identity.layer, "user");
    write(
      path.join(packageRoot, "policy.json"),
      JSON.stringify({ schema: "preset-policy/v0", requires: [] }),
    );
    assert.equal(
      (
        (await runPresetAction({
          rootDir: path.dirname(fixture.userRoot),
          action: { kind: "preset-validate", packageSource: packageRoot },
        })) as { issues: Array<{ code: string }> }
      ).issues[0]?.code,
      "invalid_policy",
    );
    assert.throws(
      () =>
        installPresetPackage({
          source: packageRoot,
          userRoot: fixture.userRoot,
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_policy",
    );
  } finally {
    fixture.cleanup();
  }
});

test("seed and audit dry-runs report the two-layer inventory without mutation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-seed-audit-")),
    userRoot = path.join(rootDir, ".harness/presets");
  try {
    const audit = (await runPresetAction({
      rootDir,
      action: { kind: "preset-audit" },
    })) as {
      schema: string;
      total: number;
      valid: number;
      unavailable: number;
      blocked: number;
      issues: Array<{ presetId: string; code: string }>;
    };
    assert.deepEqual(
      {
        schema: audit.schema,
        total: audit.total,
        valid: audit.valid,
        unavailable: audit.unavailable,
        blocked: audit.blocked,
        issues: audit.issues.map(({ presetId, code }) => ({ presetId, code })),
      },
      {
        schema: "preset-audit-report/v1",
        total: 12,
        valid: 12,
        unavailable: 0,
        blocked: 0,
        issues: [],
      },
    );
    const drySeed = (await runPresetAction({
      rootDir,
      action: { kind: "preset-seed", dryRun: true },
    })) as {
      schema: string;
      mode: string;
      packageCount: number;
      packages: Array<{ presetId: string }>;
    };
    assert.equal(drySeed.schema, "preset-seed-report/v1");
    assert.equal(drySeed.mode, "dry-run");
    assert.equal(drySeed.packageCount, 12);
    assert.deepEqual(
      drySeed.packages.map(({ presetId }) => presetId),
      [
        "architecture-rot-audit",
        "code-impact-analysis",
        "create-milestone",
        "decision-conformance",
        "docs-task",
        "github-issue-repair",
        "legacy-migration",
        "milestone-closeout",
        "module",
        "standard-task",
        "subtask-expansion",
        "worker-dispatch",
      ],
    );
    assert.equal(existsSync(userRoot), false);
    const seeded = (await runPresetAction({
      rootDir,
      action: { kind: "preset-seed" },
    })) as { mode: string; packageCount: number };
    assert.deepEqual(
      { mode: seeded.mode, packageCount: seeded.packageCount },
      { mode: "apply", packageCount: 12 },
    );
    assert.equal(readdirSync(path.join(userRoot, "active")).length, 12);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a preset document parses the same on a CRLF checkout as on an LF checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-crlf-"));
  try {
    const manifest = JSON.stringify({
      schema: "preset-manifest/v3",
      id: "crlf",
      title: "CRLF",
      vertical: "software/coding",
      version: "3.0.0",
      kind: "template-content",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      profiles: [
        {
          id: "baseline",
          title: "Baseline",
          completionGates: [],
          templateSelections: [],
        },
      ],
      defaultProfile: "baseline",
    });
    const frontmatter = (eol: string): string =>
      `---${eol}schema: preset-document/v1${eol}description: CRLF package${eol}whenToUse: Use on a Windows checkout.${eol}---${eol}# CRLF${eol}`;
    const lfRoot = path.join(root, "lf"),
      crlfRoot = path.join(root, "crlf");
    write(path.join(lfRoot, "preset.json"), manifest);
    write(path.join(lfRoot, "PRESET.md"), frontmatter("\n"));
    write(path.join(crlfRoot, "preset.json"), manifest);
    write(path.join(crlfRoot, "PRESET.md"), frontmatter("\r\n"));

    // Git for Windows checks out CRLF by default, so the frontmatter grammar
    // cannot encode LF. Field values must not carry the carriage return either.
    const lf = decodePresetPackageV3(lfRoot).document,
      crlf = decodePresetPackageV3(crlfRoot).document;
    assert.deepEqual({ ...crlf, body: null }, { ...lf, body: null });
    assert.equal(crlf.description, "CRLF package");
    assert.equal(crlf.whenToUse, "Use on a Windows checkout.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
