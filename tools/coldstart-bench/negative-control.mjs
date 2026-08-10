#!/usr/bin/env node

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceChannelPaths,
  makeRunDirectoryWritable,
  reconcileEvidence,
  sealRunDirectory,
  writeJson
} from "./evidence.mjs";
import { assertValidRunRecord } from "./schema-validator.mjs";

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = createMissingChannelNegativeControl(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function createMissingChannelNegativeControl({ sourceRunDir, runDir, omittedChannel }) {
  if (!path.isAbsolute(sourceRunDir) || !path.isAbsolute(runDir)) throw new Error("source and target run directories must be absolute");
  if (!existsSync(path.join(sourceRunDir, "run.json"))) throw new Error(`source run record is missing: ${sourceRunDir}`);
  if (existsSync(runDir)) throw new Error(`append-only negative-control directory already exists: ${runDir}`);
  if (!Object.hasOwn(evidenceChannelPaths, omittedChannel)) throw new Error(`unknown evidence channel: ${omittedChannel}`);
  if (!path.relative(sourceRunDir, runDir).startsWith("..")) throw new Error("negative-control directory must not be nested inside its source run");

  cpSync(sourceRunDir, runDir, { recursive: true, errorOnExist: true });
  makeRunDirectoryWritable(runDir);
  const omittedPath = path.join(runDir, evidenceChannelPaths[omittedChannel]);
  rmSync(omittedPath, { force: false });
  const source = JSON.parse(readFileSync(path.join(sourceRunDir, "run.json"), "utf8"));
  const reconciled = reconcileEvidence(runDir, source.scenario.verificationIds);
  const run = {
    ...source,
    runId: `${source.runId}-negative-${omittedChannel}`,
    recordedAt: new Date().toISOString(),
    status: reconciled.reconciliation.status,
    outcome: "unknown",
    control: {
      kind: "missing-channel-negative",
      sourceRunId: source.runId,
      omittedChannel
    },
    evidence: reconciled.evidence,
    reconciliation: reconciled.reconciliation,
    validity: {
      status: "invalid",
      reasons: ["evidence-incomplete", `negative-control-omitted:${omittedChannel}`]
    }
  };
  assertValidRunRecord(run);
  writeJson(path.join(runDir, "run.json"), run);
  sealRunDirectory(runDir);
  return {
    ok: run.status === "incomplete" && run.validity.status === "invalid",
    runId: run.runId,
    runRecord: path.join(runDir, "run.json"),
    omittedChannel,
    omittedPathPresent: existsSync(omittedPath),
    status: run.status,
    issues: run.reconciliation.issues
  };
}

function parseOptions(args) {
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const sourceRunDir = value("--source-run-dir");
  const runDir = value("--run-dir");
  if (!sourceRunDir || !runDir) {
    throw new Error("Usage: node tools/coldstart-bench/negative-control.mjs --source-run-dir <absolute-path> --run-dir <absolute-path> [--omit cliReceipts]");
  }
  return {
    sourceRunDir: path.resolve(sourceRunDir),
    runDir: path.resolve(runDir),
    omittedChannel: value("--omit") ?? "cliReceipts"
  };
}
