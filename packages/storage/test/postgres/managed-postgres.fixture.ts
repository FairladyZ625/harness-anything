import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import { ManagedRbacService } from "@harness-anything/authorization-keycloak/managed-rbac-service";

export interface ManagedPostgresFixture {
  readonly adminPool: Pool;
  readonly root: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startManagedPostgresFixture(): Promise<ManagedPostgresFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-test-")),
    dataDirectory = path.join(root, "data"),
    logFile = path.join(root, "postgres.log");
  let adminPool: Pool | undefined,
    pgCtl: string | undefined,
    started = false;
  try {
    const binaries = await new ManagedRbacService(root, managedRbacTestHost()).ensurePostgresBinaries();
    pgCtl = binaries.pgCtl;
    execFileSync(
      binaries.initdb,
      ["-D", dataDirectory, "--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"],
      { encoding: "utf8" },
    );
    const port = await reserveRandomPort();
    execFileSync(
      pgCtl,
      ["-D", dataDirectory, "-l", logFile, "-o", `-h 127.0.0.1 -p ${port}`, "-w", "-t", "30", "start"],
      { encoding: "utf8" },
    );
    started = true;
    adminPool = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 1 });
    return {
      adminPool,
      root,
      port,
      async close() {
        const cleanupErrors: unknown[] = [];
        try {
          await adminPool!.end();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          execFileSync(pgCtl!, ["-D", dataDirectory, "-m", "fast", "-w", "-t", "10", "stop"], {
            encoding: "utf8",
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
        rmSync(root, { recursive: true, force: true });
        if (cleanupErrors.length > 0)
          throw new AggregateError(cleanupErrors, "Could not clean up the temporary PostgreSQL fixture.");
      },
    };
  } catch (cause) {
    const cleanupErrors: unknown[] = [];
    try {
      await adminPool?.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (started && pgCtl)
        execFileSync(pgCtl, ["-D", dataDirectory, "-m", "immediate", "-w", "-t", "10", "stop"], {
          encoding: "utf8",
        });
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(root, { recursive: true, force: true });
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `PG_TEST_NOT_EXECUTED: Could not install or start managed PostgreSQL 18.3: ${detail}` +
        (cleanupErrors.length === 0 ? "" : `; cleanup also failed: ${errorMessage(new AggregateError(cleanupErrors))}`),
      { cause },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function managedRbacTestHost() {
  const runProcessText = (command: string, args: readonly string[]) =>
    execFileSync(command, [...args], { encoding: "utf8" });
  return {
    runProcessText,
    runProcessTextAsync: async (command, args) => runProcessText(command, args),
    runProcessExitAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    validateCertificateNames: () => undefined,
    mapListenerBindError: (error) => (error instanceof Error ? error : new Error(String(error))),
  };
}

async function reserveRandomPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a temporary PostgreSQL port."));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
