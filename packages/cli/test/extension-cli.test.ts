// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const catalogFixture = "packages/kernel/fixtures/schemas/template-catalog/valid.json";
const presetFixture = "packages/kernel/fixtures/schemas/preset-manifest/valid.json";
const verticalFixture = "packages/kernel/fixtures/schemas/vertical-definition/valid.json";

test("CLI template list emits stable JSON over the template catalog", () => {
  const result = runJson(["template", "list", "--catalog", catalogFixture]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "template-list");
  assert.deepEqual(result.templates, [{
    templateRef: "template://planning/task-flow@1",
    documentKind: "task-flow",
    slot: "task.flow",
    materializeAs: "task_flow.md",
    locales: ["zh-CN", "en-US"]
  }]);
});

test("CLI template render materializes a selected locale without writing files", () => {
  const result = runJson(["template", "render", "template://planning/task-flow@1", "--catalog", catalogFixture, "--locale", "zh-CN"]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "template-render");
  assert.equal(result.document.locale, "zh-CN");
  assert.equal(result.document.materializeAs, "stdout.md");
  assert.match(result.document.body, /## Goal/);
});

test("CLI template render hydrates template-catalog v2 bodyPath assets", () => {
  withTempCatalogV2((catalogPath) => {
    const result = runJson(["template", "render", "template://planning/task-flow@1", "--catalog", catalogPath, "--locale", "zh-CN"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "template-render");
    assert.equal(result.document.locale, "zh-CN");
    assert.match(result.document.body, /## Goal/);
  });
});

test("CLI template render rejects template-catalog v1 inputs explicitly", () => {
  withTempCatalogV1((catalogPath) => {
    const result = runJson(["template", "render", "template://planning/task-flow@1", "--catalog", catalogPath, "--locale", "zh-CN"], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "template-render");
    assert.equal(result.error?.code, "template_catalog_invalid");
    assert.equal(result.issues.some((issue) => issue.code === "template_catalog_v1_unsupported"), true);
  });
});

test("CLI template commands use bundled software coding catalog by default", () => {
  const listed = runJson(["template", "list"]);
  const rendered = runJson(["template", "render", "template://planning/task-plan@1", "--locale", "en-US"]);

  assert.equal(listed.ok, true);
  assert.equal(listed.command, "template-list");
  assert.equal(listed.templates.length, 41);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/task-plan@1" && template.materializeAs === "task_plan.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/brief@1" && template.materializeAs === "brief.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/module-plan@1" && template.materializeAs === "module_plan.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://dossier/editorial-shell@1" && template.materializeAs === "artifacts/dossier.scaffold.html"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://gate-retro/analysis@1" && template.materializeAs === "artifacts/gate-retro.analysis.scaffold.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/repo-governance@1" && template.materializeAs === "harness/standards/repo-governance.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/adr-template@1" && template.materializeAs === "adr/0000-template.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/decisions-readme@1" && template.materializeAs === "harness/decisions/README.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/context-readme@1" && template.materializeAs === "harness/context/README.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/agent-base@1" && template.materializeAs === "AGENTS.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/agent-overlay@1" && template.materializeAs === "AGENTS.md"), true);
  for (const templateRef of [
    "template://repository/architecture-readme@1",
    "template://repository/architecture-manifest@1",
    "template://repository/architecture-likec4-config@1",
    "template://repository/architecture-likec4-specification@1",
    "template://repository/architecture-likec4-model@1",
    "template://repository/architecture-likec4-view-landscape@1",
    "template://repository/architecture-likec4-view-write-path@1",
    "template://repository/architecture-likec4-view-runtime@1"
  ]) {
    assert.equal(listed.templates.some((template) => template.templateRef === templateRef), true, templateRef);
  }

  assert.equal(rendered.ok, true);
  assert.equal(rendered.command, "template-render");
  assert.equal(rendered.document.locale, "en-US");
  assert.equal(rendered.document.materializeAs, "stdout.md");
  assert.match(rendered.document.body, /## Implementation Plan/);
});

test("CLI renders the bilingual architecture guide and locale-neutral provider assets", () => {
  const anchors = [
    "## Purpose",
    "## Activation",
    "## Source of Truth",
    "## Authoring Contract",
    "## Views",
    "## Validation",
    "## Migration and Conflicts"
  ];
  const guideZh = runJson(["template", "render", "template://repository/architecture-readme@1", "--locale", "zh-CN"]);
  const guideEn = runJson(["template", "render", "template://repository/architecture-readme@1", "--locale", "en-US"]);
  const manifestFallback = runJson(["template", "render", "template://repository/architecture-manifest@1", "--locale", "zh-CN"]);

  for (const anchor of anchors) {
    assert.equal(guideZh.document.body.includes(anchor), true, anchor);
    assert.equal(guideEn.document.body.includes(anchor), true, anchor);
  }
  assert.equal(guideZh.document.locale, "zh-CN");
  assert.equal(guideEn.document.locale, "en-US");
  assert.equal(manifestFallback.document.locale, "en-US");
  assert.equal(JSON.parse(manifestFallback.document.body).schema, "architecture-manifest/v1");
});

test("CLI bundled template render fails closed on missing template refs", () => {
  const result = runJson(["template", "render", "template://planning/does-not-exist@1"], false);

  assert.equal(result.ok, false);
  assert.equal(result.command, "template-render");
  assert.equal(result.error?.code, "template_render_failed");
  assert.equal(result.issues.some((issue) => issue.code === "missing_template"), true);
});

test("CLI bundled additive task templates render both supported locales", () => {
  for (const templateRef of ["template://planning/worker-flow@1", "template://analysis/code-impact@1"]) {
    const zh = runJson(["template", "render", templateRef, "--locale", "zh-CN"]);
    const en = runJson(["template", "render", templateRef, "--locale", "en-US"]);

    assert.equal(zh.document.locale, "zh-CN");
    assert.equal(en.document.locale, "en-US");
    assert.notEqual(zh.document.body, en.document.body);
  }
});

test("CLI bundled additive presets discover, check, and create their extra task documents", () => {
  const cases = [
    { preset: "worker-dispatch", locale: "zh-CN", document: "worker-flow.md", content: /调度目标/u },
    { preset: "worker-dispatch", locale: "en-US", document: "worker-flow.md", content: /State the outcome this worker owns/u },
    { preset: "code-impact-analysis", locale: "zh-CN", document: "code-impact-analysis.md", content: /描述计划改变的行为/u },
    { preset: "code-impact-analysis", locale: "en-US", document: "code-impact-analysis.md", content: /Describe the proposed behavior change/u }
  ];

  for (const testCase of cases) {
    withTempRoot((rootDir) => {
      const listed = runRootJson(rootDir, ["preset", "list"]);
      const inspected = runRootJson(rootDir, ["preset", "inspect", testCase.preset]);
      const checked = runRootJson(rootDir, ["preset", "check", testCase.preset]);
      assert.equal(listed.presets.some((preset: Record<string, unknown>) => preset.id === testCase.preset), true);
      assert.equal(inspected.preset.manifest.schema, "preset-manifest/v2");
      assert.equal(inspected.preset.manifest.profiles[0].templateSelections[0].localePolicy.fallback, "en-US");
      assert.equal(checked.ok, true);

      writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
        "schema: harness-anything/v1",
        "settings:",
        "  identity:",
        "    personId: person_test",
        ""
      ].join("\n"));
      const created = runRootJson(rootDir, [
        "task", "create", "--title", "Additive Task", "--vertical", "software/coding",
        "--preset", testCase.preset, "--locale", testCase.locale
      ]);

      assert.equal(created.ok, true);
      assert.equal(created.generated.includes("task_plan.md"), true);
      assert.equal(created.generated.includes(testCase.document), true);
      assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /## Implementation Plan/u);
      assert.match(readFileSync(path.join(rootDir, created.packagePath, testCase.document), "utf8"), testCase.content);
    });
  }
});

test("CLI bundled AGENTS templates surface public worktree discipline", () => {
  const agentEn = runJson(["template", "render", "template://repository/agent-base@1", "--locale", "en-US"]);
  const agentZh = runJson(["template", "render", "template://repository/agent-base@1", "--locale", "zh-CN"]);
  const governance = runJson(["template", "render", "template://repository/repo-governance@1", "--locale", "en-US"]);

  assert.match(agentEn.document.body, /## Worktree discipline/u);
  assert.match(agentEn.document.body, /\.worktrees\/<slug>/u);
  assert.match(agentEn.document.body, /Do not edit `packages\/\*\*`.*shared repository root/u);
  assert.match(agentEn.document.body, /## Relation edge rules/u);
  assert.match(agentEn.document.body, /`refines` is for decision-to-decision revision, not for target `task\/\.\.\.`/u);
  assert.match(agentZh.document.body, /后台\/并行 worker/u);
  assert.match(agentZh.document.body, /\.worktrees\/<slug>/u);
  assert.match(agentZh.document.body, /`refines` 是 decision 到 decision 的修订关系，不用于 target `task\/\.\.\.`/u);
  assert.match(governance.document.body, /Public implementation work.*\.worktrees\/<slug>/u);
});

test("CLI preset validate reports kernel version incompatibility as stable JSON", () => {
  const result = runJson(["preset", "validate", presetFixture, "--kernel-version", "0.9.0"], false);

  assert.equal(result.ok, false);
  assert.equal(result.command, "preset-validate");
  assert.equal(result.error?.code, "preset_manifest_invalid");
  assert.equal(result.issues.some((issue) => issue.code === "incompatible_kernel"), true);
});

test("CLI preset validate success emits the declared receipt payload", () => {
  const result = runJson(["preset", "validate", presetFixture]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "preset-validate");
  assert.deepEqual(result.preset, { id: "software-coding-standard", version: "1.0.0" });
  assert.equal(result.report.schema, "preset-validate-report/v1");
  assert.equal(result.report.issueCount, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "issues"), false);
});

test("CLI vertical validate accepts the software coding vertical fixture", () => {
  const result = runJson(["vertical", "validate", verticalFixture]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "vertical-validate");
  assert.deepEqual(result.issues, []);
});

test("CLI vertical validate accepts the bundled software coding vertical", () => {
  const result = runJson(["vertical", "validate", "software/coding"]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "vertical-validate");
  assert.deepEqual(result.issues, []);
});

test("CLI extension decode failures do not leak absolute input paths", () => {
  const missingPath = path.join(process.cwd(), "tmp/missing-template-catalog.json");
  const result = runJson(["template", "list", "--catalog", missingPath], false);

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "decode_failed");
  assert.equal(JSON.stringify(result).includes(missingPath), false);
});

test("CLI vertical validate fails closed on unknown lifecycle mapping fields", () => {
  withTempFile("vertical.json", () => {
    const vertical = JSON.parse(readFileSync(verticalFixture, "utf8")) as Record<string, unknown>;
    vertical[`status${"Mapping"}`] = {
      todo: "planned"
    };
    return JSON.stringify(vertical);
  }, (filePath) => {
    const result = runJson(["vertical", "validate", filePath], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "vertical_definition_invalid");
    assert.equal(result.issues.some((issue) => issue.code === "unknown_extension_field"), true);
    assert.equal(JSON.stringify(result).includes(filePath), false);
  });
});

test("CLI vertical validate fails closed when fact declares a package scaffold", () => {
  withTempFile("vertical.json", () => {
    const vertical = JSON.parse(readFileSync(verticalFixture, "utf8")) as Record<string, any>;
    vertical.packageScaffolds = [
      ...vertical.packageScaffolds,
      {
        entityKind: "fact",
        templateSelections: []
      }
    ];
    return JSON.stringify(vertical);
  }, (filePath) => {
    const result = runJson(["vertical", "validate", filePath], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "vertical_definition_invalid");
    assert.equal(result.issues.some((issue) => issue.code === "vertical_schema_scaffold_forbidden"), true);
    assert.equal(JSON.stringify(result).includes(filePath), false);
  });
});

test("CLI preset validate fails closed on budget fields before they can become task entities", () => {
  withTempFile("preset.json", () => {
    const preset = JSON.parse(readFileSync(presetFixture, "utf8")) as Record<string, any>;
    preset.profiles[0].budget = "complex";
    return JSON.stringify(preset);
  }, (filePath) => {
    const result = runJson(["preset", "validate", filePath], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "preset_manifest_invalid");
    assert.equal(result.issues.some((issue) => issue.code === "unknown_extension_field"), true);
    assert.equal(JSON.stringify(result).includes(filePath), false);
  });
});

function runJson(args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function runRootJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      ZCODE_SESSION_ID: "",
      ANTIGRAVITY_SESSION_ID: ""
    }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot(fn: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-extension-cli-"));
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function withTempFile(name: string, body: () => string, fn: (filePath: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-extension-cli-"));
  try {
    const filePath = path.join(rootDir, name);
    writeFileSync(filePath, body());
    fn(filePath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function withTempCatalogV2(fn: (catalogPath: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-template-catalog-v2-"));
  try {
    const catalog = JSON.parse(readFileSync(catalogFixture, "utf8")) as Record<string, any>;
    copyCatalogBodies(catalog, rootDir);
    const catalogPath = path.join(rootDir, "template-catalog.json");
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    fn(catalogPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function withTempCatalogV1(fn: (catalogPath: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-template-catalog-v1-"));
  try {
    const catalog = JSON.parse(readFileSync(catalogFixture, "utf8")) as Record<string, any>;
    for (const document of catalog.documents) {
      for (const locale of document.locales) {
        locale.body = readFileSync(path.join(path.dirname(catalogFixture), locale.bodyPath), "utf8");
        delete locale.bodyPath;
      }
    }
    catalog.schema = "template-catalog/v1";
    const catalogPath = path.join(rootDir, "template-catalog.json");
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    fn(catalogPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function copyCatalogBodies(catalog: Record<string, any>, rootDir: string): void {
  for (const document of catalog.documents) {
    for (const locale of document.locales) {
      const targetPath = path.join(rootDir, locale.bodyPath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, readFileSync(path.join(path.dirname(catalogFixture), locale.bodyPath), "utf8"));
    }
  }
}
