import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import { FactArchiveVisibilityProvider } from "./fact-archive-preferences.tsx";
import { rendererQueryDefaults } from "./query-pacing.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found.");

const queryClient = new QueryClient({ defaultOptions: rendererQueryDefaults });

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <FactArchiveVisibilityProvider>
          <App />
        </FactArchiveVisibilityProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
