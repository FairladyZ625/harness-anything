import { isTrustedRendererUrl, type TrustedRendererUrlOptions } from "./window-config.ts";

export type SecurityDecisionReason =
  | "trusted_renderer"
  | "untrusted_renderer_url"
  | "untrusted_web_contents"
  | "permission_denied_by_default"
  | "navigation_denied"
  | "window_open_denied"
  | "missing_browser_preview_threat_model"
  | "browser_preview_not_shipped";

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

export interface BrowserPreviewThreatModel {
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly allowedSchemes: ReadonlyArray<"http:" | "https:">;
  readonly storagePartition: "ephemeral";
  readonly userGestureRequired: true;
}

export interface BrowserPreviewOpenRequest {
  readonly url: string;
  readonly source: "open-target-router" | "localhost-preview" | "remote-content";
  readonly userGesture: boolean;
  readonly threatModel?: BrowserPreviewThreatModel;
}

export function createStaticWebContentsTrustPolicy(ids: Iterable<number>): IpcWebContentsTrustPolicy {
  const trusted = new Set(ids);
  return {
    isTrustedWebContentsId: (id) => trusted.has(id)
  };
}

export function evaluateIpcSender(
  event: IpcSenderIdentity,
  trustPolicy: IpcWebContentsTrustPolicy
): SecurityDecision {
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

export function evaluateBrowserPreviewOpenRequest(request: BrowserPreviewOpenRequest): SecurityDecision {
  if (!request.threatModel) {
    return {
      action: "deny",
      reason: "missing_browser_preview_threat_model",
      detail: request.source
    };
  }
  return {
    action: "deny",
    reason: "browser_preview_not_shipped",
    detail: request.url
  };
}
