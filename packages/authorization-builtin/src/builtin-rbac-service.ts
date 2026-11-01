import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IdentityManagementPort, ManagedRbacRequest } from "@harness-anything/kernel";
import { ensureBuiltinConfig, readState, writeState } from "./state.ts";

export class BuiltinIdentityManagement implements IdentityManagementPort {
  readonly #root: string;
  #lifecycle: Promise<unknown> = Promise.resolve();
  constructor(userRoot: string) {
    this.#root = userRoot;
  }
  run(request: ManagedRbacRequest = {}): Promise<Record<string, unknown>> {
    const run = this.#lifecycle.then(() => this.#run(request));
    this.#lifecycle = Promise.allSettled([run]).then(() => undefined);
    return run;
  }
  async resume(): Promise<void> {
    if (this.#config()?.mode === "builtin") return;
  }
  loginListenerCertificate(): null {
    return null;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ok: true, command: "rbac-stop", stopped: [] });
  }
  health(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.#health());
  }
  async #run(request: ManagedRbacRequest): Promise<Record<string, unknown>> {
    if (request.mode === "external") {
      if (!request.url || !request.realm || !request.clientId)
        throw Object.assign(new Error("External identity configuration requires url, realm, and clientId."), {
          code: "rbac_config_invalid",
        });
      const config = {
        schema: "harness-managed-rbac/v1",
        mode: "external",
        url: request.url,
        realm: request.realm,
        clientId: request.clientId,
      };
      const state = readState(this.#root);
      writeState(this.#root, state);
      const root = path.join(this.#root, "rbac");
      const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path.join(root, "config.json"), 0o600);
      return {
        ok: true,
        command: "rbac-external",
        mode: "external",
        url: request.url,
        realm: request.realm,
        clientId: request.clientId,
      };
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
  #config(): { readonly mode?: string } | undefined {
    const file = path.join(this.#root, "rbac", "config.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { readonly mode?: string }) : undefined;
  }
  #health(): Record<string, unknown> {
    return {
      ok: true,
      ready: true,
      mode: "builtin",
      url: "builtin://local",
      realm: "local",
      clientId: "harness-center",
      downloaded: [],
    };
  }
}
