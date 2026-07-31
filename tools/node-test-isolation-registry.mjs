import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const NODE_TEST_ISOLATION_REGISTRY_ENV = "HARNESS_NODE_TEST_ISOLATION_REGISTRY";
export const NODE_TEST_ISOLATION_BROKER_PORT_ENV = "HARNESS_NODE_TEST_ISOLATION_BROKER_PORT";
export const NODE_TEST_ISOLATION_BROKER_SECRET_ENV = "HARNESS_NODE_TEST_ISOLATION_BROKER_SECRET";
const IDENTITY_HANDSHAKE_TIMEOUT_MS = 1_000;

export function shouldUseNodeTestIsolationRegistry({
  platform = process.platform,
  fixtureMode,
  fixtureFiles = []
} = {}) {
  return platform === "win32"
    || (typeof fixtureMode === "string" && fixtureMode.length > 0 && fixtureFiles.length > 0);
}

export async function createNodeTestIsolationIdentityBroker() {
  const secret = `${randomUUID()}${randomUUID()}`;
  const identities = new Map();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.unref();
    let input = "";
    const deadline = setTimeout(() => socket.destroy(), IDENTITY_HANDSHAKE_TIMEOUT_MS);
    deadline.unref?.();
    const removeSocket = () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      for (const [token, entry] of identities) {
        if (entry.socket === socket) identities.delete(token);
      }
    };
    socket.once("close", removeSocket);
    socket.once("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 1_024) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      socket.removeAllListeners("data");
      let hello;
      try {
        hello = JSON.parse(input.slice(0, newline));
      } catch {
        socket.destroy();
        return;
      }
      if (!validBrokerHello(hello, secret)) {
        socket.destroy();
        return;
      }
      const previous = identities.get(hello.token);
      previous?.socket.destroy();
      identities.set(hello.token, {
        pid: hello.pid,
        ppid: hello.ppid,
        socket
      });
      clearTimeout(deadline);
      socket.write("ok\n");
    });
  });
  try {
    await listenOnLoopback(server);
  } catch (error) {
    closeServer(server);
    throw error;
  }
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") {
    closeServer(server);
    throw new Error("test isolation identity broker did not bind a TCP port");
  }

  return {
    environment: {
      [NODE_TEST_ISOLATION_BROKER_PORT_ENV]: String(address.port),
      [NODE_TEST_ISOLATION_BROKER_SECRET_ENV]: secret
    },
    matches(candidate) {
      const entry = identities.get(candidate?.identity?.token);
      return entry !== undefined
        && entry.pid === candidate.pid
        && entry.ppid === candidate.ppid
        && !entry.socket.destroyed;
    },
    dispose() {
      for (const socket of sockets) socket.destroy();
      identities.clear();
      closeServer(server);
    }
  };
}

export async function registerCurrentTestIsolation({
  env = process.env,
  pid = process.pid,
  ppid = process.ppid,
  argv = process.argv
} = {}) {
  const registryRoot = env[NODE_TEST_ISOLATION_REGISTRY_ENV];
  const brokerPort = parsePort(env[NODE_TEST_ISOLATION_BROKER_PORT_ENV]);
  const brokerSecret = env[NODE_TEST_ISOLATION_BROKER_SECRET_ENV];
  if (
    registryRoot === undefined
    || brokerPort === null
    || typeof brokerSecret !== "string"
    || brokerSecret.length === 0
    || env.NODE_TEST_CONTEXT !== "child-v8"
  ) {
    return null;
  }
  const files = argv.slice(1).filter((argument) => /\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(argument));
  if (files.length !== 1) return null;

  const identity = { token: randomUUID() };
  let identityConnection;
  let record;
  let recordPath;
  try {
    identityConnection = await connectToIdentityBroker({
      port: brokerPort,
      secret: brokerSecret,
      token: identity.token,
      pid,
      ppid
    });
    record = {
      schema: "node-test-isolation/v1",
      pid,
      ppid,
      files,
      identity
    };
    recordPath = path.join(registryRoot, `${pid}.json`);
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "w" });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      removeOwnedRecord(recordPath, record.identity.token);
      identityConnection.close();
    };
    return { recordPath, record, dispose };
  } catch {
    if (recordPath !== undefined && record !== undefined) {
      removeOwnedRecord(recordPath, record.identity.token);
    }
    identityConnection?.close();
    return null;
  }
}

export async function readRegisteredTestIsolations({
  registryRoot,
  repoRoot,
  hostPid,
  selectedFiles,
  isProcessAlive = defaultProcessIsAlive,
  probeIdentity
}) {
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || typeof probeIdentity !== "function") return [];
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
      || !validIdentity(record.identity)
      || seenPids.has(record.pid)
      || !isProcessAlive(record.pid)
    ) {
      continue;
    }
    const file = repositoryRelativeFile(record.files[0], repoRoot);
    if (file === null || !selected.has(file)) continue;
    const candidate = {
      pid: record.pid,
      ppid: record.ppid,
      files: [file],
      identity: record.identity
    };
    if (!await registeredTestIsolationIdentityMatches(candidate, { probeIdentity })) continue;
    seenPids.add(record.pid);
    candidates.push(candidate);
  }
  return candidates;
}

export async function registeredTestIsolationIdentityMatches(candidate, { probeIdentity } = {}) {
  if (!validIdentity(candidate?.identity) || typeof probeIdentity !== "function") return false;
  try {
    return await probeIdentity(candidate);
  } catch {
    return false;
  }
}

function connectToIdentityBroker({ port, secret, token, pid, ppid }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      if (error !== undefined) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.on("error", () => socket.destroy());
      socket.unref();
      resolve({ close: () => socket.destroy() });
    };
    const deadline = setTimeout(() => {
      finish(new Error("test isolation identity broker handshake timed out"));
    }, IDENTITY_HANDSHAKE_TIMEOUT_MS);
    deadline.unref?.();
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ secret, token, pid, ppid })}\n`);
    });
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response === "ok\n") finish();
      else if (response.length >= 3) finish(new Error("test isolation identity broker rejected registration"));
    });
  });
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      server.on("error", () => undefined);
      resolve();
    });
  });
}

function validBrokerHello(hello, secret) {
  return hello?.secret === secret
    && validIdentity({ token: hello.token })
    && Number.isSafeInteger(hello.pid)
    && hello.pid > 0
    && Number.isSafeInteger(hello.ppid)
    && hello.ppid > 0;
}

function removeOwnedRecord(recordPath, identityToken) {
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (record?.identity?.token === identityToken) unlinkSync(recordPath);
  } catch {
    // Registration is diagnostic evidence and never owns test correctness.
  }
}

function closeServer(server) {
  try {
    server.close();
  } catch {
    // Identity evidence is best-effort and must not affect the test process.
  }
}

function validIdentity(identity) {
  return identity !== null
    && typeof identity === "object"
    && typeof identity.token === "string"
    && /^[0-9a-f-]{36}$/u.test(identity.token);
}

function parsePort(value) {
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : null;
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
