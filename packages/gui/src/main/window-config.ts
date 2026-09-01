export interface GuiWebPreferences {
  readonly nodeIntegration: false;
  readonly contextIsolation: true;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly webviewTag: true;
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

export interface TrustedRendererUrlOptions {
  readonly packagedRendererUrl?: string;
  readonly allowDevRenderer?: boolean;
}

export function createGuiContentSecurityPolicy(options: GuiContentSecurityPolicyOptions = {}): string {
  const connectSrc = options.allowDevRenderer
    ? "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"
    : "connect-src 'self'";
  // Dev only: the Vite dev server injects the react-refresh preamble as an
  // inline script and styles as inline <style> tags. Production stays strict.
  const scriptSrc = options.allowDevRenderer ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const styleSrc = options.allowDevRenderer ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "img-src 'self' data:",
    "font-src 'self'",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const guiContentSecurityPolicy = createGuiContentSecurityPolicy();

export const allowedRendererOrigins = Object.freeze(["file://", "http://127.0.0.1:5173"] as const);

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
    "frame-ancestors 'none'",
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
      webviewTag: true,
      preload: preloadPath,
    },
  };
}

export function assertDevRendererUrl(url: string): true {
  const parsed = new URL(url);
  if (parsed.origin !== "http://127.0.0.1:5173") {
    throw new Error("GUI V1 may load only the local dev renderer server.");
  }
  return true;
}

export function createPackagedRendererUrl(): string {
  return new URL("../renderer/index.html", import.meta.url).href;
}

export function isTrustedRendererUrl(url: string, options: TrustedRendererUrlOptions = {}): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "http://127.0.0.1:5173") return options.allowDevRenderer === true;
    if (parsed.protocol !== "file:") return false;
    const packagedRendererUrl = options.packagedRendererUrl ?? createPackagedRendererUrl();
    return parsed.href === new URL(packagedRendererUrl).href;
  } catch {
    return false;
  }
}

export interface AppDocumentUrlOptions {
  readonly packagedRendererUrl?: string;
  /** dev 启动时加载的 renderer 入口(ELECTRON_RENDERER_URL);打包态缺省。 */
  readonly devRendererUrl?: string | undefined;
}

/**
 * 渲染层是单文档应用:窗口可导航的 URL 只有入口文档本身 —— 打包态的 index file URL,
 * 或 dev server 的根路径。dev 态此前允许同源任意路径(如 Markdown 里 `/Users/…`
 * 绝对路径链接解析到 `http://127.0.0.1:5173/Users/…`),点击后窗口离开应用文档、
 * 落在 dev server 的 404 上 —— 这就是详情面外链白屏的壳侧成因(task_89d324b5)。
 * 渲染层的链接拦截是根修;本判定把同一类逃逸在壳边界也关掉(纵深防御)。
 */
export function isNavigableAppDocumentUrl(url: string, options: AppDocumentUrlOptions = {}): boolean {
  try {
    const parsed = new URL(url);
    if (options.devRendererUrl !== undefined && options.devRendererUrl !== "") {
      const devUrl = new URL(options.devRendererUrl);
      if (parsed.origin === devUrl.origin) return parsed.pathname === devUrl.pathname;
    }
    if (parsed.protocol !== "file:") return false;
    const packagedRendererUrl = new URL(options.packagedRendererUrl ?? createPackagedRendererUrl());
    return parsed.href === packagedRendererUrl.href;
  } catch {
    return false;
  }
}
