/** @slice-activation Slice 7.5 GUI trust policy - Embedded browser and terminal link opening consume this when wired. */
import path from "node:path";

export interface TrustPolicy {
  readonly projectId: string;
  readonly allowedRoots: readonly string[];
  readonly allowedLocalhostPorts?: readonly number[];
  readonly allowedUrlOrigins: readonly string[];
  readonly openExternalByDefault: boolean;
}

export type TrustPolicyDecisionReason =
  | "invalid_policy"
  | "file_target_allowed_root"
  | "file_target_outside_allowed_roots"
  | "embedded_browser_allowed_origin"
  | "embedded_browser_allowed_localhost"
  | "embedded_browser_denied"
  | "external_url_system_browser"
  | "external_url_denied"
  | "terminal_link_requires_user_gesture"
  | "invalid_target";

export type TrustPolicyDecision =
  | { readonly action: "allow"; readonly reason: TrustPolicyDecisionReason }
  | { readonly action: "deny"; readonly reason: TrustPolicyDecisionReason; readonly detail?: string }
  | { readonly action: "open_external"; readonly reason: TrustPolicyDecisionReason };

export interface TerminalOutputLinkRequest {
  readonly target: string;
  readonly userGesture: boolean;
}

export type TrustPolicyValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_trust_policy";
        readonly hint: string;
      };
    };

export function validateTrustPolicy(policy: TrustPolicy): TrustPolicyValidationResult {
  if (!policy.projectId) return invalidPolicy("TrustPolicy requires projectId.");
  if (policy.allowedRoots.length === 0 || !policy.allowedRoots.every((root) => path.isAbsolute(root))) {
    return invalidPolicy("TrustPolicy allowedRoots must be non-empty absolute paths.");
  }
  if ((policy.allowedLocalhostPorts ?? []).some((port) => !Number.isInteger(port) || port <= 0 || port > 65535)) {
    return invalidPolicy("TrustPolicy allowedLocalhostPorts must be valid TCP ports.");
  }
  if (!policy.allowedUrlOrigins.every(isValidOrigin)) {
    return invalidPolicy("TrustPolicy allowedUrlOrigins must be URL origins.");
  }
  return { ok: true };
}

export function evaluateFileTarget(policy: TrustPolicy, targetPath: string): TrustPolicyDecision {
  if (!validateTrustPolicy(policy).ok) {
    return { action: "deny", reason: "invalid_policy" };
  }
  if (!path.isAbsolute(targetPath)) {
    return { action: "deny", reason: "invalid_target", detail: targetPath };
  }
  const resolvedTarget = path.resolve(targetPath);
  for (const allowedRoot of policy.allowedRoots) {
    if (isPathInsideRoot(resolvedTarget, path.resolve(allowedRoot))) {
      return { action: "allow", reason: "file_target_allowed_root" };
    }
  }
  return {
    action: "deny",
    reason: "file_target_outside_allowed_roots",
    detail: targetPath
  };
}

export function evaluateEmbeddedBrowserTarget(policy: TrustPolicy, targetUrl: string): TrustPolicyDecision {
  if (!validateTrustPolicy(policy).ok) {
    return { action: "deny", reason: "invalid_policy" };
  }
  const parsed = parseUrl(targetUrl);
  if (!parsed) return { action: "deny", reason: "invalid_target", detail: targetUrl };
  if (policy.allowedUrlOrigins.includes(parsed.origin)) {
    return { action: "allow", reason: "embedded_browser_allowed_origin" };
  }
  if (isLocalhost(parsed) && isAllowedLocalhostPort(policy, parsed)) {
    return { action: "allow", reason: "embedded_browser_allowed_localhost" };
  }
  return { action: "deny", reason: "embedded_browser_denied", detail: targetUrl };
}

export function evaluateExternalUrlTarget(policy: TrustPolicy, targetUrl: string): TrustPolicyDecision {
  if (!validateTrustPolicy(policy).ok) {
    return { action: "deny", reason: "invalid_policy" };
  }
  const parsed = parseUrl(targetUrl);
  if (!parsed) return { action: "deny", reason: "invalid_target", detail: targetUrl };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { action: "deny", reason: "invalid_target", detail: targetUrl };
  }
  if (policy.openExternalByDefault) {
    return { action: "open_external", reason: "external_url_system_browser" };
  }
  return { action: "deny", reason: "external_url_denied", detail: targetUrl };
}

export function evaluateTerminalOutputLink(policy: TrustPolicy, request: TerminalOutputLinkRequest): TrustPolicyDecision {
  if (!request.userGesture) {
    return {
      action: "deny",
      reason: "terminal_link_requires_user_gesture",
      detail: request.target
    };
  }

  const parsed = parseUrl(request.target);
  if (!parsed) return evaluateFileTarget(policy, request.target);
  if (parsed.protocol === "file:") return evaluateFileTarget(policy, parsed.pathname);
  return evaluateExternalUrlTarget(policy, request.target);
}

function isPathInsideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function invalidPolicy(hint: string): TrustPolicyValidationResult {
  return {
    ok: false,
    error: {
      code: "invalid_trust_policy",
      hint
    }
  };
}

function isValidOrigin(value: string): boolean {
  const parsed = parseUrl(value);
  return !!parsed && parsed.origin === value && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function isAllowedLocalhostPort(policy: TrustPolicy, url: URL): boolean {
  const port = Number(url.port || defaultPort(url.protocol));
  return Number.isInteger(port) && (policy.allowedLocalhostPorts ?? []).includes(port);
}

function defaultPort(protocol: string): number {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return NaN;
}
