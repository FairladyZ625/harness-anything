import type { ReactNode } from "react";

/** Long content shares a proportional cap from the nearest sized content area. */
export function BoundedContent({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={`bounded-content${className ? ` ${className}` : ""}`}>{children}</div>;
}
