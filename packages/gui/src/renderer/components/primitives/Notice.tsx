import type { ReactNode } from "react";
import { TONE_COLOR } from "./StatusTag";

/** A message surface, distinct from a short status label or a chart's color encoding. */
export function Notice({
  children,
  tone = "wait",
  variant = "panel",
  testId,
}: {
  readonly children: ReactNode;
  readonly tone?: "bad" | "wait" | "neutral";
  readonly variant?: "panel" | "strip";
  readonly testId?: string;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      data-testid={testId}
      data-notice-tone={tone}
      className={`min-w-0 shrink-0 px-3 py-2 ui-meta leading-relaxed ${variant === "strip" ? "border-b border-border" : "my-2 rounded border border-border-strong"}`}
      style={{ color, background: `color-mix(in oklch, ${color} 8%, transparent)` }}
    >
      <div className="bounded-content break-words">{children}</div>
    </div>
  );
}
