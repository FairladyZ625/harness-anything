import { createContext, useContext, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";

export type MotionPreference = "system" | "on" | "off";
const MotionPreferenceContext = createContext<MotionPreference>("system");

/** Temporary acceptance switch: pass preference="on" or "off" at AppMotionConfig. */
export function AppMotionConfig({
  children,
  preference = "system",
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
