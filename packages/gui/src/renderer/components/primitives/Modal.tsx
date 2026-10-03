import { useLayoutEffect, useRef, type ReactNode } from "react";
import { t } from "../../i18n";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="component-modal m-auto w-[calc(100%_-_3rem)] max-w-none border-0 bg-transparent p-0 text-text"
    >
      <div
        className={`mx-auto flex max-h-[var(--overlay-content-cap)] w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-2xl ${wide ? "max-w-[760px]" : "max-w-[640px]"}`}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
          <b className="ui-body font-[650]">{title}</b>
          {hint && <span className="ui-micro text-text-faint">{hint}</span>}
          <button
            type="button"
            aria-label={t("components.primitives.close")}
            onClick={onClose}
            className="ml-auto min-h-[40px] min-w-[40px] px-1 ui-prose text-text-faint hover:text-text"
          >
            ✕
          </button>
        </header>
        <BoundedContent className="min-h-0 flex-1 px-3.5 py-3">{children}</BoundedContent>
        <footer className="shrink-0 border-t border-border px-3.5 py-2.5">{footer}</footer>
      </div>
    </dialog>
  );
}
