#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runCliPackageSmoke(root = process.cwd()) {
  buildCliPackageArtifact(root);
  const tempRoot = path.join(tmpdir(), `harness-anything-cli-smoke-${Date.now()}`);
  const packDir = path.join(tempRoot, "pack");
  const consumerDir = path.join(tempRoot, "consumer");
  try {
    mkdirSync(packDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });

    const packOutput = execFileSync("npm", ["pack", "--workspace", "@harness-anything/cli", "--pack-destination", packDir, "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NPM_CONFIG_IGNORE_SCRIPTS: "true"
      }
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

    const binPath = resolveBinCommand(consumerDir, "harness-anything");
    const aliasBinPath = resolveBinCommand(consumerDir, "ha");
    const stdout = execFileSync(binPath.file, [...binPath.argsPrefix, "--json", "gui"], {
      cwd: consumerDir,
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_GUI_DRY_RUN: "1"
      }
    });
    const result = unwrapReceipt(JSON.parse(stdout));
    if (result.ok !== true || result.command !== "gui" || result.launchPlan?.packageName !== "@harness-anything/gui") {
      throw new Error(`unexpected CLI smoke output: ${stdout}`);
    }
    const aliasOutput = execFileSync(aliasBinPath.file, [...aliasBinPath.argsPrefix, "--json", "doctor"], {
      cwd: consumerDir,
      encoding: "utf8"
    });
    const aliasResult = unwrapReceipt(JSON.parse(aliasOutput));
    if (aliasResult.ok !== true || aliasResult.command !== "doctor" || aliasResult.report?.schema !== "harness-doctor/v1") {
      throw new Error(`unexpected CLI alias smoke output: ${aliasOutput}`);
    }

    const projectDir = path.join(consumerDir, "minimal-project");
    mkdirSync(projectDir, { recursive: true });
    const init = runJson(binPath, ["--json", "init"], projectDir);
    if (init.ok !== true || init.path !== "harness/harness.yaml") {
      throw new Error(`unexpected init smoke output: ${JSON.stringify(init)}`);
    }
    configureSmokeIdentity(projectDir);

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
}

function configureSmokeIdentity(projectDir) {
  const configPath = path.join(projectDir, "harness/harness.yaml");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, config.replace(
    /^settings:$/mu,
    "settings:\n  identity:\n    personId: person_harness_smoke\n    displayName: Harness Smoke"
  ), "utf8");
}

export function buildCliPackageArtifact(root, options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const exists = options.existsSync ?? existsSync;
  exec("npm", ["run", "build", "--workspace", "@harness-anything/cli"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NPM_CONFIG_IGNORE_SCRIPTS: "false"
    }
  });
  const binPath = path.join(root, "packages/cli/dist/cli/src/index.js");
  if (!exists(binPath)) {
    throw new Error(`explicit CLI package build did not produce ${binPath}`);
  }
}

function runJson(command, args, cwd) {
  return unwrapReceipt(JSON.parse(execFileSync(command.file, [...command.argsPrefix, ...args], {
    cwd,
    encoding: "utf8",
    env: smokeCliWriteEnv()
  })));
}

function smokeCliWriteEnv() {
  return {
    ...process.env,
    // Package smoke exercises the packaged in-process boundary; daemon
    // transport is covered by the dedicated daemon integration suite.
    HARNESS_DAEMON_MODE: "direct",
    // Test-only actor attribution for package smoke writes; real env wins.
    HARNESS_ACTOR: process.env.HARNESS_ACTOR || "agent:harness-smoke",
    HARNESS_GIT_AUTHOR_NAME: process.env.HARNESS_GIT_AUTHOR_NAME || "Harness Smoke",
    HARNESS_GIT_AUTHOR_EMAIL: process.env.HARNESS_GIT_AUTHOR_EMAIL || "harness-smoke@example.test"
  };
}

function resolveBinCommand(consumerDir, name) {
  const packageEntry = path.join(consumerDir, "node_modules", "@harness-anything", "cli", "dist", "cli", "src", "index.js");
  if (process.platform === "win32" && existsSync(packageEntry)) {
    return { file: process.execPath, argsPrefix: [packageEntry] };
  }
  const binRoot = path.join(consumerDir, "node_modules", ".bin");
  const candidates = process.platform === "win32"
    ? [`${name}.cmd`, `${name}.ps1`, name]
    : [name];
  for (const candidate of candidates) {
    const binPath = path.join(binRoot, candidate);
    if (existsSync(binPath)) return { file: binPath, argsPrefix: [] };
  }
  return { file: path.join(binRoot, name), argsPrefix: [] };
}

function unwrapReceipt(value) {
  const oldTopLevel = ["taskId", "path", "packagePath", "projectionPath", "report", "summary", "launchPlan", "document"];
  if (value.ok !== true || value.schema !== "command-receipt/v2" || typeof value.command !== "string") {
    throw new Error(`unexpected command-receipt/v2 output: ${JSON.stringify(value)}`);
  }
  for (const key of oldTopLevel) {
    if (Object.prototype.hasOwnProperty.call(value, key) && key !== "summary") {
      throw new Error(`receipt leaked old top-level field ${key}: ${JSON.stringify(value)}`);
    }
  }
  const data = value.details?.data && typeof value.details.data === "object" ? value.details.data : {};
  const paths = Object.fromEntries(Array.isArray(value.paths) ? value.paths.map((entry) => [entry.role, entry.path]) : []);
  return {
    ...data,
    ok: value.ok,
    command: value.command,
    receipt: value.schema,
    receiptSummary: value.summary,
    paths,
    path: paths.primary,
    packagePath: paths.package,
    projectionPath: paths.projection,
    warnings: Array.isArray(value.warnings) ? value.warnings : []
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCliPackageSmoke();
}
