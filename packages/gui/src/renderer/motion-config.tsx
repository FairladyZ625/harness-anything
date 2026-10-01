import { createContext, useContext, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";

export type MotionPreference = "system" | "on" | "off";
const MotionPreferenceContext = createContext<MotionPreference>("system");

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

export function AppMotionConfig({
  children,
  preference = storedMotionPreference(),
}: {
  readonly children: ReactNode;
  readonly preference?: MotionPreference;
}) {
  return (
    <MotionPreferenceContext.Provider value={preference}>
      <MotionConfig reducedMotion={preference === "system" ? "user" : preference === "on" ? "never" : "always"}>
        {children}
      </MotionConfig>
    </MotionPreferenceContext.Provider>
  );
}

export function useEntryMotion() {
  const preference = useContext(MotionPreferenceContext);
  const reduced = useReducedMotion();
  return { enabled: preference !== "off", reduced: preference === "system" && reduced === true };
}
