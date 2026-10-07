import { daemonGuiReadMethods } from "./protocol/daemon-protocol-gui-reads.ts";

/** The GUI declaration identifies the repository-read authorization scope. */
export function repositoryReadDescriptor(method: string, payload?: unknown) {
  if (method === "repo.projection.read") {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).name !== "runtime-session-groups"
    )
      return undefined;
    return daemonGuiReadMethods.find((read) => read.method === method);
  }
  return daemonGuiReadMethods.find(
    (read) => read.method === method && "repositoryRead" in read && read.repositoryRead === true,
  );
}
