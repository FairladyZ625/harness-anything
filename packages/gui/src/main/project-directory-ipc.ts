import path from "node:path";
import { PROJECT_DIRECTORY_CHANNEL } from "../api/project-directory-contract.ts";
import { assertTrustedIpcSender, type HarnessIpcRegistrar } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

export function registerProjectDirectoryIpc(
  registrar: Pick<HarnessIpcRegistrar, "handle">,
  services: {
    readonly registeredRoot: (repoId: string) => string | null;
    readonly openPath: (root: string) => Promise<string>;
  },
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(PROJECT_DIRECTORY_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      !("repoId" in payload) ||
      typeof payload.repoId !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(payload.repoId)
    )
      throw new Error("Open directory requires only a registered repoId.");
    const root = services.registeredRoot(payload.repoId);
    if (root === null || !path.isAbsolute(root)) throw new Error("Repository has no registered local workspace.");
    const error = await services.openPath(root);
    if (error !== "") throw new Error(error);
  });
}
