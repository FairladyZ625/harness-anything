import type { ReactNode } from "react";

/**
 * Long-form content boundary shared by logs, reviews, timelines and previews.
 * The percentage follows a sized parent; the viewport cap keeps standalone
 * consumers bounded when their parent has intrinsic height.
 */
export const BOUNDED_CONTENT_CLASS = "max-h-[min(55%,55dvh)] overflow-y-auto overscroll-contain";

export function BoundedContent({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={`${BOUNDED_CONTENT_CLASS}${className ? ` ${className}` : ""}`}>{children}</div>;
}
