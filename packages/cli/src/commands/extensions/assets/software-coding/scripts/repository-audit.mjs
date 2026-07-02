#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const contextPath = process.env.HARNESS_SCRIPT_CONTEXT;
const resultPath = process.env.HARNESS_SCRIPT_RESULT;
if (!contextPath || !resultPath) {
  throw new Error("script context and result paths are required");
}

const context = JSON.parse(readFileSync(contextPath, "utf8"));
writeFileSync(resultPath, JSON.stringify({
  schema: "script-result/v1",
  ok: true,
  report: {
    scriptId: context.scriptId,
    source: context.source,
    verticalId: context.verticalId,
    scaffold: "software-coding"
  },
  produced: []
}), "utf8");
