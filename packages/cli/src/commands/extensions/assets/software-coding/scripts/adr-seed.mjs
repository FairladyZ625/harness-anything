#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) {
  throw new Error("script context and result paths are required");
}

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const catalog = JSON.parse(readFileSync(new URL("../template-catalog.json", import.meta.url), "utf8"));
const locale = context.inputs?.locale === "zh-CN" ? "zh-CN" : "en-US";
const adrRoot = context.paths.adrRoot;

mkdirSync(adrRoot, { recursive: true });
const produced = [
  writeTemplate("repository/adr-readme", path.join(adrRoot, "README.md")),
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
    templateRefs: ["template://repository/adr-readme@1", "template://repository/adr-template@1"]
  },
  produced
}, null, 2), "utf8");

function writeTemplate(id, outputPath) {
  const document = catalog.documents.find((candidate) => candidate.id === id && candidate.version === "1");
  if (!document) throw new Error(`missing template ${id}`);
  const selected = document.locales.find((variant) => variant.locale === locale)
    ?? document.locales.find((variant) => variant.locale === document.fallbackLocale);
  if (!selected) throw new Error(`missing locale for template ${id}`);
  writeFileSync(outputPath, selected.body.endsWith("\n") ? selected.body : `${selected.body}\n`, "utf8");
  return path.relative(context.paths.rootDir, outputPath).split(path.sep).join("/");
}
