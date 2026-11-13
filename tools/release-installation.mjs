#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractTree, resolveRevision } from "./readonly-checkout.mjs";
import { readWorkspacePackages } from "./public-workspaces.mjs";
import { preparePackageExports, backupName, ownerName } from "./package-exports-lifecycle.mjs";

const execute = promisify(execFile);
const help = `Usage: node tools/release-installation.mjs <install|switch|rollback|status> --root <installation> [options]
  install --repository <checkout> --revision <commit-or-tag>
  switch --revision <installed-commit> --user-root <state> --daemon-id <id> --workspace <registered-repo>
  rollback --user-root <state> --daemon-id <id> --workspace <registered-repo>
  status
Installation never starts a daemon. Switching uses the old release to stop it and the target release to start it.
An existing unmanaged daemon must be stopped with its own CLI before the first switch. No service or PATH is changed.`;

export async function runReleaseCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      repository: { type: "string" },
      revision: { type: "string" },
      "user-root": { type: "string" },
      "daemon-id": { type: "string" },
      workspace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help };
  const command = positionals[0];
  if (positionals.length !== 1 || !["install", "switch", "rollback", "status"].includes(command) || !values.root)
    throw new Error(help);
  if (process.platform === "win32" && command !== "status")
    throw new Error("Fixed-release operations require POSIX atomic directory-symbolic-link replacement semantics.");
  const root = path.resolve(values.root);
  if (command === "status") return readState(root);
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, ".deployment-lock");
  // A deployment is one host operation, not one operation per edge. Refuse overlap instead of
  // running two switches against the same singleton. A crashed owner leaves an explicit lock.
  writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  try {
    if (command === "install") return await install(root, values);
    for (const key of ["user-root", "daemon-id", "workspace"]) if (!values[key]) throw new Error(`Missing --${key}`);
    const state = readState(root),
      revision = command === "rollback" ? state.previous : values.revision;
    if (!revision) throw new Error(command === "rollback" ? "No previous release is recorded." : "Missing --revision");
    return await switchRelease(root, revision, state, values);
  } finally {
    unlinkSync(lock);
  }
}

