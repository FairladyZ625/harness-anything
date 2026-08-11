import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operationId } from "./coldstart-exhaustive-manifest.mjs";

const protectedDaemonPids = [...new Set([4919, 26328, ...discoverExistingDaemonPids()])];
const repositoryRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const cliEntry = path.join(repositoryRoot, "packages/cli/dist/cli/src/index.js");

export function createFixture(options = {}) {
  assertNode24();
  const selectedCliEntry = options.cliEntry ?? cliEntry;
  if (!existsSync(selectedCliEntry)) throw new Error(`CLI entry is missing: ${selectedCliEntry}; run npm run build -w @harness-anything/cli when using the exhaustive runner`);
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-coldstart-exhaustive-")));
  const root = makePrivateDirectory(path.join(base, "project"));
  const home = makePrivateDirectory(path.join(base, "home"));
  const daemonUserRoot = makePrivateDirectory(path.join(base, "daemon-user"));
  const xdgRuntime = makePrivateDirectory(path.join(base, "xdg-runtime"));
  const temp = makePrivateDirectory(path.join(base, "tmp"));
  const discoveryRoot = makePrivateDirectory(path.join(base, "discovery-project"));
  const discoveryHome = makePrivateDirectory(path.join(base, "discovery-home"));
  const discoveryDaemonRoot = makePrivateDirectory(path.join(base, "discovery-daemon-user"));
  assertExternal(root, daemonUserRoot);
  assertNotProtectedUserRoot(daemonUserRoot);
  const daemonId = `coldstart-exhaustive-${process.pid}-${randomUUID().slice(0, 8)}`;
  const baseEnv = isolatedEnvironment({ home, daemonUserRoot, daemonId, xdgRuntime, temp });
  const discoveryEnv = isolatedEnvironment({
    home: discoveryHome,
    daemonUserRoot: discoveryDaemonRoot,
    daemonId: `${daemonId}-discovery`,
    xdgRuntime,
    temp
  });
  return {
    base,
    root,
    home,
    daemonUserRoot,
    discoveryRoot,
    discoveryHome,
    discoveryDaemonRoot,
    daemonId,
    cliEntry: selectedCliEntry,
    baseEnv,
    discoveryEnv,
    protectedBefore: daemonFingerprints(),
    fixturePids: new Set(),
    endpoint: null
  };
}

export function runCli(fixture, args, options = {}) {
  const root = options.root ?? fixture.root;
  const env = { ...fixture.baseEnv, ...(options.env ?? {}) };
  const argv = [fixture.cliEntry ?? cliEntry, "--root", root, "--json", ...args];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  const receipt = parseJson(result.stdout);
  const record = {
    commandLine: renderCommand(root, args),
    argv: args,
    startedAt,
    exitCode: result.status,
    signal: result.signal,
    receiptOk: receipt?.ok === true,
    receiptSchema: typeof receipt?.schema === "string" ? receipt.schema : null,
    errorCode: nestedError(receipt)?.code ?? (result.error?.code ? String(result.error.code) : null),
    errorHint: nestedError(receipt)?.hint ?? result.error?.message ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt
  };
  observeDaemonIdentity(fixture, record);
  return record;
}

export function settleCliWrite(fixture, record, options = {}) {
  const receiptId = record.receipt?.settlement?.receiptId;
  if (typeof receiptId !== "string") return record;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = runCli(fixture, ["receipt", "status", receiptId]);
    const data = lastStatus.receipt?.details?.data;
    if (lastStatus.exitCode === 0 && lastStatus.receiptOk && data?.state === "committed") {
      if (data.receipt?.settlement?.canonicalVisibility !== "visible") {
        throw new Error(`Receipt ${receiptId} committed without canonical visibility`);
      }
      return {
        ...record,
        settlementReadback: {
          receiptId,
          state: data.state,
          canonicalVisibility: data.receipt.settlement.canonicalVisibility
        }
      };
    }
    if (data?.state === "failed") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`Receipt ${receiptId} did not become canonical-visible: ${lastStatus?.stdout ?? "no status receipt"}${lastStatus?.stderr ?? ""}`);
}

