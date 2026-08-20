import enAgentRuntime from "./locales/en-US/agentRuntime.json" with { type: "json" };
import enComponents from "./locales/en-US/components.json" with { type: "json" };
import enGraph from "./locales/en-US/graph.json" with { type: "json" };
import enModel from "./locales/en-US/model.json" with { type: "json" };
import enRenderer from "./locales/en-US/renderer.json" with { type: "json" };
import enRebuild from "./locales/en-US/rebuild.json" with { type: "json" };
import enTerminal from "./locales/en-US/terminal.json" with { type: "json" };
import enViews from "./locales/en-US/views.json" with { type: "json" };
import zhAgentRuntime from "./locales/zh-CN/agentRuntime.json" with { type: "json" };
import zhComponents from "./locales/zh-CN/components.json" with { type: "json" };
import zhGraph from "./locales/zh-CN/graph.json" with { type: "json" };
import zhModel from "./locales/zh-CN/model.json" with { type: "json" };
import zhRenderer from "./locales/zh-CN/renderer.json" with { type: "json" };
import zhRebuild from "./locales/zh-CN/rebuild.json" with { type: "json" };
import zhTerminal from "./locales/zh-CN/terminal.json" with { type: "json" };
import zhViews from "./locales/zh-CN/views.json" with { type: "json" };

const enUS = {
  ...enAgentRuntime,
  ...enComponents,
  ...enGraph,
  ...enModel,
  ...enRebuild,
  ...enRenderer,
  ...enTerminal,
  ...enViews,
};

export type MessageKey = keyof typeof enUS;

const zhCN = {
  ...zhAgentRuntime,
  ...zhComponents,
  ...zhGraph,
  ...zhModel,
  ...zhRebuild,
  ...zhRenderer,
  ...zhTerminal,
  ...zhViews,
} satisfies Record<MessageKey, string>;

export type Locale = "en-US" | "zh-CN";
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};
export const LOCALE_STORAGE_KEY = "harness-locale";

function systemLocale(): Locale {
  // rebuild 线产品文案以中文为一等公民(历史视图均为中文),默认 zh-CN;
  // en-US 为显式 opt-in(设置页切换)。已保存的偏好始终优先。
  if (typeof window !== "undefined" && typeof navigator !== "undefined"
    && navigator.language.toLowerCase().startsWith("en")) return "en-US";
  return "zh-CN";
}

export function initialLocale(): Locale {
  if (typeof localStorage === "undefined") return systemLocale();
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved === "en-US" || saved === "zh-CN" ? saved : systemLocale();
  } catch {
    return systemLocale();
  }
}

let activeLocale: Locale = initialLocale();

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

export function messageFor(key: MessageKey): string {
  return catalogs[activeLocale][key] ?? catalogs["en-US"][key];
}

function interpolate(message: string, params: MessageParams = {}): string {
  return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? placeholder : String(value);
  });
}

export function t(key: MessageKey, params?: MessageParams): string {
  return interpolate(messageFor(key), params);
}
