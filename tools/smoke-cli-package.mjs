#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const tempRoot = path.join(tmpdir(), `harness-anything-cli-smoke-${Date.now()}`);
const packDir = path.join(tempRoot, "pack");
const consumerDir = path.join(tempRoot, "consumer");

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  const packOutput = execFileSync("npm", ["pack", "--workspace", "@harness-anything/cli", "--pack-destination", packDir, "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  const [packed] = JSON.parse(packOutput);
  const tarballPath = path.join(packDir, packed.filename);
  if (!packed?.filename || !existsSync(tarballPath)) {
    throw new Error(`npm pack did not create expected tarball in ${packDir}`);
  }

  execFileSync("npm", ["install", "--prefix", consumerDir, "--no-audit", "--no-fund", tarballPath], {
    cwd: root,
    stdio: "inherit"
  });

  const binPath = path.join(consumerDir, "node_modules/.bin/harness-anything");
  const aliasBinPath = path.join(consumerDir, "node_modules/.bin/ha");
  const stdout = execFileSync(binPath, ["--json", "gui"], {
    cwd: consumerDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_GUI_DRY_RUN: "1"
    }
  });
  const result = JSON.parse(stdout);
  if (result.ok !== true || result.command !== "gui" || result.launchPlan?.packageName !== "@harness-anything/gui") {
    throw new Error(`unexpected CLI smoke output: ${stdout}`);
  }
  const aliasOutput = execFileSync(aliasBinPath, ["--json", "doctor"], {
    cwd: consumerDir,
    encoding: "utf8"
  });
  const aliasResult = JSON.parse(aliasOutput);
  if (aliasResult.ok !== true || aliasResult.command !== "doctor" || aliasResult.report?.schema !== "harness-doctor/v1") {
    throw new Error(`unexpected CLI alias smoke output: ${aliasOutput}`);
  }

  const projectDir = path.join(consumerDir, "minimal-project");
  mkdirSync(projectDir, { recursive: true });
  const init = runJson(binPath, ["--json", "init"], projectDir);
  if (init.ok !== true || init.path !== "harness/harness.yaml") {
    throw new Error(`unexpected init smoke output: ${JSON.stringify(init)}`);
  }

  const created = runJson(binPath, ["--json", "new-task", "--title", "Smoke Task"], projectDir);
  if (created.ok !== true || typeof created.taskId !== "string" || !created.taskId.startsWith("task_") || created.report?.vertical !== "software/coding" || created.report?.preset !== "standard-task") {
    throw new Error(`unexpected new-task smoke output: ${JSON.stringify(created)}`);
  }

  const status = runJson(binPath, ["--json", "status"], projectDir);
  if (status.ok !== true || status.report?.schema !== "harness-check-report/v1" || status.summary?.taskCount !== 1) {
    throw new Error(`unexpected status smoke output: ${JSON.stringify(status)}`);
  }

  const check = runJson(binPath, ["--json", "check", "--post-merge"], projectDir);
  if (check.ok !== true || check.report?.schema !== "harness-check-report/v1" || !Array.isArray(check.report?.axes)) {
    throw new Error(`unexpected check smoke output: ${JSON.stringify(check)}`);
  }

  const doctor = runJson(binPath, ["--json", "doctor"], projectDir);
  if (doctor.ok !== true || doctor.report?.schema !== "harness-doctor/v1" || doctor.report?.readOnly !== true) {
    throw new Error(`unexpected doctor smoke output: ${JSON.stringify(doctor)}`);
  }

  const renderedTemplate = runJson(binPath, ["--json", "template", "render", "template://planning/task-plan@1", "--locale", "en-US"], projectDir);
  if (renderedTemplate.ok !== true || renderedTemplate.document?.locale !== "en-US" || !String(renderedTemplate.document?.body ?? "").includes("## Implementation Plan")) {
    throw new Error(`unexpected bundled template smoke output: ${JSON.stringify(renderedTemplate)}`);
  }

  console.log("CLI package smoke passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runJson(binPath, args, cwd) {
  return JSON.parse(execFileSync(binPath, args, { cwd, encoding: "utf8" }));
}
