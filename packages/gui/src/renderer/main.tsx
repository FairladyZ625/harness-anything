import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { AppMotionConfig } from "./motion-config.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import { FactArchiveVisibilityProvider } from "./fact-archive-preferences.tsx";
import { rendererQueryDefaults } from "./query-pacing.ts";
import { applyWindowChromePlatformMarker } from "./platform.ts";
import "./styles.css";

// macOS 隐藏系统标题栏后,应用顶行的拖拽区/红绿灯留白靠 html[data-platform] 生效:
// 全渲染层只有这一个平台打标点。
applyWindowChromePlatformMarker();

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found.");

const queryClient = new QueryClient({ defaultOptions: rendererQueryDefaults });

createRoot(root).render(
  <StrictMode>
    <AppMotionConfig>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <FactArchiveVisibilityProvider>
            <App />
          </FactArchiveVisibilityProvider>
        </QueryClientProvider>
      </I18nProvider>
    </AppMotionConfig>
  </StrictMode>,
);