export function discoverCapabilities(fixture) {
  const run = (args) => runCli(fixture, args, {
    root: fixture.discoveryRoot,
    env: fixture.discoveryEnv
  });
  const indexAttempt = run(["capabilities"]);
  const index = indexAttempt.receipt;
  if (!indexAttempt.receiptOk || !Array.isArray(index?.items)) {
    throw new Error(`capability index failed: ${indexAttempt.stdout}${indexAttempt.stderr}`);
  }
  const kinds = [];
  const advertisedFailures = [];
  for (const item of index.items) {
    const advertised = run([item.kind, "capabilities"]);
    let selected = advertised;
    let spelling = "advertised";
    if (!validCapabilityReceipt(advertised, item.ops)) {
      const failure = withoutReceipt(advertised);
      if (advertised.exitCode === 0 && advertised.receiptOk) {
        failure.errorCode = "capability_dispatch_mismatch";
        failure.errorHint = `Advertised '${item.kind} capabilities' dispatched to '${String(advertised.receipt?.command ?? "unknown")}' instead of returning the ${item.kind} capability list.`;
      }
      advertisedFailures.push({
        kind: item.kind,
        declaredOps: item.ops,
        failureClass: "A",
        failureSymptom: "The advertised per-kind capability command did not return that kind's capability receipt; discovery had to use the root --kind fallback.",
        ...failure
      });
      selected = run(["capabilities", "--kind", item.kind]);
      spelling = "fallback--kind";
    }
    if (!validCapabilityReceipt(selected, item.ops)) {
      throw new Error(`capability discovery failed for ${item.kind}: ${selected.stdout}${selected.stderr}`);
    }
    kinds.push({ kind: item.kind, declaredOps: item.ops, spelling, items: selected.receipt.items });
  }
  const operations = kinds.flatMap(({ kind, items }) => items.map((item) => ({
    id: operationId(kind, item.name),
    kind,
    op: item.name,
    capability: item
  })));
  safeRemoveWithinBase(fixture, fixture.discoveryRoot);
  safeRemoveWithinBase(fixture, fixture.discoveryHome);
  safeRemoveWithinBase(fixture, fixture.discoveryDaemonRoot);
  return {
    index: index.items,
    kindCount: kinds.length,
    opCount: operations.length,
    kinds,
    operations,
    advertisedFailures
  };
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(filePath, body) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

export function receiptValue(recordOrReceipt, ...keys) {
  const receipt = recordOrReceipt?.receipt ?? recordOrReceipt;
  const wanted = new Set(keys);
  const queue = [receipt];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && (typeof child === "string" || typeof child === "number")) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return undefined;
}

