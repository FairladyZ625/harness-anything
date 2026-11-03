// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  managedRbacVersions,
  type ManagedPostgresBinaries,
} from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { createIdentityManagement } from "../src/authorization-provider.ts";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback port allocation failed");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function initializePostgres(initdb: string, data: string, passwordFile: string): void {
  execFileSync(
    initdb,
    [
      "-D",
      data,
      "--username=postgres",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--no-locale",
    ],
    { stdio: "pipe" },
  );
}

function startPostgres(pgCtl: string, data: string, logs: string, port: number): number {
  mkdirSync(logs, { recursive: true });
  execFileSync(
    pgCtl,
    ["-D", data, "-l", path.join(logs, "orphan-postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"],
    { stdio: "pipe", timeout: 35_000 },
  );
  return Number(readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/u)[0]);
}

function stopPostgres(pgCtl: string, data: string): void {
  if (existsSync(path.join(data, "postmaster.pid")))
    execFileSync(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "pipe", timeout: 35_000 });
}

test(
  "managed RBAC recovers a real orphaned postmaster and leaves a different data directory's server alone",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX daemon orphan and process image inspection semantics"
        : process.getuid?.() === 0
          ? "PostgreSQL initdb refuses to run as root"
          : false,
  },
  async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-rbac-postgres-orphan-integration-")),
      rbac = path.join(userRoot, "rbac"),
      data = path.join(rbac, "data", "postgres"),
      foreignData = path.join(userRoot, "foreign-postgres"),
      passwordFile = path.join(rbac, "postgres-password"),
      configFile = path.join(rbac, "config.json"),
      rbacLogs = path.join(rbac, "logs"),
      foreignLogs = path.join(userRoot, "foreign-logs");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    mkdirSync(foreignData, { recursive: true, mode: 0o700 });
    writeFileSync(passwordFile, "temporary-test-password\n", { mode: 0o600 });
    const managedPort = await freeLoopbackPort(),
      foreignPort = await freeLoopbackPort();
    writeFileSync(
      configFile,
      `${JSON.stringify({
        schema: "harness-managed-rbac/v1",
        mode: "managed",
        url: "http://127.0.0.1:1",
        realm: "harness",
        clientId: "harness-center",
        versions: managedRbacVersions,
        postgresPort: managedPort,
        managementPort: await freeLoopbackPort(),
      })}\n`,
      { mode: 0o600 },
    );

    let service: ReturnType<typeof createIdentityManagement> | undefined,
      foreignPid: number | undefined,
      orphanPid: number | undefined,
      binaries: ManagedPostgresBinaries | undefined;
    try {
      service = createIdentityManagement(userRoot, {
        spawn: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
          if (path.basename(command).startsWith("postgres")) return spawn(command, [...args], options);
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            kill: () => setImmediate(() => child.emit("exit", 0)),
          });
          setImmediate(() => child.stdout.emit("data", "Keycloak 26 started in 1s"));
          return child;
        }) as typeof spawn,
      });
      binaries = await service.ensurePostgresBinaries();
      initializePostgres(binaries.initdb, data, passwordFile);
      initializePostgres(binaries.initdb, foreignData, passwordFile);

      orphanPid = startPostgres(binaries.pgCtl, data, rbacLogs, managedPort);
      const parentPid = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(orphanPid)], { encoding: "utf8" }).trim(),
      );
      assert.notEqual(parentPid, process.pid, "pg_ctl has exited; the original PostgreSQL owner is gone");
      await service.start();
      const successorPid = Number(readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/u)[0]);
      assert.notEqual(successorPid, orphanPid, "the predecessor was stopped and managed PostgreSQL started again");
      await service.stop();

      foreignPid = startPostgres(binaries.pgCtl, foreignData, foreignLogs, foreignPort);
      writeFileSync(
        path.join(data, "postmaster.pid"),
        `${foreignPid}\n${data}\n${Date.now()}\n${managedPort}\n/var/run/postgresql\n127.0.0.1\n0\nready\n`,
        { mode: 0o600 },
      );
      await assert.rejects(service.start(), { code: "rbac_process_failed" });
      process.kill(foreignPid, 0);
      assert.equal(
        execFileSync(binaries.pgCtl, ["-D", foreignData, "status"], { encoding: "utf8" }).includes(
          `server is running (PID: ${foreignPid})`,
        ),
        true,
        "the postmaster whose working directory belongs to another data directory remains alive",
      );
    } finally {
      try {
        await service?.stop();
      } finally {
        try {
          if (
            binaries &&
            orphanPid !== undefined &&
            existsSync(path.join(data, "postmaster.pid")) &&
            Number(readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/u)[0]) === orphanPid
          )
            stopPostgres(binaries.pgCtl, data);
          if (binaries && existsSync(path.join(foreignData, "postmaster.pid")))
            stopPostgres(binaries.pgCtl, foreignData);
        } finally {
          rmSync(userRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
