import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const defaultDevRendererOrigin = "http://127.0.0.1:5173";

/** dev renderer 只接受 loopback 上的 http 源;端口跟随 dev 脚本经 ELECTRON_RENDERER_URL 传入的地址。 */
export function devRendererOriginFrom(value: string | undefined): string {
  if (!value) return defaultDevRendererOrigin;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" ? parsed.origin : defaultDevRendererOrigin;
  } catch {
    return defaultDevRendererOrigin;
  }
}

export const devRendererOrigin = devRendererOriginFrom(process.env.ELECTRON_RENDERER_URL);

export interface GuiContentSecurityPolicyOptions {
  readonly allowDevRenderer?: boolean;
}

export interface TrustedRendererUrlOptions {
  readonly packagedRendererUrl?: string;
  readonly allowDevRenderer?: boolean;
}

export function createGuiContentSecurityPolicy(options: GuiContentSecurityPolicyOptions = {}): string {
  const connectSrc = options.allowDevRenderer
    ? `connect-src 'self' ${devRendererOrigin} ${devRendererOrigin.replace("http://", "ws://")}`
    : "connect-src 'self'";
  // Dev only: the Vite dev server injects the react-refresh preamble as an inline script.
  const scriptSrc = options.allowDevRenderer ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    // 两种模式都放开 inline style:xterm 的 DOM renderer 靠运行时注入的 <style> 下发颜色表、
    // 字体与 cell 尺寸(库不支持 nonce),style-src 'self' 会让打包态终端整片变白、字体错位。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const guiContentSecurityPolicy = createGuiContentSecurityPolicy();

export const allowedRendererOrigins = Object.freeze(["file://", devRendererOrigin] as const);

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
  if (parsed.origin !== devRendererOrigin) {
    throw new Error("GUI V1 may load only the local dev renderer server.");
  }
  return true;
}

/**
 * 包根由包自身的清单身份决定,**不由入口文件的目录深度决定**。主进程有两个深度不同
 * 的支持入口 —— dev 态是 `<pkg>/src/main/electron-main.ts`,npm 通路是打包出的
 * `<pkg>/dist-electron/electron-main.js` —— 所以任何写死的 `../..` 只能对其中一个
 * 成立。写死的那一版让 npm 通路把 preload 与渲染层双双解析到 `packages/` 下不存在的
 * 路径,窗口开得出来、标题还是对的,内容全白(task_7e816153)。Node 自己的包作用域
 * 解析对两个位置都成立,这里因此不再数目录层级。
 *
 * `fromUrl` 只为可测性存在:生产调用一律用缺省值,测试注入两个入口位置各验一次。
 */
export function resolveGuiPackageRoot(fromUrl: string = import.meta.url): string {
  return path.dirname(createRequire(fromUrl).resolve("@harness-anything/gui/package.json"));
}

export function packagedRendererIndexPath(fromUrl: string = import.meta.url): string {
  return path.join(resolveGuiPackageRoot(fromUrl), "dist/index.html");
}

/**
 * 应用图标(icons/icon.png)与渲染层入口同源:都是随 npm 包发出的成品文件,定位一律
 * 走 resolveGuiPackageRoot,对 dev 与打包两个入口深度同时成立。macOS 侧 Dock 瓦片
 * 属通用 Electron bundle(task_e07b30fd 阶段一实测),运行期唯一通路是
 * app.dock.setIcon;同一文件兼作 Windows/Linux 的窗口图标(BrowserWindow icon)。
 */
export function appIconPath(fromUrl: string = import.meta.url): string {
  return path.join(resolveGuiPackageRoot(fromUrl), "icons/icon.png");
}

export function createPackagedRendererUrl(fromUrl: string = import.meta.url): string {
  return pathToFileURL(packagedRendererIndexPath(fromUrl)).href;
}

export function isTrustedRendererUrl(url: string, options: TrustedRendererUrlOptions = {}): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin === devRendererOrigin) return options.allowDevRenderer === true;
    if (parsed.protocol !== "file:") return false;
    const packagedRendererUrl = options.packagedRendererUrl ?? createPackagedRendererUrl();
    const expected = new URL(packagedRendererUrl);
    return process.platform === "win32"
      ? parsed.href.toLowerCase() === expected.href.toLowerCase()
      : parsed.href === expected.href;
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
    return process.platform === "win32"
      ? parsed.href.toLowerCase() === packagedRendererUrl.href.toLowerCase()
      : parsed.href === packagedRendererUrl.href;
  } catch {
    return false;
  }
}