async function install(root, values) {
  if (!values.repository || !values.revision) throw new Error("Install requires --repository and --revision.");
  const repository = path.resolve(values.repository),
    resolved = resolveRevision(repository, values.revision);
  if (!resolved.ok) throw new Error(resolved.detail);
  const { commit } = resolved,
    destination = path.join(root, "versions", commit);
  if (existsSync(destination))
    throw new Error(`Release already exists: ${destination}; never rebuild a release in place.`);
  const staging = path.join(root, "versions", `.install-${commit}-${process.pid}`);
  const extracted = extractTree(repository, commit, staging);
  if (!extracted.ok) throw new Error(extracted.detail);
  const env = { ...process.env, HARNESS_BUILD_COMMIT: commit };
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], staging, env);
  await run("npm", ["rebuild", "node-pty"], staging, env);
  const packages = readWorkspacePackages(staging),
    byName = new Map(packages.map((entry) => [entry.manifest.name, entry])),
    built = new Set();
  const build = async (name) => {
    if (built.has(name)) return;
    const entry = byName.get(name);
    if (!entry) return;
    // The installed runtime closure is bounded by the workspace dependency graph, never ledger size.
    built.add(name);
    for (const dependency of Object.keys({ ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies }))
      await build(dependency);
    const script = entry.manifest.scripts?.["build:publish"] ? "build:publish" : "build";
    if (entry.manifest.scripts?.[script]) await run("npm", ["run", script, "--workspace", name], staging, env);
  };
  await build("@harness-anything/cli");
  for (const name of built) {
    const directory = path.join(staging, byName.get(name).directory);
    preparePackageExports(directory);
    for (const marker of [backupName, ownerName]) unlinkSync(path.join(directory, marker));
  }
  writeFileSync(
    path.join(staging, "release.json"),
    `${JSON.stringify({ commit, node: process.version, installedAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx" },
  );
  await run(
    "npm",
    ["rebuild", "--ignore-scripts", "--workspace", "@harness-anything/cli", "--workspace", "@harness-anything/daemon"],
    staging,
    env,
  );
  renameSync(staging, destination);
  return { ok: true, command: "install", commit, directory: destination };
}

async function switchRelease(root, revision, state, values) {
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("Switch requires the full installed commit id.");
  const target = path.join(root, "versions", revision),
    manifest = readJson(path.join(target, "release.json"));
  if (manifest.commit !== revision) throw new Error("Release directory and installed commit disagree.");
  const context = {
    userRoot: path.resolve(values["user-root"]),
    daemonId: values["daemon-id"],
    workspace: realpathSync(path.resolve(values.workspace)),
  };
  if (state.target && JSON.stringify(state.target) !== JSON.stringify(context))
    throw new Error(
      "This installation belongs to another daemon target; use its original target or a separate installation root.",
    );
  const flags = [
    "--user-root",
    context.userRoot,
    "--daemon-id",
    context.daemonId,
    "--root",
    context.workspace,
    "--json",
  ];
  if (state.current && state.current !== revision) {
    const previous = path.join(root, "versions", state.current);
    // Use the predecessor CLI for lifecycle control, including when the target protocol changes.
    const stopped = parseCliReceipt(
      await run(process.execPath, [releaseCliEntry(previous), "daemon", "stop", ...flags], previous, process.env, true),
      true,
    );
    if (stopped.ok !== true && stopped.code !== "daemon_unavailable") throw new Error(JSON.stringify(stopped));
    if (stopped.draining === true) throw new Error("Old release is still draining; retry after it exits.");
  }
  if (state.current === null) {
    const existing = parseCliReceipt(
      await run(process.execPath, [releaseCliEntry(target), "daemon", "status", ...flags], target, process.env, true),
      true,
    );
    if (existing.ok === true)
      throw Object.assign(
        new Error(
          "daemon_unmanaged: Stop the existing daemon with its own CLI before the first release switch; its build may match but its executable is not managed by this installation.",
        ),
        { code: "daemon_unmanaged" },
      );
    if (existing.code !== "daemon_unavailable") throw new Error(JSON.stringify(existing));
  }
  // Write recovery state before selecting code, including on a failed target start. A retry of the
  // same revision retains previous, so one rollback still names the last successful predecessor.
  const next = {
    current: revision,
    previous: state.current === revision ? state.previous : state.current,
    target: context,
  };
  atomicJson(path.join(root, "deployment.json"), next);
  atomicCurrent(root, target);
  try {
    parseCliReceipt(
      await run(
        process.execPath,
        [releaseCliEntry(target), "daemon", "start", "--service", ...flags],
        target,
        process.env,
        true,
      ),
    );
    let status;
    const deadline = Date.now() + 60_000;
    for (;;) {
      status = parseCliReceipt(
        await run(process.execPath, [releaseCliEntry(target), "daemon", "status", ...flags], target, process.env, true),
      );
      if (status.build?.loadedBuildId !== revision)
        throw Object.assign(
          new Error(
            `daemon_release_mismatch: Expected installed release ${revision}, got ${JSON.stringify(status.build)}; check the service manager executable path.`,
          ),
          { code: "daemon_release_mismatch" },
        );
      const repos = Array.isArray(status.repos) ? status.repos : [];
      if (repos.some((repo) => repo.rootDir === context.workspace) && repos.every((repo) => repo.state === "attached"))
        break;
      if (repos.some((repo) => repo.state === "failed") || Date.now() >= deadline)
        throw new Error(`Repository readiness failed: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: true, command: "switch", ...next, status };
  } catch (error) {
    throw Object.assign(
      new Error(
        `Release ${revision} failed: ${error.message}. Recovery: node tools/release-installation.mjs rollback --root ${JSON.stringify(root)} --user-root ${JSON.stringify(context.userRoot)} --daemon-id ${JSON.stringify(context.daemonId)} --workspace ${JSON.stringify(context.workspace)}`,
        { cause: error },
      ),
      { code: error.code },
    );
  }
}
function readState(root) {
  const file = path.join(root, "deployment.json");
  return existsSync(file) ? readJson(file) : { current: null, previous: null, target: null };
}
function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, file);
}
function atomicCurrent(root, target) {
  const temporary = path.join(root, `.current-${process.pid}`);
  symlinkSync(target, temporary, "junction");
  renameSync(temporary, path.join(root, "current"));
}
function releaseCliEntry(release) {
  return path.join(release, "packages/cli/dist/cli/src/index.js");
}
function parseCliReceipt(result, allowFailure = false) {
  const receipt = JSON.parse(result.stdout);
  if (!allowFailure && receipt.ok !== true)
    throw Object.assign(new Error(JSON.stringify(receipt)), { code: receipt.code });
  return receipt;
}
async function run(command, args, cwd, env, allowFailure = false) {
  try {
    const operation = execute(command, args, {
      cwd,
      env,
      timeout: command === "npm" ? 600_000 : 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (command === "npm") {
      process.stderr.write(`release-installation: npm ${args.join(" ")}\n`);
      operation.child.stdout.on("data", (chunk) => process.stderr.write(chunk));
      operation.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }
    return await operation;
  } catch (error) {
    if (allowFailure && typeof error.code === "number" && error.stdout) return error;
    throw error;
  }
}
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runReleaseCommand(process.argv.slice(2))
    .then((result) => console.log(result.help ?? JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
