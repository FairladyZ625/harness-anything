import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

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
  mode === "system"
    ? matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark"
    : mode;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem("harness-theme") as ThemeMode) ?? "dark",
  );
  const [uiScale, setUiScale] = useState<UiScale>(
    () => (localStorage.getItem("harness-ui-scale") as UiScale) ?? "standard",
  );

  useEffect(() => {
    localStorage.setItem("harness-theme", mode);
    document.documentElement.dataset.theme = resolve(mode);
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? "light" : "dark";
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("harness-ui-scale", uiScale);
    document.documentElement.dataset.uiScale = uiScale;
  }, [uiScale]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, uiScale, setUiScale }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
