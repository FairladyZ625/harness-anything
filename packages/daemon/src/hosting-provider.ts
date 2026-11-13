import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
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
  repoId = "<repo-id>",
): string {
  const scopes =
    provider === "github"
      ? "the token needs repository contents write for task pushes, pull requests write for PR publication, and Actions read for CI"
      : "the token needs write_repository for pushes and api for merge request publication and CI reads";
  return `ha runtime instance hosting-credential set ${instanceId} --repo-id ${repoId} --provider ${provider} --ref <opaque-reference>; ${scopes}`;
}

export async function detectHostingProvider(
  rootDir: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
  allowUnknown = false,
): Promise<HostingProvider> {
  let remote: string;
  try {
    remote = String(
      (
        await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], {
          timeout: daemonProtocolFleetPolicy.defaultValue.hosting.gitTimeoutMs,
        })
      ).stdout,
    ).trim();
  } catch {
    if (allowUnknown) return null as never;
    throw unknownHostingProvider();
  }
  const settings = declaration ?? hostingDeclaration(rootDir);
  try {
    return hostingProviderFromRemote(remote, settings);
  } catch (error) {
    if (allowUnknown && isUnknownHostingProvider(error)) return null as never;
    throw error;
  }
}

function hostingDeclaration(
  rootDir: string,
): { readonly provider?: "github" | "gitlab"; readonly host?: string } | undefined {
  const settingsPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml");
  return existsSync(settingsPath)
    ? (
        readSettingsFacet(
          new TextDecoder("utf-8", { fatal: true }).decode(
            readAuthoredDocumentBytes(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml"),
          ),
        ) as unknown as {
          hosting?: { provider?: "github" | "gitlab"; host?: string };
        }
      ).hosting
    : undefined;
}

function isUnknownHostingProvider(error: unknown): boolean {
  return error instanceof Error && (error as Error & { readonly code?: string }).code === "hosting_provider_unknown";
}

export async function hasOriginRemote(rootDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], {
      timeout: daemonProtocolFleetPolicy.defaultValue.hosting.gitTimeoutMs,
    });
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
