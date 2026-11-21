import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Only the external identity provider is synthetic. Configuration, first administrator and
// session persistence must all go through the installed CLI, never test-written daemon files.
export async function smokeIdentity(root, repoId, options = {}) {
  const secret = randomBytes(24).toString("hex"),
    password = randomBytes(24).toString("hex");
  const worker = new Worker(new URL("./smoke-identity-provider.mjs", import.meta.url), {
    workerData: { secret, password, repoId, ...(options.tls ? { tls: options.tls } : {}) },
  });
  const close = () => worker.terminate();
  let url;
  let passwordFile;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : null;
  const controller = timeoutMs === null ? null : new AbortController();
  const timer =
    controller === null
      ? null
      : setTimeout(() => {
          controller.abort(new Error(`smoke identity provider timed out after ${timeoutMs}ms`));
        }, timeoutMs);
  timer?.unref?.();
  try {
    try {
      [url] = await once(worker, "message", controller ? { signal: controller.signal } : undefined);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    passwordFile = path.join(root, "administrator-password");
    writeFileSync(passwordFile, password, { mode: 0o600 });
  } catch (error) {
    await close();
    if (controller?.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error(`smoke identity provider timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  const adminArgs = [
    "bootstrap",
    "--operation",
    "bootstrap-admin",
    "--username",
    "owner",
    "--email",
    "owner@example.invalid",
    "--display-name",
    "Owner",
    "--person-id",
    "owner",
    "--password-file",
    passwordFile,
  ];
  const assertIdentityResult = (args, result, code) => {
    if ([secret, password].some((value) => `${result.stdout}${result.stderr}`.includes(value)))
      throw new Error("CLI exposed an identity credential");
    const ok = code
      ? result.status !== 0 && result.receipt?.code === code
      : result.status === 0 && result.receipt?.ok === true;
    if (!ok) throw new Error(`identity ${args[0]} ${args[1]} failed: ${JSON.stringify(result)}`);
  };
  return {
    url,
    close,
    configure(userRoot) {
      const rbacRoot = path.join(userRoot, "rbac"),
        config = {
          schema: "harness-managed-rbac/v1",
          mode: "external",
          url,
          realm: "harness",
          clientId: "harness-center",
          ...(options.tls?.cert ? { certificate: options.tls.cert } : {}),
        };
      mkdirSync(rbacRoot, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(rbacRoot, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path.join(rbacRoot, "config.json"), 0o600);
      writeFileSync(path.join(rbacRoot, "center-client-secret"), secret, { mode: 0o600 });
      chmodSync(path.join(rbacRoot, "center-client-secret"), 0o600);
    },
    prepare(step) {
      assertIdentityResult(adminArgs, step(adminArgs, undefined));
      assertIdentityResult(adminArgs, step(adminArgs, undefined), "bootstrap_admin_closed");
      assertIdentityResult(
        ["bootstrap", "--operation", "login"],
        step(["bootstrap", "--operation", "login"], undefined),
      );
    },
    async prepareAsync(step) {
      assertIdentityResult(adminArgs, await step(adminArgs, undefined));
      assertIdentityResult(adminArgs, await step(adminArgs, undefined), "bootstrap_admin_closed");
      const loginArgs = ["bootstrap", "--operation", "login"];
      assertIdentityResult(loginArgs, await step(loginArgs, undefined));
    },
  };
}

export function lastReceipt(stdout) {
  // Device login emits its pending receipt before the final command receipt.
  const receipts = stdout.trim().split(/\n(?=\{)/u);
  return JSON.parse(receipts.at(-1));
}
