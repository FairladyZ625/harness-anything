import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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
  ...(edge.spkiSha256 ? { spkiSha256: edge.spkiSha256 } : {}),
});

function persistedSelection(selection: OidcCenterSelection): OidcCenterSelection {
  const issuer = selection.issuer,
    { clientSecret: _secret, ...authority } = selection.authority,
    stored = { issuer, authority };
  return stored;
}

function isHttpUrl(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

function canonicalSelectionTarget(target: string | undefined): string | null {
  if (target === undefined) return null;
  const resolved = path.resolve(target),
    pending: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    pending.unshift(path.basename(current));
    current = parent;
  }
  const canonical = existsSync(current) ? path.join(realpathSync.native(current), ...pending) : resolved;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Discovery identifies a binding once; persisted selection lets a restarted daemon use sessions while its center is offline. */
export function oidcCenterSelections(userRoot: string) {
  const directory = path.join(userRoot, "rbac", "oidc-centers");
  const binding = (rawTarget?: string, identityOverride?: Readonly<Record<string, unknown>>): string => {
    const target = canonicalSelectionTarget(rawTarget),
      configFile = path.join(userRoot, "rbac", "config.json"),
      edge = !identityOverride && rawTarget ? readFleetEdgeConfigForRoot(userRoot, rawTarget) : null,
      localConfig =
        !identityOverride && !edge && existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null,
      config =
        localConfig?.mode === "builtin" || (typeof localConfig?.url === "string" && !isHttpUrl(localConfig.url))
          ? null
          : localConfig,
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
  function write(
    target: string | undefined,
    selection: OidcCenterSelection | null,
    identityOverride?: Readonly<Record<string, unknown>>,
    clearAll = false,
  ): void {
    if (selection) {
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ mkdirSync(directory, {
        recursive: true,
        mode: 0o700,
      });
    } else if (!existsSync(directory)) return;
    const files = clearAll
      ? readdirSync(directory)
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => path.join(directory, entry))
      : [path.join(directory, `${binding(target, identityOverride)}.json`)];
    const stored = selection ? persistedSelection(selection) : null;
    for (const file of files) {
      const temporary = `${file}.tmp`;
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ writeFileSync(
        temporary,
        JSON.stringify(stored),
        { mode: 0o600 },
      );
      /* @gate-identity state-store/runtime-instance.oidc-center-selection */ renameSync(temporary, file);
    }
  }
  return {
    clearAll: write.bind(undefined, undefined, null, undefined, true),
    key: binding,
    read(target?: string, identityOverride?: Readonly<Record<string, unknown>>): OidcCenterSelection | undefined {
      const key = binding(target, identityOverride),
        file = path.join(directory, `${key}.json`);
      if (!existsSync(file)) return undefined;
      const selection = JSON.parse(readFileSync(file, "utf8")) as OidcCenterSelection | null;
      if (
        !selection ||
        !isHttpUrl(selection.authority.url) ||
        (selection.authority.browserUrl !== undefined && !isHttpUrl(selection.authority.browserUrl))
      )
        return undefined;
      return selection;
    },
    carryOver: write.bind(undefined),
    write,
  };
}
