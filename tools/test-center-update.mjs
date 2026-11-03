#!/usr/bin/env node
// One pull/update attempt. Run periodically with the test host's existing scheduler; a failed
// switch remains failed until the operator rolls back. Production never invokes this updater.
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runReleaseCommand } from "./release-installation.mjs";
const execute = promisify(execFile);
export async function updateTestCenter(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string" },
      repository: { type: "string" },
      workspace: { type: "string" },
      "user-root": { type: "string" },
      "daemon-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return {
      help: "Usage: node tools/test-center-update.mjs --root <test-installation> --repository <public-main-checkout> --workspace <synthetic-ledger> --user-root <test-state> --daemon-id <id>\nRun once per scheduler tick; no token, webhook, service installation or new listener is created.",
    };
  for (const key of ["root", "repository", "workspace", "user-root", "daemon-id"])
    if (!values[key]) throw new Error(`Missing --${key}`);
  const root = path.resolve(values.root),
    repository = path.resolve(values.repository),
    lock = path.join(root, ".main-update-lock");
  mkdirSync(root, { recursive: true });
  writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  try {
    const before = await runReleaseCommand(["status", "--root", root]);
    const failure = path.join(root, "failed-update.json");
    if (existsSync(failure))
      throw new Error(
        `Previous main deployment failed; inspect ${failure}, roll back explicitly, then remove this marker before the next attempt.`,
      );
    await execute("git", ["fetch", "--no-tags", "origin", "main"], { cwd: repository });
    const { stdout } = await execute("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: repository }),
      revision = stdout.trim();
    if (before.current === revision) return { ok: true, unchanged: true, commit: revision };
    if (!existsSync(path.join(root, "versions", revision, "release.json")))
      await runReleaseCommand(["install", "--root", root, "--repository", repository, "--revision", revision]);
    const target = [
      "--root",
      root,
      "--user-root",
      values["user-root"],
      "--daemon-id",
      values["daemon-id"],
      "--workspace",
      values.workspace,
    ];
    try {
      return await runReleaseCommand(["switch", "--revision", revision, ...target]);
    } catch (error) {
      writeFileSync(
        failure,
        `${JSON.stringify({ commit: revision, previous: before.current, error: error.message, at: new Date().toISOString() }, null, 2)}\n`,
        { flag: "wx" },
      );
      throw error;
    }
  } finally {
    unlinkSync(lock);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  updateTestCenter(process.argv.slice(2))
    .then((result) => console.log(result.help ?? JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
