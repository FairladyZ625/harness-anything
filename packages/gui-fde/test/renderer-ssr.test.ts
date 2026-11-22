// harness-test-tier: integration
// dec_42EB7B8F636C12381A447E52A3/CH2: headless Vite SSR verification of all 5 builder sections and 3 preview panes.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { createDefaultFdeDraft } from "../src/studio/domain-draft.ts";
import { compileStudioDraft } from "../src/studio/compiler.ts";
import type { FdeSimulateReportDto } from "../src/studio/studio-api.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("renders split workbench shell, all five builder sections, and all three preview panes headlessly", async (t) => {
  const vite = await createServer({
    root: packageRoot,
    configFile: path.join(packageRoot, "vite.config.ts"),
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());

  const [
    { App },
    { EntitiesSection },
    { GatesSection },
    { PresetsSection },
    { AgentsSection },
    { DossierSection },
    { MaterializedTreePane },
    { HtmlSandboxPane },
    { GateSimulatorPane },
  ] = await Promise.all([
    vite.ssrLoadModule("/src/renderer/App.tsx"),
    vite.ssrLoadModule("/src/renderer/sections/EntitiesSection.tsx"),
    vite.ssrLoadModule("/src/renderer/sections/GatesSection.tsx"),
    vite.ssrLoadModule("/src/renderer/sections/PresetsSection.tsx"),
    vite.ssrLoadModule("/src/renderer/sections/AgentsSection.tsx"),
    vite.ssrLoadModule("/src/renderer/sections/DossierSection.tsx"),
    vite.ssrLoadModule("/src/renderer/panes/MaterializedTreePane.tsx"),
    vite.ssrLoadModule("/src/renderer/panes/HtmlSandboxPane.tsx"),
    vite.ssrLoadModule("/src/renderer/panes/GateSimulatorPane.tsx"),
  ]);

  const draft = createDefaultFdeDraft({ verticalId: "compliance/kyc", title: "KYC Compliance" });
  const compiled = compileStudioDraft(draft, "/tmp/fde-ssr-root");
  const noop = () => undefined;

  const appHtml = renderToStaticMarkup(React.createElement(App));
  assert.match(appHtml, /FDE STUDIO/u);
  assert.match(appHtml, /① 实体与关系/u);
  assert.match(appHtml, /② 完成门绑定/u);
  assert.match(appHtml, /③ Preset 模板/u);
  assert.match(appHtml, /④ 角色 Agent/u);
  assert.match(appHtml, /⑤ 活档案规则/u);
  assert.match(appHtml, /① 物化文件/u);
  assert.match(appHtml, /② HTML 沙箱/u);
  assert.match(appHtml, /③ 门禁仿真/u);
  assert.match(appHtml, /保存 verticals\/procurement-review/u);

  const entitiesHtml = renderToStaticMarkup(React.createElement(EntitiesSection, { draft, onChange: noop }));
  assert.match(entitiesHtml, /DELIV/u);
  assert.match(entitiesHtml, /Allowed Relations/u);

  const gatesHtml = renderToStaticMarkup(React.createElement(GatesSection, { draft, onChange: noop }));
  assert.match(gatesHtml, /deliverable-contract/u);
  assert.match(gatesHtml, /Positive Sample JSON/u);
  assert.match(gatesHtml, /Negative Sample JSON/u);

  const presetsHtml = renderToStaticMarkup(React.createElement(PresetsSection, { draft, onChange: noop }));
  assert.match(presetsHtml, /zh-CN Template/u);
  assert.match(presetsHtml, /en-US Template/u);

  const agentsHtml = renderToStaticMarkup(React.createElement(AgentsSection, { draft, onChange: noop }));
  assert.match(agentsHtml, /contributor/u);
  assert.match(agentsHtml, /closeout-reviewer/u);

  const dossierHtml = renderToStaticMarkup(
    React.createElement(DossierSection, { draft, validation: compiled.dossierValidation, onChange: noop }),
  );
  assert.match(dossierHtml, /SCHEMA OK/u);
  assert.match(dossierHtml, /project-atlas\.html/u);

  const treeHtml = renderToStaticMarkup(React.createElement(MaterializedTreePane, { compiled, report: null }));
  assert.match(treeHtml, /vertical\.json/u);

  const sandboxHtml = renderToStaticMarkup(React.createElement(HtmlSandboxPane, { previews: compiled.htmlPreviews }));
  assert.match(sandboxHtml, /sandbox=""/u);
  assert.match(sandboxHtml, /project-atlas\.html/u);
  assert.match(sandboxHtml, /explainer\.html/u);

  const report: FdeSimulateReportDto = {
    schema: "vertical-simulate-report/v1",
    ok: true,
    zeroLedgerWrites: true,
    locale: "zh-CN",
    vertical: {
      id: "compliance/kyc",
      title: "KYC Compliance",
      version: "1.0.0",
      source: "verticals/compliance-kyc",
      valid: true,
      issues: [],
    },
    bootstrap: {
      ok: true,
      defaultPresetId: "domain-task",
      defaultProfileId: "verified",
      workPresetId: "work-root",
      issues: [],
    },
    agents: { ok: true, ids: ["contributor", "closeout-reviewer"], declarations: [], issues: [] },
    previews: { repository: [], regularTask: null, workTask: null },
    gates: [
      {
        gateId: "deliverable-contract",
        sourceId: "compliance-kyc/deliverable-contract",
        sourceKind: "command",
        presetId: "domain-task",
        profileId: "verified",
        ok: true,
        positive: {
          expected: "pass",
          ok: true,
          result: "pass",
          diagnostic: "Verified artifacts/deliverable.json.",
          predicateIssues: [],
          blockerCode: null,
        },
        negative: {
          expected: "fail",
          ok: true,
          result: "fail",
          diagnostic: "owner must be a non-empty string",
          predicateIssues: [],
          blockerCode: "gate_failed",
        },
      },
    ],
    diagnostics: [],
  };

  const simHtml = renderToStaticMarkup(
    React.createElement(GateSimulatorPane, { report, simulating: false, onSimulate: noop }),
  );
  assert.match(simHtml, /SIMULATION PASS/u);
  assert.match(simHtml, /Positive Sample/u);
  assert.match(simHtml, /Negative Sample/u);
  assert.match(simHtml, /blocker: gate_failed/u);
});
