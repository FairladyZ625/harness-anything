import type { ReactNode } from "react";

/** Shared bounded viewer: controls remain reachable while the document scrolls. */
export function DocumentFrame({
  toolbar,
  children,
  testId,
}: {
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="flex min-h-0 min-w-0 max-h-[var(--long-content-cap)] flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="shrink-0 border-b border-border bg-surface-raised">{toolbar}</header>
      <div className="min-h-0 min-w-0 overflow-auto" data-document-scroll>
        {children}
      </div>
    </section>
  );
}
