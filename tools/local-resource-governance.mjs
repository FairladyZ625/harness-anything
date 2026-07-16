import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

export const DEFAULT_LOCAL_SLOTS = 3;
export const DEFAULT_LOCAL_TEST_CONCURRENCY = 2;
export const LOCAL_SLOT_ROOT = path.join(homedir(), ".harness", "locks", "local-heavy-v1");

const OWNER_FILE = "owner.json";
const REAPER_DIR = ".reaper";
const SLOT_PATH_ENV = "HARNESS_LOCAL_SLOT_PATH";
const SLOT_TOKEN_ENV = "HARNESS_LOCAL_SLOT_TOKEN";
const INITIALIZATION_GRACE_MS = 30_000;

export function resolveLocalSlotCount(raw = process.env.HARNESS_LOCAL_SLOTS) {
  if (raw === undefined || raw === "") return DEFAULT_LOCAL_SLOTS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`HARNESS_LOCAL_SLOTS must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function selectQosPrefix({ platform, hasTaskpolicy, hasNice }) {
  if (platform === "darwin" && hasTaskpolicy) return ["taskpolicy", "-c", "utility"];
  if (hasNice) return ["nice", "-n", "10"];
  return [];
}

export function discoverQosPrefix({
  platform = process.platform,
  commandExists = binaryExists,
  isCi = Boolean(process.env.CI)
} = {}) {
  if (isCi || platform === "win32") return [];
  return selectQosPrefix({
    platform,
    hasTaskpolicy: platform === "darwin" && commandExists("taskpolicy"),
    hasNice: commandExists("nice")
  });
}

export function prefixCommand(prefix, command, args = []) {
  const argv = [...prefix, command, ...args];
  return { command: argv[0], args: argv.slice(1) };
}

export function processStartFingerprint(pid, run = spawnSync) {
  const result = run("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  const fingerprint = result.stdout?.trim();
  return fingerprint ? fingerprint : null;
}

export async function acquireLocalHeavySlot(options = {}) {
  const root = path.resolve(options.root ?? LOCAL_SLOT_ROOT);
  const env = options.env ?? process.env;
  const slots = options.slots ?? resolveLocalSlotCount(env.HARNESS_LOCAL_SLOTS);
  const label = options.label ?? "local-heavy-operation";
  const pollMs = options.pollMs ?? 500;
  const initializationGraceMs = options.initializationGraceMs ?? INITIALIZATION_GRACE_MS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const getFingerprint = options.processFingerprint ?? processStartFingerprint;
  const machine = options.hostname ?? hostname();
  const pid = options.pid ?? process.pid;

  if (!Number.isSafeInteger(slots) || slots <= 0) throw new Error("local slot count must be a positive integer");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const inherited = readInheritedLease({ root, env });
  if (inherited !== null) return inherited;

  let announcedWait = false;
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      const slotPath = path.join(root, `slot-${index}`);
      const lease = tryCreateLease({ slotPath, root, env, label, machine, pid, now, getFingerprint });
      if (lease !== null) return lease;

      const reaped = reapSlotIfStale({
        slotPath,
        machine,
        now,
        processAlive,
        getFingerprint,
        initializationGraceMs
      });
      if (reaped) index -= 1;
    }

    if (!announcedWait) {
      console.error(`[local-qos] ${slots} heavy-operation slots are occupied; ${label} is waiting.`);
      announcedWait = true;
    }
    const jitterMs = Math.floor(Math.max(1, pollMs) * 0.25 * random());
    await sleep(Math.max(1, pollMs) + jitterMs);
  }
}

export async function withLocalHeavySlot(options, action) {
  const lease = await acquireLocalHeavySlot(options);
  const removeSignalHandlers = installSignalCleanup(lease);
  try {
    return await action(lease);
  } finally {
    removeSignalHandlers();
    lease.release();
  }
}

function tryCreateLease({ slotPath, root, env, label, machine, pid, now, getFingerprint }) {
  try {
    mkdirSync(slotPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }

  const token = randomUUID();
  const owner = {
    schema: "harness-local-heavy-owner/v1",
    token,
    hostname: machine,
    pid,
    processStart: getFingerprint(pid),
    acquiredAt: new Date(now()).toISOString(),
    label
  };
  try {
    writeOwnerAtomically(slotPath, owner, token);
  } catch (error) {
    rmSync(slotPath, { recursive: true, force: true });
    throw error;
  }

  return createLease({ slotPath, root, token, env, inherited: false });
}

function createLease({ slotPath, root, token, env, inherited }) {
  let released = false;
  return {
    slotPath,
    token,
    inherited,
    childEnv: { ...env, [SLOT_PATH_ENV]: slotPath, [SLOT_TOKEN_ENV]: token },
    release() {
      if (released || inherited) return;
      released = true;
      const owner = readOwner(slotPath);
      if (owner?.token === token && path.dirname(slotPath) === root) {
        rmSync(slotPath, { recursive: true, force: true });
      }
    }
  };
}

function readInheritedLease({ root, env }) {
  const slotPathValue = env[SLOT_PATH_ENV];
  const token = env[SLOT_TOKEN_ENV];
  if (!slotPathValue || !token) return null;
  const slotPath = path.resolve(slotPathValue);
  if (path.dirname(slotPath) !== root) return null;
  const owner = readOwner(slotPath);
  if (owner?.token !== token) return null;
  return createLease({ slotPath, root, token, env, inherited: true });
}

function reapSlotIfStale({ slotPath, machine, now, processAlive, getFingerprint, initializationGraceMs }) {
  const observation = observeStaleness({
    slotPath,
    machine,
    now,
    processAlive,
    getFingerprint,
    initializationGraceMs
  });
  if (!observation.stale) return false;

  const reaperPath = path.join(slotPath, REAPER_DIR);
  try {
    mkdirSync(reaperPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOENT") return false;
    throw error;
  }

  const confirmed = observation.token === null && readOwner(slotPath) === null
    ? { stale: true, token: null }
    : observeStaleness({
        slotPath,
        machine,
        now,
        processAlive,
        getFingerprint,
        initializationGraceMs
      });
  if (confirmed.stale && confirmed.token === observation.token) {
    rmSync(slotPath, { recursive: true, force: true });
    return true;
  }
  rmSync(reaperPath, { recursive: true, force: true });
  return false;
}

function observeStaleness({ slotPath, machine, now, processAlive, getFingerprint, initializationGraceMs }) {
  const owner = readOwner(slotPath);
  if (owner === null) {
    try {
      return { stale: now() - statSync(slotPath).mtimeMs >= initializationGraceMs, token: null };
    } catch {
      return { stale: false, token: null };
    }
  }
  if (!isValidOwner(owner)) {
    return { stale: slotPastInitializationGrace(slotPath, now, initializationGraceMs), token: owner.token ?? null };
  }
  if (owner.hostname !== machine) return { stale: false, token: owner.token };
  if (!processAlive(owner.pid)) return { stale: true, token: owner.token };
  if (owner.processStart === null) return { stale: false, token: owner.token };
  const currentFingerprint = getFingerprint(owner.pid);
  if (currentFingerprint === null) return { stale: false, token: owner.token };
  return { stale: currentFingerprint !== owner.processStart, token: owner.token };
}

function slotPastInitializationGrace(slotPath, now, initializationGraceMs) {
  try {
    return now() - statSync(slotPath).mtimeMs >= initializationGraceMs;
  } catch {
    return false;
  }
}

function isValidOwner(owner) {
  return owner?.schema === "harness-local-heavy-owner/v1" &&
    typeof owner.token === "string" && owner.token.length > 0 &&
    typeof owner.hostname === "string" &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    (typeof owner.processStart === "string" || owner.processStart === null);
}

function writeOwnerAtomically(slotPath, owner, token) {
  const temporaryPath = path.join(slotPath, `.${OWNER_FILE}.${token}.tmp`);
  const ownerPath = path.join(slotPath, OWNER_FILE);
  writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, ownerPath);
}

function readOwner(slotPath) {
  try {
    return JSON.parse(readFileSync(path.join(slotPath, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function binaryExists(name) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return pathEntries.some((entry) => extensions.some((extension) => {
    const candidate = path.join(entry, `${name}${extension}`);
    if (!existsSync(candidate)) return false;
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installSignalCleanup(lease) {
  if (lease.inherited) return () => {};
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      lease.release();
      remove();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  const remove = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  return remove;
}
