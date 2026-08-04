import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt } from "./receipt-envelope.ts";

export function buildIdentityAdmissionFailure(
  contract: JsonRpcMethodContract,
  readBuildIdentity: () => {
    readonly loadedIdentity: string;
    readonly installedIdentity: string;
  }
): ReturnType<typeof failureReceipt> | undefined {
  if (contract.buildIdentityAdmission === "exempt") {
    return undefined;
  }
  let build: ReturnType<typeof readBuildIdentity>;
  try {
    build = readBuildIdentity();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return failureReceipt(
      contract.method,
      "daemon_build_identity_unavailable",
      `Daemon cannot verify that its running code matches the current dist build (${cause}); mixed-version writes are disabled. Run \`ha daemon restart\`.`,
      { data: { nextCommand: "ha daemon restart" } }
    );
  }
  if (build.loadedIdentity === build.installedIdentity) return undefined;
  return failureReceipt(
    contract.method,
    "daemon_build_stale",
    `Daemon code version ${build.loadedIdentity} does not match current dist version ${build.installedIdentity}; mixed-version writes are disabled. Run \`ha daemon restart\`.`,
    {
      data: {
        loadedIdentity: build.loadedIdentity,
        installedIdentity: build.installedIdentity,
        nextCommand: "ha daemon restart"
      }
    }
  );
}
