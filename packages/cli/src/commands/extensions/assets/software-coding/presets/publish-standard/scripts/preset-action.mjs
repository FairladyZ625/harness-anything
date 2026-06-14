#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");

const context = JSON.parse(readFileSync(contextPath, "utf8"));
const referencesDir = path.join(context.outputRoot, "references");
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(referencesDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(path.join(referencesDir, `${context.presetId}.md`), `# ${context.presetTitle}\n\nMode: capability-smoke\nEntrypoint: ${context.entrypoint}\nTask: ${context.taskId}\n\nThis scaffold records preset script execution wiring only. It is not a complete publish workflow.\n`, "utf8");
writeFileSync(path.join(artifactsDir, "evidence.json"), JSON.stringify({
  schema: "preset-script-output/v1",
  mode: "capability-smoke",
  presetId: context.presetId,
  entrypoint: context.entrypoint,
  taskId: context.taskId
}, null, 2), "utf8");