export function git(fixture, ...args) {
  const result = spawnSync("git", ["-C", fixture.root, ...args], {
    encoding: "utf8",
    env: fixture.baseEnv,
    timeout: 30_000
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

export async function cleanupFixture(fixture) {
  const cleanup = {
    stopAttempts: [],
    fixturePids: [...fixture.fixturePids],
    endpoint: fixture.endpoint,
    socketResidue: [],
    baseRemoved: false,
    protectedBefore: fixture.protectedBefore,
    protectedAfter: null,
    protectedUnchanged: false,
    errors: []
  };
  const status = runCli(fixture, ["daemon", "status", "--user-root", fixture.daemonUserRoot], { timeoutMs: 20_000 });
  const livePid = daemonPid(status.receipt);
  if (livePid !== undefined) rememberFixturePid(fixture, livePid);
  const reachable = status.receipt?.reachable === true || status.receipt?.started === true;
  if (reachable && livePid !== undefined && !protectedDaemonPids.includes(livePid)) {
    const stopped = runCli(fixture, ["daemon", "stop", "--timeout-ms", "10000", "--user-root", fixture.daemonUserRoot], { timeoutMs: 20_000 });
    cleanup.stopAttempts.push(withoutReceipt(stopped));
  } else if (reachable) {
    cleanup.errors.push(`Refused cleanup stop for unresolved/protected daemon pid: ${String(livePid)}`);
  }
  await pollUntil(() => [...fixture.fixturePids].every((pid) => !processAlive(pid)), 10_000);
  const liveFixturePids = [...fixture.fixturePids].filter(processAlive);
  if (liveFixturePids.length > 0) cleanup.errors.push(`Fixture daemon still alive: ${liveFixturePids.join(",")}`);
  cleanup.socketResidue = socketResidue(fixture.endpoint);
  if (cleanup.socketResidue.length > 0 && liveFixturePids.length === 0) {
    for (const entry of cleanup.socketResidue) rmSync(entry, { recursive: true, force: true });
    cleanup.errors.push(`Canonical stop left socket residue; removed exact fixture entries: ${cleanup.socketResidue.join(", ")}`);
  }
  if (liveFixturePids.length === 0) {
    safeRemoveBase(fixture.base);
    cleanup.baseRemoved = !existsSync(fixture.base);
  }
  cleanup.protectedAfter = daemonFingerprints();
  cleanup.protectedUnchanged = JSON.stringify(cleanup.protectedAfter) === JSON.stringify(cleanup.protectedBefore);
  if (!cleanup.protectedUnchanged) cleanup.errors.push("Protected daemon fingerprints changed during the exercise.");
  if (!cleanup.baseRemoved) cleanup.errors.push(`Fixture base was not removed: ${fixture.base}`);
  return cleanup;
}

export function renderMarkdownReport(report) {
  const lines = [
    "# Cold-start exhaustive CLI exercise",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Coverage",
    "",
    "| total | passed | known issue | failed | excluded-by-design |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${report.coverage.total} | ${report.coverage.passed} | ${report.coverage.knownIssue} | ${report.coverage.failed} | ${report.coverage.excludedByDesign} |`,
    "",
    `Repeat signature: \`${report.signature}\``,
    "",
    "## Capability discovery anomalies",
    ""
  ];
  if (report.discovery.advertisedFailures.length === 0) lines.push("None.", "");
  for (const failure of report.discovery.advertisedFailures) {
    lines.push(`- \`${failure.kind}.capabilities\` [${failure.failureClass}]: exit ${failure.exitCode}; ${failure.errorCode ?? "invalid capability receipt"} — ${failure.errorHint ?? "advertised spelling did not return entity capabilities"}`);
  }
  lines.push("", "## Conclusion matrix", "");
  for (const [name, conclusion] of Object.entries(report.conclusions)) {
    lines.push(`- \`${name}\`: ${conclusion.count}${conclusion.ids.length > 0 ? ` (${conclusion.ids.join(", ")})` : ""}`);
  }
  lines.push("", "## Non-passing operations", "");
  const failed = report.results.filter((result) => !["passed", "known_issue"].includes(result.conclusion) && result.status !== "excluded-by-design");
  if (failed.length === 0) lines.push("None.", "");
  for (const result of failed) {
    lines.push(
      `### ${result.id}`,
      "",
      `- Command: \`${result.commandLine}\``,
      `- Exit: ${String(result.exitCode)}; receipt ok: ${String(result.receiptOk)}`,
      `- Conclusion: ${result.conclusion ?? "unclassified"} — ${result.detail ?? "no detail"}`,
      `- Known issue: ${result.knownIssue ?? "none"}`,
      `- Error: \`${result.errorCode ?? "none"}\` — ${result.errorHint ?? "no structured hint"}`,
      "",
      "```text",
      `${result.stdout}${result.stderr}`.trimEnd(),
      "```",
      ""
    );
  }
  lines.push("## Excluded by design", "");
  for (const result of report.results.filter((item) => item.status === "excluded-by-design")) {
    lines.push(`- \`${result.id}\`: ${result.reason}`);
  }
  lines.push("", "## Cleanup", "", `- Base removed: ${String(report.cleanup.baseRemoved)}`, `- Protected daemons unchanged: ${String(report.cleanup.protectedUnchanged)}`);
  for (const error of report.cleanup.errors) lines.push(`- ERROR: ${error}`);
  lines.push("");
  return lines.join("\n");
}

function isolatedEnvironment({ home, daemonUserRoot, daemonId, xdgRuntime, temp }) {
  return {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    HARNESS_USER_HOME: home,
    XDG_RUNTIME_DIR: xdgRuntime,
    TMPDIR: temp,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    HARNESS_ACTOR: "agent:codex",
    HARNESS_GIT_AUTHOR_NAME: "Coldstart Exhaustive",
    HARNESS_GIT_AUTHOR_EMAIL: "coldstart-exhaustive@example.invalid",
    GIT_AUTHOR_NAME: "Coldstart Exhaustive",
    GIT_AUTHOR_EMAIL: "coldstart-exhaustive@example.invalid",
    GIT_COMMITTER_NAME: "Coldstart Exhaustive",
    GIT_COMMITTER_EMAIL: "coldstart-exhaustive@example.invalid",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_PROFILE: "isolated",
    HARNESS_DAEMON_USER_ROOT: daemonUserRoot,
    HARNESS_DAEMON_ID: daemonId,
    HARNESS_BOOTSTRAP_AUTHORITY: "1",
    HARNESS_AUTHORITY_MANIFEST: "",
    HARNESS_AUTHORED_ROOT: "",
    HARNESS_DAEMON_REPO_ID: "",
    HARNESS_DIRECT_WRITE_REASON: "",
    HARNESS_CLI_TEST_FIXTURE_PRELOAD: "",
    HARNESS_DAEMON_IDLE_MS: "0",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "3600000",
    NODE_OPTIONS: "",
    CODEX_THREAD_ID: "coldstart-exhaustive-default",
    CODEX_SESSION_ID: "coldstart-exhaustive-default"
  };
}

function validCapabilityReceipt(record, declaredOps) {
  return record.exitCode === 0
    && record.receiptOk
    && record.receipt?.schema === "command-receipt/v2"
    && record.receipt?.rows === declaredOps
    && Array.isArray(record.receipt?.items)
    && record.receipt.items.length === declaredOps;
}

function observeDaemonIdentity(fixture, record) {
  const pid = daemonPid(record.receipt);
  if (pid !== undefined && /daemon-(?:start|status|restart|refresh|stop)/u.test(String(record.receipt?.command ?? ""))) {
    rememberFixturePid(fixture, pid);
  }
  const endpoint = receiptValue(record, "endpoint", "socketPath");
  if (typeof endpoint === "string" && endpoint.includes("harness-anything")) fixture.endpoint = endpoint;
}

function rememberFixturePid(fixture, pid) {
  if (protectedDaemonPids.includes(pid)) throw new Error(`Refusing to treat protected production PID ${pid} as fixture daemon`);
  fixture.fixturePids.add(pid);
}

function daemonPid(receipt) {
  if (typeof receipt?.pid === "number" && Number.isSafeInteger(receipt.pid) && receipt.pid > 0) return receipt.pid;
  if (typeof receipt?.daemonId === "string") {
    const match = /^ha-(\d+)$/u.exec(receipt.daemonId);
    if (match) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

function nestedError(receipt) {
  if (receipt?.error && typeof receipt.error === "object") return receipt.error;
  if (receipt?.details?.data?.error && typeof receipt.details.data.error === "object") return receipt.details.data.error;
  return undefined;
}

function parseJson(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function renderCommand(root, args) {
  return ["ha", "--root", root, "--json", ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

function withoutReceipt(record) {
  const { receipt: _receipt, ...rest } = record;
  return rest;
}

function makePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Fixture directory must not be a symlink: ${directory}`);
  return realpathSync(directory);
}

function assertExternal(root, daemonUserRoot) {
  if (root === daemonUserRoot || root.startsWith(`${daemonUserRoot}${path.sep}`) || daemonUserRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Daemon user root must be external to repository: ${root} <> ${daemonUserRoot}`);
  }
}

function assertNotProtectedUserRoot(candidate) {
  const hostHome = process.env.HOME ? realpathIfExists(process.env.HOME) : null;
  for (const name of [".harness", ".harness-production"]) {
    if (!hostHome) continue;
    const protectedRoot = path.join(hostHome, name);
    if (candidate === protectedRoot || candidate.startsWith(`${protectedRoot}${path.sep}`) || protectedRoot.startsWith(`${candidate}${path.sep}`)) {
      throw new Error(`Fixture daemon user root overlaps protected root: ${protectedRoot}`);
    }
  }
}

function safeRemoveWithinBase(fixture, target) {
  if (!target.startsWith(`${fixture.base}${path.sep}`)) throw new Error(`Unsafe fixture cleanup target: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

function safeRemoveBase(base) {
  const resolvedTmp = realpathSync(tmpdir());
  if (!base.startsWith(`${resolvedTmp}${path.sep}ha-coldstart-exhaustive-`)) throw new Error(`Unsafe fixture base cleanup target: ${base}`);
  rmSync(base, { recursive: true, force: true });
}

function daemonFingerprints() {
  return Object.fromEntries(protectedDaemonPids.map((pid) => {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8" });
    return [pid, result.stdout.trim()];
  }));
}

function discoverExistingDaemonPids() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return result.stdout.split("\n").flatMap((line) => {
    if (!/packages\/cli\/dist\/cli\/src\/index\.js .* daemon serve(?: |$)/u.test(line)) return [];
    const match = /^\s*(\d+)\s/u.exec(line);
    return match ? [Number.parseInt(match[1], 10)] : [];
  });
}

function socketResidue(endpoint) {
  if (!endpoint || !path.isAbsolute(endpoint)) return [];
  const parent = path.dirname(endpoint);
  if (!existsSync(parent)) return [];
  const base = path.basename(endpoint);
  return readdirSync(parent)
    .filter((entry) => entry === base || entry.startsWith(`${base}.`))
    .map((entry) => path.join(parent, entry));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

function realpathIfExists(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function assertNode24() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major !== 24) throw new Error(`Node 24 is required; received ${process.version}. Prepend /opt/homebrew/opt/node@24/bin to PATH.`);
}
