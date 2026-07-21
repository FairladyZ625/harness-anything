import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliBuildPrefixes = [
  "packages/adapters/local/src/",
  "packages/adapters/multica/src/",
  "packages/application/src/",
  "packages/cli/src/",
  "packages/daemon/src/",
  "packages/gui/src/",
  "packages/kernel/src/"
];

const rootBuildFiles = new Set(["package-lock.json", "package.json", "tsconfig.json"]);
const cliBuildFiles = new Set([
  "packages/adapters/local/package.json",
  "packages/adapters/multica/package.json",
  "packages/application/package.json",
  "packages/cli/package.json",
  "packages/cli/scripts/copy-assets.mjs",
  "packages/cli/tsconfig.build.json",
  "packages/daemon/package.json",
  "packages/gui/package.json",
  "packages/kernel/package.json"
]);
const guiBuildPrefixes = ["packages/application/src/", "packages/gui/src/", "packages/kernel/src/"];
const guiBuildFiles = new Set([
  "packages/application/package.json",
  "packages/gui/package.json",
  "packages/kernel/package.json"
]);

function isPackageManifest(file) {
  return file === "package.json" || file === "package-lock.json" || file.endsWith("/package.json");
}

export function planPostMergeRuntimeRefresh(input) {
  const buildCli = input.changedPaths.some((file) =>
    rootBuildFiles.has(file) || cliBuildFiles.has(file) || cliBuildPrefixes.some((prefix) => file.startsWith(prefix))
  );
  const buildGui = input.changedPaths.some((file) =>
    rootBuildFiles.has(file) || guiBuildFiles.has(file) || guiBuildPrefixes.some((prefix) => file.startsWith(prefix))
  );
  const onCanonicalMain = input.branch === "main";

  return {
    buildCli,
    buildGui,
    installCli: buildCli && onCanonicalMain,
    syncDependencies: input.changedPaths.some(isPackageManifest)
  };
}

export function executePostMergeRuntimeRefresh(input) {
  const cliEntry = path.join(input.repoRoot, "packages/cli/dist/cli/src/index.js");
  const wrapped = (label, command, args) => input.run(process.execPath, [
    "tools/run-with-local-resources.mjs",
    "--label",
    label,
    "--",
    command,
    ...args
  ]);

  if (input.plan.syncDependencies) {
    wrapped("git-hook-dependency-sync", "npm", ["ci"]);
  }
  if (input.plan.buildCli) {
    // kernel dist/index.d.ts is a git-ignored declaration artifact that the CLI
    // build resolves through the package "types" condition; it must be
    // regenerated first or a changed kernel public surface fails every
    // downstream tsc build against stale declarations.
    wrapped("git-hook-kernel-decls", "npx", ["tsc", "-p", "packages/kernel/tsconfig.json"]);
    wrapped("git-hook-cli-build", "npm", ["run", "build", "-w", "@harness-anything/cli"]);
  }
  if (input.plan.buildGui) {
    wrapped("git-hook-gui-build", "npm", ["run", "build", "-w", "@harness-anything/gui"]);
  }
  if (input.plan.installCli) {
    input.run(process.execPath, [cliEntry, "--json", "version"], { print: false });
    input.run("npm", ["install", "-g", "./packages/cli"]);
  }
}

export function runPostMergeRuntimeRefresh(input) {
  const branch = input.run("git", ["branch", "--show-current"], { print: false }).trim();
  const changedPaths = input.run("git", [
    "diff",
    "--name-only",
    input.previousHead,
    input.currentHead,
    "--"
  ], { print: false }).split(/\r?\n/u).filter(Boolean);
  const plan = planPostMergeRuntimeRefresh({ branch, changedPaths });
  input.log?.(`post-merge: plan dependency-sync=${plan.syncDependencies} cli-build=${plan.buildCli} gui-build=${plan.buildGui} install-cli=${plan.installCli}`);
  executePostMergeRuntimeRefresh({
    plan,
    repoRoot: input.repoRoot,
    run: input.run
  });
  return plan;
}

export function createPostMergeCommandRunner(repoRoot) {
  return (command, args, options = {}) => {
    if (options.print !== false) {
      execFileSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit",
        windowsHide: true
      });
      return "";
    }
    const output = execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return output;
  };
}

export function main(argv = process.argv.slice(2)) {
  const previousHead = argv[0];
  const currentHead = argv[1] ?? "HEAD";
  if (!previousHead) throw new Error("post-merge: expected <previous-head> [current-head]");
  const repoRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim());
  return runPostMergeRuntimeRefresh({
    currentHead,
    previousHead,
    repoRoot,
    run: createPostMergeCommandRunner(repoRoot),
    log: (message) => console.log(message)
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
    if (stderr) process.stderr.write(stderr);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
