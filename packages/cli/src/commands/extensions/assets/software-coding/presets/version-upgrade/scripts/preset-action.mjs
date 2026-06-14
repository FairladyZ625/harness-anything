#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const outputDir = path.join(context.outputRoot, "artifacts");
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, "evidence.json"), JSON.stringify({ schema: "preset-script-output/v1", mode: "capability-smoke", presetId: context.presetId, entrypoint: context.entrypoint, taskId: context.taskId }, null, 2), "utf8");
