import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRegularFileIfPresent } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { readFleetEdgeConfig, readFleetEdgeConfigForRoot, type FleetEdgeConfig } from "./client/fleet-edge-config.ts";
import type { OidcLoginAuthority } from "@harness-anything/kernel";

export interface OidcCenterSelection {
  readonly issuer: string;
  readonly authority: OidcLoginAuthority;
}

const selectionMemories = new Map<string, Map<string, OidcCenterSelection>>();
const edgeIdentity = (edge: FleetEdgeConfig) => ({
  repoId: edge.repoId,
  host: edge.host,
  port: edge.port,
  caPath: edge.caPath,
  ...(edge.servername ? { servername: edge.servername } : {}),
});

/** Discovery identifies a binding once; persisted selection lets a restarted daemon use sessions while its center is offline. */
export function oidcCenterSelections(userRoot: string) {
  const directory = path.join(userRoot, "rbac", "oidc-centers"),
    memory = selectionMemories.get(path.resolve(userRoot)) ?? new Map<string, OidcCenterSelection>();
  selectionMemories.set(path.resolve(userRoot), memory);
  const binding = (target?: string, identityOverride?: Readonly<Record<string, unknown>>): string => {
    const configFile = path.join(userRoot, "rbac", "config.json"),
      edge = !identityOverride && target ? readFleetEdgeConfigForRoot(userRoot, target) : null,
      config = edge ?? (existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null),
      targetIdentity = edge ? edgeIdentity(edge) : null;
    const rawIdentity =
      identityOverride ??
      targetIdentity ??
      (config && typeof config === "object"
        ? Object.fromEntries(
            ["url", "realm", "clientId", "listener"]
              .filter((field) => Object.hasOwn(config, field))
              .map((field) => [field, (config as Record<string, unknown>)[field]]),
          )
        : config);
    const listenerCertFile =
      !identityOverride &&
      !targetIdentity &&
      config &&
      typeof config === "object" &&
      typeof (config as { readonly listener?: { readonly certificateFile?: unknown } }).listener?.certificateFile ===
        "string"
        ? (config as { readonly listener: { readonly certificateFile: string } }).listener.certificateFile
        : undefined;
    const listenerCertificatePem =
      listenerCertFile && rawIdentity && typeof rawIdentity === "object"
        ? readRegularFileIfPresent(listenerCertFile)?.bytes.toString("utf8")
        : undefined;
    const identity =
      listenerCertificatePem !== undefined && rawIdentity && typeof rawIdentity === "object"
        ? { ...rawIdentity, listenerCertificatePem }
        : rawIdentity;
    return createHash("sha256")
      .update(JSON.stringify([target ?? null, identity]))
      .digest("hex");
  };
  return {
    key(target?: string, identityOverride?: Readonly<Record<string, unknown>>): string {
      return binding(target, identityOverride);
    },
    clear(target: string, replacement?: FleetEdgeConfig): void {
      const keys = new Set([binding(target), ...(replacement ? [binding(target, edgeIdentity(replacement))] : [])]);
      for (const key of keys) {
        const file = path.join(directory, `${key}.json`);
        if (existsSync(file))
          /* @gate-identity state-store/runtime-instance.oidc-center-selection */ unlinkSync(file);
        memory.delete(key);
      }
    },
    clearAll(): void {
      if (existsSync(directory))
        /* @gate-identity state-store/runtime-instance.oidc-center-selection */ rmSync(directory, {
          recursive: true,
          force: true,
        });
      memory.clear();
    },
    read(target?: string, identityOverride?: Readonly<Record<string, unknown>>): OidcCenterSelection | undefined {
      const key = binding(target, identityOverride),
        file = path.join(directory, `${key}.json`),
        cached = memory.get(key);
      if (cached) return cached;
      if (!existsSync(file)) return undefined;
      const selection = JSON.parse(readFileSync(file, "utf8")) as OidcCenterSelection;
      memory.set(key, selection);
      return selection;
    },
    write(
      target: string | undefined,
      selection: OidcCenterSelection,
      identityOverride?: Readonly<Record<string, unknown>>,
    ): void {
      const key = binding(target, identityOverride),
        { clientSecret: _secret, ...authority } = selection.authority,
        stored = { issuer: selection.issuer, authority };
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ mkdirSync(directory, {
        recursive: true,
        mode: 0o700,
      });
      const file = path.join(directory, `${key}.json`),
        temporary = `${file}.tmp`;
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ writeFileSync(
        temporary,
        JSON.stringify(stored),
        {
          mode: 0o600,
        },
      );
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ renameSync(temporary, file);
      memory.set(key, stored);
    },
  };
}
