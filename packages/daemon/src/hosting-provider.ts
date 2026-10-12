import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readSettingsFacet, resolveHarnessLayout } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);

export type HostingProvider =
  | { readonly kind: "github"; readonly host: string; readonly repository: string }
  | { readonly kind: "gitlab"; readonly host: string; readonly projectPath: string; readonly apiBaseUrl: string };

export async function detectHostingProvider(
  rootDir: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
): Promise<HostingProvider> {
  let remote: string;
  try {
    remote = String(
      (await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout,
    ).trim();
  } catch {
    throw unknownHostingProvider();
  }
  const authoredRoot = resolveHarnessLayout(rootDir).authoredRoot;
  let settings = declaration;
  const settingsPath = path.join(authoredRoot, "harness.yaml");
  if (!settings && existsSync(settingsPath))
    settings = (
      readSettingsFacet(readFileSync(settingsPath, "utf8")) as unknown as {
        hosting?: { provider?: "github" | "gitlab"; host?: string };
      }
    ).hosting;
  return hostingProviderFromRemote(remote, settings);
}

export function hostingProviderFromRemote(
  remote: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
): HostingProvider {
  const parsed = parseRemote(remote);
  const host = declaration?.host ?? parsed.host;
  const kind =
    declaration?.provider ?? (host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined);
  if (!kind || !host || !parsed.path) throw unknownHostingProvider();
  if (kind === "github") return { kind, host, repository: parsed.path };
  return { kind, host, projectPath: parsed.path, apiBaseUrl: `https://${host}/api/v4` };
}

function parseRemote(remote: string): { readonly host: string; readonly path: string } {
  const value = remote.trim().replace(/\.git$/u, "");
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)(?::\d+)?(?::|\/)(.+)$/u.exec(value);
  if (ssh) return { host: ssh[1]!, path: ssh[2]!.replace(/^\/+|\/+$/gu, "") };
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname.replace(/^\/+|\/+$/gu, "") };
  } catch {
    return { host: "", path: "" };
  }
}

function unknownHostingProvider(): Error {
  const error = new Error(
    "Unable to identify the repository hosting provider. Set hosting.provider and hosting.host in repository settings for GitHub or GitLab.",
  );
  Object.assign(error, { code: "hosting_provider_unknown" });
  return error;
}
