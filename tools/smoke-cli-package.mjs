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

  execFileSync("npm", ["--workspace", "@harness-anything/cli", "run", "build"], {
    cwd: root,
    stdio: "inherit"
  });

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

  console.log("CLI package smoke passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
