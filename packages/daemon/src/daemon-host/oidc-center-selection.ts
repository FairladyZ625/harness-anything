import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRegularFileIfPresent } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { readFleetEdgeConfigForRoot, type FleetEdgeConfig } from "./client/fleet-edge-config.ts";
import type { OidcLoginAuthority } from "@harness-anything/kernel";

export interface OidcCenterSelection {
  readonly issuer: string;
  readonly authority: OidcLoginAuthority;
}

const edgeIdentity = (edge: FleetEdgeConfig) => ({
  repoId: edge.repoId,
  host: edge.host,
  port: edge.port,
  caPath: edge.caPath,
  ...(edge.servername ? { servername: edge.servername } : {}),
});

/** Discovery identifies a binding once; persisted selection lets a restarted daemon use sessions while its center is offline. */
export function oidcCenterSelections(userRoot: string) {
  const directory = path.join(userRoot, "rbac", "oidc-centers");
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
  const writeSelection = (
    target: string | undefined,
    selection: OidcCenterSelection | null,
    identityOverride?: Readonly<Record<string, unknown>>,
    clearAll = false,
  ): void => {
    if (clearAll) {
      if (!existsSync(directory)) return;
    } else {
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ mkdirSync(directory, {
        recursive: true,
        mode: 0o700,
      });
    }
    const files = clearAll
      ? readdirSync(directory)
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => path.join(directory, entry))
      : [path.join(directory, `${binding(target, identityOverride)}.json`)];
    const { clientSecret: _secret, ...authority } = selection?.authority ?? {};
    const stored = selection ? { issuer: selection.issuer, authority } : null;
    for (const file of files) {
      const temporary = `${file}.tmp`;
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ writeFileSync(
        temporary,
        JSON.stringify(stored),
        { mode: 0o600 },
      );
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ renameSync(temporary, file);
    }
  };
  return {
    key(target?: string, identityOverride?: Readonly<Record<string, unknown>>): string {
      return binding(target, identityOverride);
    },
    clear(target: string, replacement?: FleetEdgeConfig): void {
      writeSelection(target, null);
      if (replacement) writeSelection(target, null, edgeIdentity(replacement));
    },
    clearAll(): void {
      writeSelection(undefined, null, undefined, true);
    },
    read(target?: string, identityOverride?: Readonly<Record<string, unknown>>): OidcCenterSelection | undefined {
      const key = binding(target, identityOverride),
        file = path.join(directory, `${key}.json`);
      if (!existsSync(file)) return undefined;
      const selection = JSON.parse(readFileSync(file, "utf8")) as OidcCenterSelection | null;
      return selection === null ? undefined : selection;
    },
    write(target: string | undefined, selection: OidcCenterSelection): void {
      writeSelection(target, selection);
    },
  };
}
