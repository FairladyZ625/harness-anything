import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readSettingsFacet, resolveHarnessLayout } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);

export type HostingProvider =
  | { readonly kind: "github"; readonly host: string; readonly repository: string }
  | { readonly kind: "gitlab"; readonly host: string; readonly projectPath: string; readonly apiBaseUrl: string };

export type HostingProviderKind = HostingProvider["kind"];

/**
 * The one configuration sentence doctor health, dispatch receipts, and credential-unavailable
 * errors print. Every surface that tells a person how to bind the daemon-held credential
 * renders this string, so the advice cannot drift between the place that diagnoses the gap
 * and the place that hit it.
 */
export function hostingCredentialConfigurationAdvice(
  provider: HostingProviderKind,
  instanceId = "<instance-id>",
): string {
  const scopes =
    provider === "github"
      ? "the token needs repository contents write for task pushes and Actions read for CI"
      : "the token needs write_repository for pushes and read_api for pipelines, jobs, and traces";
  return `ha runtime instance hosting-credential set ${instanceId} --provider ${provider} --ref <opaque-reference>; ${scopes}`;
}

export async function detectHostingProvider(
  rootDir: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
  allowUnknown = false,
): Promise<HostingProvider> {
  let remote: string;
  try {
    remote = String(
      (await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout,
    ).trim();
  } catch {
    if (allowUnknown) return null as never;
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
  try {
    return hostingProviderFromRemote(remote, settings);
  } catch (error) {
    if (
      allowUnknown &&
      error instanceof Error &&
      (error as Error & { code?: string }).code === "hosting_provider_unknown"
    )
      return null as never;
    throw error;
  }
}

export async function hasOriginRemote(rootDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
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

/** One CI check on a pull request's current head, already folded to a four-word verdict. */
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
