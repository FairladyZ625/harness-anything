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
  readonly devRendererOrigin?: string;
}

export interface TrustedRendererUrlOptions {
  readonly packagedRendererUrl?: string;
  readonly allowDevRenderer?: boolean;
  readonly devRendererOrigin?: string;
}

export function createGuiContentSecurityPolicy(options: GuiContentSecurityPolicyOptions = {}): string {
  const devOrigin = options.devRendererOrigin
    ? resolveDevRendererOrigin(options.devRendererOrigin)
    : options.allowDevRenderer ? "http://127.0.0.1:5173" : undefined;
  const webSocketOrigin = devOrigin?.replace(/^http:/u, "ws:");
  const connectSrc = devOrigin
    ? `connect-src 'self' ${devOrigin} ${webSocketOrigin}`
    : "connect-src 'self'";
  // Dev only: the Vite dev server injects the react-refresh preamble as an
  // inline script and styles as inline <style> tags. Production stays strict.
  const scriptSrc = devOrigin ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const styleSrc = devOrigin ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
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
  resolveDevRendererOrigin(url);
  return true;
}

export function resolveDevRendererOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password) {
    throw new Error("GUI may load a development renderer only from an explicit 127.0.0.1 HTTP port.");
  }
  return parsed.origin;
}

export function createPackagedRendererUrl(): string {
  return new URL("../renderer/index.html", import.meta.url).href;
}

export function isTrustedRendererUrl(url: string, options: TrustedRendererUrlOptions = {}): boolean {
  try {
    const parsed = new URL(url);
    const devOrigin = options.devRendererOrigin
      ? resolveDevRendererOrigin(options.devRendererOrigin)
      : options.allowDevRenderer ? "http://127.0.0.1:5173" : undefined;
    if (devOrigin && parsed.origin === devOrigin) return true;
    if (parsed.protocol !== "file:") return false;
    const packagedRendererUrl = options.packagedRendererUrl ?? createPackagedRendererUrl();
    return parsed.href === new URL(packagedRendererUrl).href;
  } catch {
    return false;
  }
}
