#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) {
  throw new Error("script context and result paths are required");
}

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const catalogUrl = new URL("../template-catalog.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogUrl, "utf8"));
const locale = context.inputs?.locale === "zh-CN" ? "zh-CN" : "en-US";
const adrRoot = context.paths.adrRoot;

mkdirSync(adrRoot, { recursive: true });
// adr/README.md is owned by the init seededDoc (single source, ADR-0021 D1).
// adr-seed only seeds the ADR template stub, which init does not materialize.
const produced = [
  writeTemplate("repository/adr-template", path.join(adrRoot, "0000-template.md"))
];

writeFileSync(resultPath, JSON.stringify({
  schema: "script-result/v1",
  ok: true,
  report: {
    scriptId: context.scriptId,
    source: context.source,
    verticalId: context.verticalId,
    adrRoot: path.relative(context.paths.authoredRoot, adrRoot).split(path.sep).join("/"),
    templateRefs: ["template://repository/adr-template@1"]
  },
  produced
}, null, 2), "utf8");

function writeTemplate(id, outputPath) {
  const document = catalog.documents.find((candidate) => candidate.id === id && candidate.version === "1");
  if (!document) throw new Error(`missing template ${id}`);
  const selected = document.locales.find((variant) => variant.locale === locale)
    ?? document.locales.find((variant) => variant.locale === document.fallbackLocale);
  if (!selected) throw new Error(`missing locale for template ${id}`);
  const body = readTemplateBody(selected);
  writeFileSync(outputPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return path.relative(context.paths.rootDir, outputPath).split(path.sep).join("/");
}

function readTemplateBody(selected) {
  if (typeof selected.body === "string") return selected.body;
  if (typeof selected.bodyPath !== "string") throw new Error("template locale must declare bodyPath");
  return readFileSync(new URL(selected.bodyPath, catalogUrl), "utf8");
}
