import { CheckCircle, XCircle, Circle } from "@phosphor-icons/react";
import type { DocEntry } from "../../model/types";

export function AxisRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function DocPresence({ doc }: { doc: DocEntry }) {
  if (doc.present) {
    return <CheckCircle weight="bold" className="shrink-0 text-[13px]" style={{ color: "var(--color-status-done)" }} />;
  }
  if (doc.required) {
    return <XCircle weight="bold" className="shrink-0 text-[13px]" style={{ color: "var(--color-danger)" }} />;
  }
  return <Circle weight="regular" className="shrink-0 text-[13px] text-text-faint" />;
}
