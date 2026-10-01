import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";

export type MotionPreference = "system" | "on" | "off";

const MotionPreferenceContext = createContext<{
  preference: MotionPreference;
  setPreference: (preference: MotionPreference) => void;
}>({
  preference: "system",
  setPreference: () => {},
});

export const MOTION_PREFERENCE_STORAGE_KEY = "harness-motion";

/** 每位使用者自己的偏好,与主题同样存 localStorage;没有或取不到时跟随系统。 */
export function storedMotionPreference(): MotionPreference {
  try {
    const stored = localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY);
    return stored === "on" || stored === "off" ? stored : "system";
  } catch {
    return "system";
  }
}

/** 与 ThemeProvider 同构:初始读 localStorage、变更即写回,设置页切换后无需重载立即生效。 */
export function AppMotionConfig({ children }: { readonly children: ReactNode }) {
  const [preference, setPreference] = useState<MotionPreference>(storedMotionPreference);
  useEffect(() => {
    localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, preference);
  }, [preference]);
  return (
    <MotionPreferenceContext.Provider value={{ preference, setPreference }}>
      <MotionConfig reducedMotion={preference === "system" ? "user" : preference === "on" ? "never" : "always"}>
        {children}
      </MotionConfig>
    </MotionPreferenceContext.Provider>
  );
}

export const useMotionPreference = () => useContext(MotionPreferenceContext);

export function useEntryMotion() {
  const { preference } = useContext(MotionPreferenceContext);
  const reduced = useReducedMotion();
  return { enabled: preference !== "off", reduced: preference === "system" && reduced === true };
}
