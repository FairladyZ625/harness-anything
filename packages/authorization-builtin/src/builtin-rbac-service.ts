import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IdentityManagementPort, ManagedRbacRequest } from "@harness-anything/kernel";
import { ensureBuiltinConfig } from "./state.ts";

export class BuiltinIdentityManagement implements IdentityManagementPort {
  readonly #root: string;
  readonly #external?: Pick<
    IdentityManagementPort,
    "run" | "resume" | "start" | "stop" | "health" | "loginListenerCertificate"
  >;
  #lifecycle: Promise<unknown> = Promise.resolve();
  constructor(
    userRoot: string,
    external?: Pick<
      IdentityManagementPort,
      "run" | "resume" | "start" | "stop" | "health" | "loginListenerCertificate"
    >,
  ) {
    this.#root = userRoot;
    this.#external = external;
  }
  run(request: ManagedRbacRequest = {}): Promise<Record<string, unknown>> {
    const run = this.#lifecycle.then(() => this.#run(request));
    this.#lifecycle = Promise.allSettled([run]).then(() => undefined);
    return run;
  }
  async resume(): Promise<void> {
    if (this.#config()?.mode === "builtin") return;
    await this.#external?.resume();
  }
  loginListenerCertificate(): ReturnType<IdentityManagementPort["loginListenerCertificate"]> {
    return this.#external?.loginListenerCertificate() ?? null;
  }
  start(): Promise<void> {
    return this.#external?.start() ?? Promise.resolve();
  }
  stop(): Promise<Record<string, unknown>> {
    return this.#external?.stop() ?? Promise.resolve({ ok: true, command: "rbac-stop", stopped: [] });
  }
  health(): Promise<Record<string, unknown>> {
    return this.#config()?.mode === "builtin" || !this.#external
      ? Promise.resolve(this.#health())
      : this.#external.health();
  }
  async #run(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (request.mode === "external" || request.mode === "managed") {
      if (this.#external) {
        const result = await this.#external.run(request);
        return { ...result, restartRequired: true };
      }
      throw Object.assign(new Error("Install the Keycloak identity plugin before selecting an external provider."), {
        code: "identity_plugin_unavailable",
      });
    }
    ensureBuiltinConfig(this.#root);
    return {
      ok: true,
      command: `rbac-${request.operation ?? "bootstrap"}`,
      mode: "builtin",
      url: `builtin://local`,
      downloaded: [],
    };
  }
  #config():
    | { readonly mode?: string; readonly url?: string; readonly realm?: string; readonly clientId?: string }
    | undefined {
    const file = path.join(this.#root, "rbac", "config.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { readonly mode?: string }) : undefined;
  }
  #health(): Record<string, unknown> {
    const config = this.#config();
    return {
      ok: true,
      ready: true,
      mode: config?.mode ?? "builtin",
      url: config?.url ?? "builtin://local",
      realm: config?.realm ?? "local",
      clientId: config?.clientId ?? "harness-center",
      downloaded: [],
    };
  }
}
