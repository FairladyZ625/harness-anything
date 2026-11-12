// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { createIdentityManagement } from "../src/authorization-provider.ts";

test(
  "startup reaps a same-rbacRoot java orphan and stop releases its kc.sh child tree",
  {
    skip: process.platform === "win32" ? "requires POSIX process identity and signal semantics" : false,
    timeout: 90_000,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-keycloak-orphan-")),
      [httpPort, managementPort] = await availablePorts(2),
      managed = prepareInstallation(path.join(parent, "managed-user"), httpPort!, managementPort!);
    compileFakeJava(managed.java);
    const managedService = createService(managed, true);
    let orphan: LaunchedFixture | undefined;
    try {
      orphan = await launchOrphan(managed);
      const orphanPid = orphan.pid;
      await managedService.service.start();
      assert.equal(
        orphan.closed,
        true,
        "the old kc.sh launcher exited while its Java child held both ports; startup must reap that child",
      );
      const successorPid = Number(readFileSync(managed.pidFile, "utf8"));
      assert.notEqual(successorPid, orphanPid, "a new managed Keycloak process owns the recovered listener");

      await managedService.service.stop();
      assert.equal(await canConnect(httpPort!), false, "stop releases the Keycloak HTTP port after the shell exits");
      assert.equal(
        await canConnect(managementPort!),
        false,
        "stop releases the management port held by the kc.sh child process",
      );
    } finally {
      await stopManagedService(managedService, managed.pidFile);
      await terminateFixture(orphan);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "startup refuses a foreign Keycloak listener without signaling it",
  {
    skip: process.platform === "win32" ? "requires POSIX process identity and signal semantics" : false,
    timeout: 90_000,
  },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-keycloak-foreign-")),
      [httpPort, managementPort] = await availablePorts(2),
      managed = prepareInstallation(path.join(parent, "managed-user"), httpPort!, managementPort!),
      foreign = prepareInstallation(path.join(parent, "foreign-user"), httpPort!, managementPort!);
    compileFakeJava(managed.java);
    compileFakeJava(foreign.java);
    const blockedService = createService(managed, false);
    let foreignOwner: LaunchedFixture | undefined;
    try {
      foreignOwner = await launchOrphan(foreign);
      await assert.rejects(blockedService.service.start(), (error: unknown) => {
        const failure = error as { readonly code?: string; readonly message?: string };
        assert.equal(failure.code, "rbac_port_in_use");
        assert.match(failure.message ?? "", new RegExp(String(httpPort), "u"));
        return true;
      });
      process.kill(foreignOwner.pid, 0);
      assert.equal(await canConnect(httpPort!), true, "a listener outside this rbacRoot remains alive");
      assert.equal(foreignOwner.closed, false);
    } finally {
      await blockedService.service.stop();
      await terminateFixture(foreignOwner);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

interface Installation {
  readonly userRoot: string;
  readonly root: string;
  readonly java: string;
  readonly launcher: string;
  readonly pidFile: string;
  readonly httpPort: number;
  readonly managementPort: number;
}

interface LaunchedFixture {
  readonly process: ChildProcess;
  readonly pid: number;
  readonly closed: boolean;
  readonly waitClosed: Promise<void>;
}

interface ManagedServiceFixture {
  readonly service: ReturnType<typeof createIdentityManagement>;
  readonly children: readonly {
    readonly process: ChildProcess;
    readonly waitClosed: Promise<void>;
    readonly closed: boolean;
  }[];
}

const fakeJavaSource = String.raw`
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int listen_on(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0), reuse = 1;
  struct sockaddr_in address = {0};
  if (fd < 0) return -1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((unsigned short)port);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, 8) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

int main(int argc, char **argv) {
  if (argc < 5) return 2;
  int http = listen_on(atoi(argv[1]));
  int management = listen_on(atoi(argv[2]));
  if (http < 0 || management < 0) return 3;
  FILE *pid_file = fopen(argv[3], "w");
  if (!pid_file) return 4;
  fprintf(pid_file, "%ld\n", (long)getpid());
  fclose(pid_file);
  printf("Keycloak 26 started in 1s\n");
  fflush(stdout);
  for (;;) pause();
}
`;

function prepareInstallation(userRoot: string, httpPort: number, managementPort: number): Installation {
  const root = path.join(userRoot, "rbac"),
    java = path.join(root, "runtime", "java", "bin", "java"),
    launcher = path.join(root, "runtime", "keycloak", "bin", "kc.sh"),
    pidFile = path.join(root, "runtime", "keycloak", "fixture.pid"),
    postgres = path.join(root, "runtime", "postgres", "bin", "postgres");
  mkdirSync(path.dirname(java), { recursive: true });
  mkdirSync(path.dirname(launcher), { recursive: true });
  mkdirSync(path.dirname(postgres), { recursive: true });
  writeFileSync(postgres, "fixture");
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: `http://127.0.0.1:${httpPort}`,
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      postgresPort: 1,
      managementPort,
    })}\n`,
  );
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      'if [ "${KC_ORPHAN_CHILD:-}" = "1" ]; then',
      '  "$JAVA_HOME/bin/java" "$KC_HTTP_PORT" "$KC_HTTP_MANAGEMENT_PORT" "$KC_PID_FILE" "-Dkc.home.dir=$PWD" &',
      "  exit 0",
      "fi",
      'if [ "${KC_WAIT_CHILD:-}" = "1" ]; then',
      '  "$JAVA_HOME/bin/java" "$KC_HTTP_PORT" "$KC_HTTP_MANAGEMENT_PORT" "$KC_PID_FILE" "-Dkc.home.dir=$PWD" &',
      "  child=$!",
      '  wait "$child"',
      "  exit $?",
      "fi",
      'exec "$JAVA_HOME/bin/java" "$KC_HTTP_PORT" "$KC_HTTP_MANAGEMENT_PORT" "$KC_PID_FILE" "-Dkc.home.dir=$PWD"',
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  return { userRoot, root, java, launcher, pidFile, httpPort, managementPort };
}

function compileFakeJava(binary: string): void {
  execFileSync("cc", ["-O2", "-x", "c", "-o", binary, "-"], { input: fakeJavaSource, stdio: ["pipe", "pipe", "pipe"] });
}

function createService(installation: Installation, waitForChild: boolean): ManagedServiceFixture {
  const children: { process: ChildProcess; waitClosed: Promise<void>; closed: boolean }[] = [],
    service = createIdentityManagement(installation.userRoot, {
      spawn: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        if (path.basename(command).startsWith("postgres")) return readyPostgresChild();
        const child = spawn(command, [...args], {
          ...options,
          env: {
            ...options?.env,
            KC_PID_FILE: installation.pidFile,
            ...(waitForChild ? { KC_WAIT_CHILD: "1" } : {}),
          },
        });
        const state = { closed: false },
          waitClosed = onceClosed(child, state);
        children.push({
          process: child,
          get closed() {
            return state.closed;
          },
          waitClosed,
        });
        return child;
      }) as typeof spawn,
    });
  return { service, children };
}

function readyPostgresChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (signal?: NodeJS.Signals) => {
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("exit", 0, signal ?? null);
      });
      return true;
    },
  });
  setImmediate(() => child.stdout.emit("data", "database system is ready to accept connections"));
  return child as unknown as ChildProcess;
}

async function launchOrphan(installation: Installation): Promise<LaunchedFixture> {
  const launcherProcess = spawn(installation.launcher, [], {
      cwd: path.dirname(path.dirname(installation.launcher)),
      env: {
        ...globalThis.process.env,
        JAVA_HOME: path.dirname(path.dirname(installation.java)),
        KC_HTTP_PORT: String(installation.httpPort),
        KC_HTTP_MANAGEMENT_PORT: String(installation.managementPort),
        KC_PID_FILE: installation.pidFile,
        KC_ORPHAN_CHILD: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    ready = new Promise<void>((resolve, reject) => {
      launcherProcess.stdout?.on("data", (chunk: Buffer | string) => {
        if (/Keycloak .* started in/u.test(chunk.toString())) resolve();
      });
      launcherProcess.once("error", reject);
    }),
    exited = new Promise<void>((resolve) => launcherProcess.once("exit", () => resolve()));
  let closed = false;
  const waitClosed = new Promise<void>((resolve) =>
    launcherProcess.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  await Promise.all([ready, exited]);
  return {
    process: launcherProcess,
    pid: Number(readFileSync(installation.pidFile, "utf8")),
    get closed() {
      return closed;
    },
    waitClosed,
  };
}

async function availablePorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [],
    ports: number[] = [];
  try {
    while (ports.length < count) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("loopback port allocation failed");
      if (!ports.includes(address.port)) {
        ports.push(address.port);
        servers.push(server);
      } else {
        await closeServer(server);
      }
    }
  } finally {
    await Promise.all(servers.map(closeServer));
  }
  return ports;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function terminateFixture(fixture: LaunchedFixture | undefined): Promise<void> {
  if (!fixture || fixture.closed) return;
  try {
    process.kill(fixture.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await fixture.waitClosed;
}

async function stopManagedService(fixture: ManagedServiceFixture, pidFile: string): Promise<void> {
  await fixture.service.stop();
  if (fixture.children.some(({ closed }) => !closed)) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
  await Promise.all(fixture.children.map(({ waitClosed }) => waitClosed));
}

function onceClosed(child: ChildProcess, state: { closed: boolean }): Promise<void> {
  return new Promise((resolve) =>
    child.once("close", () => {
      state.closed = true;
      resolve();
    }),
  );
}
