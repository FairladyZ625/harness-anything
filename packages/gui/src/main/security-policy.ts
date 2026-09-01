import { isTrustedRendererUrl, type TrustedRendererUrlOptions } from "./window-config.ts";
import { isAllowedHtmlArtifactAttachment, isAllowedHtmlArtifactRequest } from "../api/html-artifact-policy.ts";

export { HTML_ARTIFACT_DATA_URL_PREFIX, HTML_ARTIFACT_PARTITION } from "../api/html-artifact-policy.ts";

export const IN_APP_BROWSER_PARTITION = "in-app-browser";

export type SecurityDecisionReason =
  | "trusted_renderer"
  | "untrusted_renderer_url"
  | "untrusted_web_contents"
  | "permission_denied_by_default"
  | "navigation_denied"
  | "window_open_denied"
  | "html_artifact_source_allowed"
  | "html_artifact_source_denied"
  | "html_artifact_request_allowed"
  | "html_artifact_request_denied"
  | "in_app_browser_source_allowed"
  | "in_app_browser_source_denied"
  | "in_app_browser_navigation_allowed"
  | "in_app_browser_navigation_denied";

export type SecurityDecision =
  | { readonly action: "allow"; readonly reason: SecurityDecisionReason }
  | { readonly action: "deny"; readonly reason: SecurityDecisionReason; readonly detail?: string };

export interface IpcWebContentsTrustPolicy {
  readonly isTrustedWebContentsId: (id: number) => boolean;
  readonly rendererUrl?: TrustedRendererUrlOptions;
}

export interface IpcSenderIdentity {
  readonly sender: {
    readonly id: number;
  };
  readonly senderFrame?: {
    readonly url?: string;
  } | null;
}

export function createStaticWebContentsTrustPolicy(ids: Iterable<number>): IpcWebContentsTrustPolicy {
  const trusted = new Set(ids);
  return {
    isTrustedWebContentsId: (id) => trusted.has(id),
  };
}

export function evaluateIpcSender(event: IpcSenderIdentity, trustPolicy: IpcWebContentsTrustPolicy): SecurityDecision {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedRendererUrl(senderUrl, trustPolicy.rendererUrl)) {
    return { action: "deny", reason: "untrusted_renderer_url" };
  }
  if (!trustPolicy.isTrustedWebContentsId(event.sender.id)) {
    return { action: "deny", reason: "untrusted_web_contents" };
  }
  return { action: "allow", reason: "trusted_renderer" };
}

export function evaluatePermissionRequest(): SecurityDecision {
  return { action: "deny", reason: "permission_denied_by_default" };
}

export function evaluateNavigationRequest(url: string, options: TrustedRendererUrlOptions = {}): SecurityDecision {
  if (isTrustedRendererUrl(url, options)) return { action: "allow", reason: "trusted_renderer" };
  return { action: "deny", reason: "navigation_denied" };
}

export function evaluateWindowOpenRequest(): SecurityDecision {
  return { action: "deny", reason: "window_open_denied" };
}

/**
 * Task HTML previews receive bytes only from repo.tasks.document.read and turn
 * them into one data:text/html guest navigation. Arbitrary URL and partition
 * values never reach an attached guest WebContents.
 */
export function evaluateHtmlArtifactAttachment(params: Readonly<Record<string, string>>): SecurityDecision {
  if (isAllowedHtmlArtifactAttachment(params)) {
    return { action: "allow", reason: "html_artifact_source_allowed" };
  }
  return { action: "deny", reason: "html_artifact_source_denied", detail: params.src };
}

/** The isolated guest may load its own data resources and nothing else. */
export function evaluateHtmlArtifactRequest(url: string): SecurityDecision {
  if (isAllowedHtmlArtifactRequest(url)) return { action: "allow", reason: "html_artifact_request_allowed" };
  return { action: "deny", reason: "html_artifact_request_denied", detail: url };
}

export function evaluateInAppBrowserUrl(url: string): SecurityDecision {
  if (URL.canParse(url)) {
    const scheme = new URL(url).protocol;
    if (scheme === "http:" || scheme === "https:") {
      return { action: "allow", reason: "in_app_browser_navigation_allowed" };
    }
  }
  return { action: "deny", reason: "in_app_browser_navigation_denied", detail: url };
}

export function evaluateInAppBrowserAttachment(params: Readonly<Record<string, string>>): SecurityDecision {
  if (params.partition === IN_APP_BROWSER_PARTITION && evaluateInAppBrowserUrl(params.src).action === "allow") {
    return { action: "allow", reason: "in_app_browser_source_allowed" };
  }
  return { action: "deny", reason: "in_app_browser_source_denied", detail: params.src };
}
