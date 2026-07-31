import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt } from "./receipt-envelope.ts";

const exemptAdminMethods: ReadonlySet<string> = new Set([
  "admin.daemon.launch-spec",
  "admin.daemon.restart",
  "admin.daemon.refresh",
  "admin.people.list",
  "admin.rbac.roles.list"
]);

export function buildIdentityAdmissionFailure(
  contract: JsonRpcMethodContract,
  readBuildIdentity: (() => {
    readonly loadedIdentity: string;
    readonly installedIdentity: string;
  }) | undefined
): ReturnType<typeof failureReceipt> | undefined {
  if (!readBuildIdentity
    || contract.commandClass === "repo-read"
    || exemptAdminMethods.has(contract.method)) {
    return undefined;
  }
  let build: ReturnType<NonNullable<typeof readBuildIdentity>>;
  try {
    build = readBuildIdentity();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failureReceipt(
      contract.method,
      "daemon_build_identity_unavailable",
      `Daemon cannot verify that its running code matches the current dist build (${cause}); mixed-version writes are disabled. Run \`ha daemon start --service\`.`,
      { data: { nextCommand: "ha daemon start --service" } }
    );
  }
  if (build.loadedIdentity === build.installedIdentity) return undefined;
  return failureReceipt(
    contract.method,
    "daemon_build_stale",
    `Daemon code version ${build.loadedIdentity} does not match current dist version ${build.installedIdentity}; mixed-version writes are disabled. Run \`ha daemon start --service\`.`,
    {
      data: {
        loadedIdentity: build.loadedIdentity,
        installedIdentity: build.installedIdentity,
        nextCommand: "ha daemon start --service"
      }
    }
  );
}
