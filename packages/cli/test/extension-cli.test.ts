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

test("CLI template commands use bundled software coding catalog by default", () => {
  const listed = runJson(["template", "list"]);
  const rendered = runJson(["template", "render", "template://planning/task-plan@1", "--locale", "en-US"]);

  assert.equal(listed.ok, true);
  assert.equal(listed.command, "template-list");
  assert.equal(listed.templates.length, 21);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/task-plan@1" && template.materializeAs === "task_plan.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/brief@1" && template.materializeAs === "brief.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://planning/module-plan@1" && template.materializeAs === "module_plan.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/repo-governance@1" && template.materializeAs === "harness/standards/repo-governance.md"), true);
  assert.equal(listed.templates.some((template) => template.templateRef === "template://repository/adr-template@1" && template.materializeAs === "adr/0000-template.md"), true);

  assert.equal(rendered.ok, true);
  assert.equal(rendered.command, "template-render");
  assert.equal(rendered.document.locale, "en-US");
  assert.equal(rendered.document.materializeAs, "stdout.md");
  assert.match(rendered.document.body, /## Implementation Plan/);
});

test("CLI bundled template render fails closed on missing template refs", () => {
  const result = runJson(["template", "render", "template://planning/does-not-exist@1"], false);

  assert.equal(result.ok, false);
  assert.equal(result.command, "template-render");
  assert.equal(result.error?.code, "template_render_failed");
  assert.equal(result.issues.some((issue) => issue.code === "missing_template"), true);
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
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
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
    const assetDir = path.join(rootDir, "templates/task.flow");
    mkdirSync(assetDir, { recursive: true });
    for (const locale of catalog.documents[0].locales) {
      const bodyPath = `templates/task.flow/${locale.locale}.md`;
      writeFileSync(path.join(rootDir, bodyPath), locale.body, "utf8");
      delete locale.body;
      locale.bodyPath = bodyPath;
    }
    catalog.schema = "template-catalog/v2";
    const catalogPath = path.join(rootDir, "template-catalog.json");
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    fn(catalogPath);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
