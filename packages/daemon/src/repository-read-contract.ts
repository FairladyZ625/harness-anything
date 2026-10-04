import { daemonGuiReadMethods } from "./protocol/daemon-protocol-gui-reads.ts";
import { shape, validateShape } from "./protocol/daemon-protocol-gui-types.ts";

/** The GUI declaration owns both center residency and the closed Fleet payload. */
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

export function validRepositoryReadPayload(method: string, payload: unknown): boolean {
  const descriptor = repositoryReadDescriptor(method, payload);
  if (!descriptor) return false;
  const fields = descriptor.params.fields;
  return validateShape(payload, "payload" in fields ? fields.payload : shape({}), "payload").length === 0;
}
