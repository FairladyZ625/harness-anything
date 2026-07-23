import { readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { hasIsolationWedgeSignature, testFilesFromProcessCommand } from "./node-test-runner-lib.mjs";

export const STALL_REPORT_GRACE_MS = 2_000;
export const STALL_TOTAL_ABORT_GRACE_MS = 3_000;
const PROC_READ_TIMEOUT_MS = 250;
const MAX_REPORT_BYTES = 1_000_000;

export function selectStallDiagnosticTargets(members, hostPid, repoRoot, preferredPid) {
  const byPid = new Map(members.map((member) => [member.pid, member]));
  const host = byPid.get(hostPid) ?? {
    pid: hostPid,
    ppid: 0,
    command: "node --test host"
  };
  const isolationChildren = members.filter((member) =>
    member.ppid === hostPid && testFilesFromProcessCommand(member.command, repoRoot).length > 0
  );
  const wedgedMembers = members.filter((member) => hasIsolationWedgeSignature(member));
  const preferred = preferredPid === undefined ? undefined : byPid.get(preferredPid);
  const reportTarget = deepestMember(
    wedgedMembers.length > 0 ? wedgedMembers : preferred ? [preferred] : isolationChildren,
    byPid,
    hostPid
  ) ?? host;

  const roles = new Map([[host.pid, "test-host"]]);
  for (const member of isolationChildren) roles.set(member.pid, "isolation-child");
  if (!roles.has(reportTarget.pid)) roles.set(reportTarget.pid, "wedged-descendant");

  return {
    reportTarget,
    targets: [...roles].map(([pid, role]) => ({
      pid,
      role,
      command: byPid.get(pid)?.command ?? (pid === host.pid ? host.command : "unknown")
    }))
  };
}

export async function capturePreKillDiagnostics({
  members,
  hostPid,
  repoRoot,
  reportDirectory,
  preferredPid,
  platform = process.platform,
  signalProcess = process.kill.bind(process),
  writeLine = (line) => console.error(line),
  reportGraceMs = STALL_REPORT_GRACE_MS
}) {
  const { reportTarget, targets } = selectStallDiagnosticTargets(
    members,
    hostPid,
    repoRoot,
    preferredPid
  );
  const reportsBefore = await listReportFiles(reportDirectory);
  writeLine(`[node-test-stall] pre-kill diagnostics: report target pid=${reportTarget.pid}; grace=${reportGraceMs}ms`);

  const procSnapshots = platform === "linux"
    ? Promise.all(targets.map((target) => readLinuxProcessSnapshot(target)))
    : Promise.resolve([
      `[node-test-stall] /proc diagnostics unavailable on platform ${platform}; target pids=${targets.map(({ pid }) => pid).join(",")}`
    ]);

  try {
    signalProcess(reportTarget.pid, "SIGUSR2");
    writeLine(`[node-test-stall] sent SIGUSR2 to pid=${reportTarget.pid}`);
  } catch (error) {
    writeLine(`[node-test-stall] unable to signal pid=${reportTarget.pid}: ${errorMessage(error)}`);
  }

  await new Promise((resolveDelay) => setTimeout(resolveDelay, reportGraceMs));
  for (const snapshot of await procSnapshots) writeLine(snapshot);

  const reportsAfter = await listReportFiles(reportDirectory);
  const newReports = reportsAfter.filter((file) => !reportsBefore.includes(file));
  if (newReports.length === 0) {
    writeLine(
      `[node-test-stall] diagnostic report: no new file within ${reportGraceMs}ms; a blocked main thread may be unable to service SIGUSR2`
    );
    return;
  }
  for (const file of newReports) {
    const absolute = path.join(reportDirectory, file);
    writeLine(`[node-test-stall] diagnostic report file: ${absolute}`);
    writeLine(await readDiagnosticReport(absolute));
  }
}

export async function readLinuxProcessSnapshot({ pid, role, command }) {
  const root = `/proc/${pid}`;
  const [status, wchan, stack, descriptors] = await Promise.all([
    safeReadText(path.join(root, "status")),
    safeReadText(path.join(root, "wchan")),
    safeReadText(path.join(root, "stack")),
    readFileDescriptors(path.join(root, "fd"))
  ]);
  return [
    `[node-test-stall] /proc snapshot pid=${pid} role=${role} command=${command}`,
    `[node-test-stall] /proc/${pid}/status:\n${status}`,
    `[node-test-stall] /proc/${pid}/wchan:\n${wchan}`,
    `[node-test-stall] /proc/${pid}/stack:\n${stack}`,
    `[node-test-stall] /proc/${pid}/fd:\n${descriptors}`
  ].join("\n");
}

function deepestMember(members, byPid, hostPid) {
  let selected;
  let selectedDepth = -1;
  for (const member of members) {
    const depth = processDepth(member, byPid, hostPid);
    if (depth > selectedDepth) {
      selected = member;
      selectedDepth = depth;
    }
  }
  return selected;
}

function processDepth(member, byPid, hostPid) {
  let depth = 0;
  let cursor = member;
  const seen = new Set();
  while (cursor.pid !== hostPid && !seen.has(cursor.pid)) {
    seen.add(cursor.pid);
    const parent = byPid.get(cursor.ppid);
    if (parent === undefined) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

async function readFileDescriptors(directory) {
  let entries;
  try {
    entries = await withTimeout(readdir(directory), PROC_READ_TIMEOUT_MS);
  } catch (error) {
    return `<unavailable: ${errorMessage(error)}>`;
  }
  const descriptors = await Promise.all(entries
    .sort((left, right) => Number(left) - Number(right))
    .map(async (entry) => {
      try {
        return `${entry} -> ${await withTimeout(readlink(path.join(directory, entry)), PROC_READ_TIMEOUT_MS)}`;
      } catch (error) {
        return `${entry} -> <unavailable: ${errorMessage(error)}>`;
      }
    }));
  return descriptors.length > 0 ? descriptors.join("\n") : "<none>";
}

async function safeReadText(file) {
  try {
    return (await withTimeout(readFile(file, "utf8"), PROC_READ_TIMEOUT_MS)).trimEnd();
  } catch (error) {
    return `<unavailable: ${errorMessage(error)}>`;
  }
}

async function listReportFiles(directory) {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readDiagnosticReport(file) {
  try {
    const { size } = await stat(file);
    const content = await readFile(file, "utf8");
    if (size <= MAX_REPORT_BYTES) return content;
    return `${content.slice(0, MAX_REPORT_BYTES)}\n[node-test-stall] diagnostic report truncated after ${MAX_REPORT_BYTES} bytes`;
  } catch (error) {
    return `[node-test-stall] unable to read diagnostic report: ${errorMessage(error)}`;
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`read timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    })
  ]);
}

function errorMessage(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}
