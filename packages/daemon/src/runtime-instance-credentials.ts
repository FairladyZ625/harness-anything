import type { CredentialPort } from "./agent-runtime-credential-port.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import type { openRuntimeInstanceStore } from "./agent-runtime-instance-store.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";

/** The target daemon owns the FIFO and vault; secret requests never enter a durable action queue. */
export function runtimeInstanceCredentialService(
  store: ReturnType<typeof openRuntimeInstanceStore>,
  vault: CredentialPort,
) {
  let tail = Promise.resolve();
  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    ); // The caller retains the rejecting result.
    return result;
  }
  function command(action: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return enqueue(() => execute(action));
  }
  type Cleanup =
    | { readonly ok: true }
    | { readonly ok: false; readonly code: "runtime_credential_unavailable" | "runtime_credential_cleanup_failed" };
  async function removeUnused(reference: string): Promise<Cleanup> {
    if (
      store
        .list()
        .some(
          (config) =>
            (config.auth.mode === "api-key" && config.auth.credentialRef === reference) ||
            config.githubCredentialRef === reference,
        )
    )
      return { ok: true };
    try {
      await vault.remove(reference);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "runtime_credential_unavailable"
            ? "runtime_credential_unavailable"
            : "runtime_credential_cleanup_failed",
      };
    }
  }
  async function execute(action: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (action.apiKey === undefined) return await store.command(action);
    if (!["runtime-instance-create", "runtime-instance-update"].includes(String(action.kind)))
      throw runtimeInstanceError(
        "invalid_runtime_auth",
        "API keys are accepted only when creating or updating API-key instances.",
      );
    const secret = typeof action.apiKey === "string" ? action.apiKey.trim() : "";
    if (!secret || /[\u0000-\u001f\u007f]/u.test(secret) || secret.length > 1280)
      throw runtimeInstanceError(
        "invalid_api_key",
        "Enter a nonblank, single-line API key of at most 1280 characters.",
      );
    if (action.credentialRef !== undefined)
      throw runtimeInstanceError(
        "invalid_runtime_auth",
        "Choose a new API key or an existing credential reference, not both.",
      );
    const current = typeof action.instanceId === "string" ? store.read(action.instanceId) : null;
    if (action.kind === "runtime-instance-update" && !current)
      throw runtimeInstanceError("runtime_instance_not_found", "The runtime instance does not exist.");
    const kindId = current?.kindId ?? String(action.kindId),
      mode = current?.auth.mode ?? action.authMode;
    if (mode !== "api-key" || !runtimeKindForId(kindId).auth.modes.some((value) => value === "api-key"))
      throw runtimeInstanceError(
        "runtime_auth_mode_mismatch",
        "Only existing API-key instances support key replacement; subscription instances keep their authentication mode.",
      );
    if (action.kind === "runtime-instance-create" && current)
      throw runtimeInstanceError("runtime_instance_exists", "The runtime instance already exists.");
    const reference = vault.issue(),
      { apiKey: _apiKey, ...metadata } = action;
    let receipt: Record<string, unknown>;
    try {
      await vault.store(reference, secret);
      if ((await vault.resolve(reference)) !== secret)
        throw runtimeInstanceError(
          "runtime_credential_unavailable",
          "The credential vault did not confirm the stored API key.",
        );
      receipt = await store.command({ ...metadata, credentialRef: reference });
    } catch (error) {
      const cleaned = await removeUnused(reference);
      if (!cleaned.ok)
        throw runtimeInstanceError(
          "runtime_credential_cleanup_failed",
          "The replacement was rejected and the previous configuration remains available. The vault also refused to remove the unused new item; inspect the target credential vault before retrying. See docs-release/provider-credentials.md for native vault and headless setup.",
        );
      throw error;
    }
    const retired = current?.auth.mode === "api-key" ? current.auth.credentialRef : undefined,
      cleaned: Cleanup = retired === undefined ? { ok: true } : await removeUnused(retired);
    return {
      ...receipt,
      credentialChanged: true,
      credentialCleanup: cleaned.ok ? "complete" : "retained",
      ...(cleaned.ok
        ? {}
        : {
            credentialCleanupCode: cleaned.code,
            nextAction:
              "The new key is configured. The vault refused to remove the retired item; inspect the target credential vault.",
          }),
    };
  }
  // A launch resolving the old reference finishes before a replacement retires it.
  const prepareLaunch = (...args: Parameters<typeof store.prepareLaunch>) =>
    enqueue(() => store.prepareLaunch(...args));
  return { command, prepareLaunch };
}
