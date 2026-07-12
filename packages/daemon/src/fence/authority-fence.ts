import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  AuthorityFenceLostError,
  AuthorityFenceUnavailableError,
  type AuthorityFenceLease,
  type SingleHostAuthorityFenceOptions
} from "./types.ts";

interface FenceFileIdentity {
  readonly device: string;
  readonly inode: string;
}

interface FenceEnrollment {
  readonly schema: "authority-fence-enrollment/v1";
  readonly instanceId: string;
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly identity: FenceFileIdentity;
}

export async function acquireSingleHostAuthorityFence(
  options: SingleHostAuthorityFenceOptions
): Promise<AuthorityFenceLease> {
  validateOptions(options);
  const server = createServer();
  try {
    await listenForFence(server, options);
  } catch (error) {
    server.close();
    throw new AuthorityFenceUnavailableError(
      `authority fence endpoint ${options.endpoint.host}:${options.endpoint.port} is already held`,
      { cause: error }
    );
  }

  let handle: FileHandle | undefined;
  try {
    const directory = path.dirname(options.enrollmentPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertEnrollmentIsReplaceable(options);
    await rm(options.enrollmentPath, { force: true });
    handle = await open(options.enrollmentPath, "wx+", 0o600);
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    const enrollment: FenceEnrollment = {
      schema: "authority-fence-enrollment/v1",
      instanceId: options.instanceId,
      endpoint: options.endpoint,
      identity
    };
    await handle.writeFile(`${JSON.stringify(enrollment)}\n`, "utf8");
    await handle.sync();
    await syncFenceDirectory(directory);
    return makeFenceLease(options, enrollment, server, handle);
  } catch (error) {
    await handle?.close();
    await closeFenceServer(server);
    throw new AuthorityFenceUnavailableError("authority fence enrollment failed", { cause: error });
  }
}

function makeFenceLease(
  options: SingleHostAuthorityFenceOptions,
  enrollment: FenceEnrollment,
  server: Server,
  handle: FileHandle
): AuthorityFenceLease {
  let state: "held" | "lost" | "released" = "held";
  const lose = async (message: string, cause?: unknown): Promise<never> => {
    state = "lost";
    await closeFenceServer(server);
    throw new AuthorityFenceLostError(message, { cause });
  };
  return {
    instanceId: options.instanceId,
    assertHeld: async () => {
      if (state !== "held") throw new AuthorityFenceLostError(`authority fence is ${state}`);
      if (!server.listening) return lose("authority fence kernel anchor is no longer held");
      try {
        const [heldStatus, pathStatus, body] = await Promise.all([
          handle.stat({ bigint: true }),
          stat(options.enrollmentPath, { bigint: true }),
          readFile(options.enrollmentPath, "utf8")
        ]);
        const heldIdentity = fileIdentity(heldStatus);
        const pathIdentity = fileIdentity(pathStatus);
        const fresh = JSON.parse(body) as FenceEnrollment;
        if (!sameFenceIdentity(heldIdentity, enrollment.identity)
          || !sameFenceIdentity(pathIdentity, enrollment.identity)
          || fresh.schema !== enrollment.schema
          || fresh.instanceId !== enrollment.instanceId
          || fresh.endpoint?.host !== enrollment.endpoint.host
          || fresh.endpoint?.port !== enrollment.endpoint.port
          || !sameFenceIdentity(fresh.identity, enrollment.identity)) {
          return lose("authority fence enrollment identity changed");
        }
      } catch (error) {
        if (error instanceof AuthorityFenceLostError) throw error;
        return lose("authority fence enrollment cannot be validated", error);
      }
    },
    release: async () => {
      if (state === "released") return;
      state = "released";
      await closeFenceServer(server);
      await handle.close();
      try {
        const current = fileIdentity(await stat(options.enrollmentPath, { bigint: true }));
        if (sameFenceIdentity(current, enrollment.identity)) {
          await rm(options.enrollmentPath, { force: true });
          await syncFenceDirectory(path.dirname(options.enrollmentPath));
        }
      } catch {
        // A missing or replaced enrollment is never removed by the old holder.
      }
    }
  };
}

function validateOptions(options: SingleHostAuthorityFenceOptions): void {
  if (options.instanceId.trim() === "") throw new TypeError("authority fence instanceId must not be empty");
  if (options.endpoint.host !== "127.0.0.1" && options.endpoint.host !== "::1") {
    throw new TypeError("authority fence endpoint must be loopback-only");
  }
  if (!Number.isInteger(options.endpoint.port) || options.endpoint.port < 1 || options.endpoint.port > 65_535) {
    throw new TypeError("authority fence port must be an integer from 1 through 65535");
  }
}

async function assertEnrollmentIsReplaceable(options: SingleHostAuthorityFenceOptions): Promise<void> {
  let body: string;
  try {
    body = await readFile(options.enrollmentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const currentIdentity = fileIdentity(await stat(options.enrollmentPath, { bigint: true }));
  let enrollment: FenceEnrollment;
  try {
    enrollment = JSON.parse(body) as FenceEnrollment;
  } catch (error) {
    throw new AuthorityFenceUnavailableError("existing authority fence enrollment is malformed", { cause: error });
  }
  if (enrollment.schema !== "authority-fence-enrollment/v1"
    || enrollment.endpoint?.host !== options.endpoint.host
    || enrollment.endpoint?.port !== options.endpoint.port
    || !sameFenceIdentity(enrollment.identity, currentIdentity)) {
    throw new AuthorityFenceUnavailableError(
      "existing authority fence enrollment does not match this exact endpoint and file identity"
    );
  }
}

function listenForFence(server: Server, options: SingleHostAuthorityFenceOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ ...options.endpoint, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeFenceServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function fileIdentity(status: { readonly dev: bigint; readonly ino: bigint }): FenceFileIdentity {
  return { device: status.dev.toString(), inode: status.ino.toString() };
}

function sameFenceIdentity(left: FenceFileIdentity, right: FenceFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function syncFenceDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
