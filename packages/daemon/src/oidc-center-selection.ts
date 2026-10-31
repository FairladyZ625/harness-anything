import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import type { OidcLoginAuthority } from "./oidc-session-contracts.ts";

export interface OidcCenterSelection {
  readonly issuer: string;
  readonly authority: OidcLoginAuthority;
}

/** Discovery identifies a binding once; persisted selection lets a restarted daemon use sessions while its center is offline. */
export function oidcCenterSelections(userRoot: string) {
  const directory = path.join(userRoot, "rbac", "oidc-centers"),
    memory = new Map<string, OidcCenterSelection>();
  const binding = (target?: string): string => {
    const configFile = path.join(userRoot, "rbac", "config.json"),
      edge = target ? readFleetEdgeConfig(target) : null,
      config = edge ?? (existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null),
      targetIdentity = edge
        ? {
            repoId: edge.repoId,
            host: edge.host,
            port: edge.port,
            caPath: edge.caPath,
            ...(edge.servername ? { servername: edge.servername } : {}),
          }
        : null;
    const identity =
      targetIdentity ??
      (config && typeof config === "object"
        ? Object.fromEntries(
            ["url", "realm", "clientId", "listener"]
              .filter((field) => Object.hasOwn(config, field))
              .map((field) => [field, (config as Record<string, unknown>)[field]]),
          )
        : config);
    return createHash("sha256")
      .update(JSON.stringify([target ?? null, identity]))
      .digest("hex");
  };
  return {
    read(target?: string): OidcCenterSelection | undefined {
      const key = binding(target),
        file = path.join(directory, `${key}.json`),
        cached = memory.get(key);
      if (cached) return cached;
      if (!existsSync(file)) return undefined;
      const selection = JSON.parse(readFileSync(file, "utf8")) as OidcCenterSelection;
      memory.set(key, selection);
      return selection;
    },
    write(target: string | undefined, selection: OidcCenterSelection): void {
      const key = binding(target),
        { clientSecret: _secret, ...authority } = selection.authority,
        stored = { issuer: selection.issuer, authority };
      memory.set(key, stored);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${key}.json`),
        temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
