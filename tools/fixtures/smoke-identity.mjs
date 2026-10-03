import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
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
      const external = [
        "bootstrap",
        "--mode",
        "external",
        "--url",
        url,
        "--realm",
        "harness",
        "--client-id",
        "harness-center",
        "--client-secret-stdin",
      ];
      check(external, "invalid-candidate", "rbac_external_credentials_rejected");
      check(external, secret);
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
