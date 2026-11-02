import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Only the external identity provider is synthetic. Configuration, first administrator and
// session persistence must all go through the installed CLI, never test-written daemon files.
export async function smokeIdentity(root, repoId) {
  const secret = randomBytes(24).toString("hex"),
    password = randomBytes(24).toString("hex");
  const worker = new Worker(new URL("./smoke-identity-provider.mjs", import.meta.url), {
    workerData: { secret, password, repoId },
  });
  const [url] = await once(worker, "message");
  const passwordFile = path.join(root, "administrator-password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  return {
    close: () => worker.terminate(),
    configure(userRoot) {
      const rbacRoot = path.join(userRoot, "rbac"),
        config = {
          schema: "harness-managed-rbac/v1",
          mode: "external",
          url,
          realm: "harness",
          clientId: "harness-center",
        };
      mkdirSync(rbacRoot, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(rbacRoot, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path.join(rbacRoot, "config.json"), 0o600);
      writeFileSync(path.join(rbacRoot, "center-client-secret"), secret, { mode: 0o600 });
      chmodSync(path.join(rbacRoot, "center-client-secret"), 0o600);
    },
    prepare(step) {
      const check = (args, input, code) => {
        const result = step(args, input);
        if ([secret, password].some((value) => `${result.stdout}${result.stderr}`.includes(value)))
          throw new Error("CLI exposed an identity credential");
        const ok = code
          ? result.status !== 0 && result.receipt?.code === code
          : result.status === 0 && result.receipt?.ok === true;
        if (!ok) throw new Error(`identity ${args[0]} ${args[1]} failed: ${JSON.stringify(result)}`);
      };
      const admin = [
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
      check(admin);
      check(admin, undefined, "bootstrap_admin_closed");
      check(["bootstrap", "--operation", "login"]);
    },
  };
}

export function lastReceipt(stdout) {
  // Device login emits its pending receipt before the final command receipt.
  const receipts = stdout.trim().split(/\n(?=\{)/u);
  return JSON.parse(receipts.at(-1));
}
