import type { ReactNode } from "react";
import { BoundedContent } from "./BoundedContent";

export function Modal({
  title,
  hint,
  wide = false,
  testId,
  footer,
  onClose,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly wide?: boolean;
  readonly testId?: string;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="glass-scrim fixed inset-0 z-50 flex items-center justify-center p-6"
    >
      <div
        className={`flex max-h-[calc(100dvh-80px)] w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-2xl ${wide ? "max-w-[760px]" : "max-w-[640px]"}`}
      >
        <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <b className="ui-body font-[650]">{title}</b>
          {hint && <span className="ui-micro text-text-faint">{hint}</span>}
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            className="ml-auto px-1 ui-prose text-text-faint hover:text-text"
          >
            ✕
          </button>
        </header>
        <BoundedContent className="min-h-0 flex-1 px-3.5 py-3">{children}</BoundedContent>
        <footer className="border-t border-border px-3.5 py-2.5">{footer}</footer>
      </div>
    </div>
  );
}
