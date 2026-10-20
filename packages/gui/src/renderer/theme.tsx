import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "dark" | "light" | "system";
export type UiScale = "compact" | "standard" | "comfortable";

const ThemeContext = createContext<{
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
}>({
  mode: "dark",
  setMode: () => {},
  uiScale: "standard",
  setUiScale: () => {},
});

const resolve = (mode: ThemeMode): "dark" | "light" =>
  mode === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;

const applyTheme = (theme: "dark" | "light") => {
  document.documentElement.dataset.theme = theme;
  if (theme === "light") {
    document.documentElement.classList.remove("dark");
  } else {
    document.documentElement.classList.add("dark");
  }
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("harness-theme");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
  });
  const [uiScale, setUiScale] = useState<UiScale>(
    () => (localStorage.getItem("harness-ui-scale") as UiScale) ?? "standard",
  );

  useEffect(() => {
    localStorage.setItem("harness-theme", mode);
    applyTheme(resolve(mode));
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      applyTheme(mq.matches ? "light" : "dark");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("harness-ui-scale", uiScale);
    document.documentElement.dataset.uiScale = uiScale;
  }, [uiScale]);

  return <ThemeContext.Provider value={{ mode, setMode, uiScale, setUiScale }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
