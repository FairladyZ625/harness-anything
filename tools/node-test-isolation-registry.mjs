import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const NODE_TEST_ISOLATION_REGISTRY_ENV = "HARNESS_NODE_TEST_ISOLATION_REGISTRY";

export function registerCurrentTestIsolation({
  env = process.env,
  pid = process.pid,
  ppid = process.ppid,
  argv = process.argv
} = {}) {
  const registryRoot = env[NODE_TEST_ISOLATION_REGISTRY_ENV];
  if (registryRoot === undefined || env.NODE_TEST_CONTEXT !== "child-v8") return null;
  const files = argv.slice(1).filter((argument) => /\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(argument));
  if (files.length !== 1) return null;

  const record = {
    schema: "node-test-isolation/v1",
    pid,
    ppid,
    files
  };
  const recordPath = path.join(registryRoot, `${pid}.json`);
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  return recordPath;
}

export function readRegisteredTestIsolations({
  registryRoot,
  repoRoot,
  hostPid,
  selectedFiles,
  isProcessAlive = defaultProcessIsAlive
}) {
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return [];
  const selected = new Set(selectedFiles);
  let entries;
  try {
    entries = readdirSync(registryRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const candidates = [];
  const seenPids = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^\d+\.json$/u.test(entry.name)) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(registryRoot, entry.name), "utf8"));
    } catch {
      continue;
    }
    if (
      record?.schema !== "node-test-isolation/v1"
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || record.ppid !== hostPid
      || !Array.isArray(record.files)
      || record.files.length !== 1
      || seenPids.has(record.pid)
      || !isProcessAlive(record.pid)
    ) {
      continue;
    }
    const file = repositoryRelativeFile(record.files[0], repoRoot);
    if (file === null || !selected.has(file)) continue;
    seenPids.add(record.pid);
    candidates.push({ pid: record.pid, files: [file] });
  }
  return candidates;
}

function repositoryRelativeFile(file, repoRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../")) return null;
  return relative;
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
