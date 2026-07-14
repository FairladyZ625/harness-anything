import { CaretUp, TerminalWindow, X } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import { TerminalPane } from "./TerminalPane.tsx";

export interface TerminalDockProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly onToggle: () => void;
}

export function TerminalDock({ open, projectId, onToggle }: TerminalDockProps) {
  return (
    <section className={`shrink-0 border-t border-border bg-surface ${open ? "flex h-80 min-h-48 flex-col" : "h-9"}`}>
      <div className="flex h-9 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text"
          aria-expanded={open}
          onClick={onToggle}
        >
          <TerminalWindow size={15} weight="bold" />
          <span>{t("terminal.dock.title")}</span>
          {!open && <CaretUp size={12} />}
        </button>
        <span className="ml-auto font-mono text-[10px] text-text-faint">{t("terminal.dock.shortcut")}</span>
        {open && (
          <button
            type="button"
            className="grid size-7 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
            aria-label={t("terminal.dock.close")}
            title={t("terminal.dock.close")}
            onClick={onToggle}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && <TerminalPane projectId={projectId} />}
    </section>
  );
}
