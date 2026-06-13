export interface GuiWebPreferences {
  readonly nodeIntegration: false;
  readonly contextIsolation: true;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly preload: string;
}

export interface GuiWindowOptions {
  readonly title: "Harness Anything";
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly show: false;
  readonly webPreferences: GuiWebPreferences;
}

export interface GuiContentSecurityPolicyOptions {
  readonly allowDevRenderer?: boolean;
}

export function createGuiContentSecurityPolicy(options: GuiContentSecurityPolicyOptions = {}): string {
  const connectSrc = options.allowDevRenderer
    ? "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"
    : "connect-src 'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export const guiContentSecurityPolicy = createGuiContentSecurityPolicy();

export const allowedRendererOrigins = Object.freeze([
  "file://",
  "http://127.0.0.1:5173"
] as const);

export function createGuiIndexContentSecurityPolicy(): string {
  return [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
  ].join("; ");
}

export function createGuiWindowOptions(preloadPath: string): GuiWindowOptions {
  return {
    title: "Harness Anything",
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath
    }
  };
}

export function assertDevRendererUrl(url: string): true {
  const parsed = new URL(url);
  if (parsed.origin !== "http://127.0.0.1:5173") {
    throw new Error("GUI V1 may load only the local dev renderer server.");
  }
  return true;
}

export function isTrustedRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" || parsed.origin === "http://127.0.0.1:5173";
  } catch {
    return false;
  }
}
