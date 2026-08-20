import type { ReactNode } from "react";

// Visual primitives for the Agent Runtime configuration plane. Every shape here is a
// direct transcription of the design prototype (card / sect / chip / badge / field grid /
// segmented control / switch / avatar / dots), so the surfaces below stay declarative and
// no view re-invents a border radius.

export const AVATAR_COLORS = ["oklch(0.75 0.12 195)", "oklch(0.75 0.12 305)", "oklch(0.75 0.12 150)", "oklch(0.75 0.12 75)", "oklch(0.75 0.10 250)", "oklch(0.72 0.12 25)"] as const;
export const KIND_COLORS: Record<string, string> = { codex: "var(--color-status-in-review)", claude: "var(--color-status-active)", agy: "var(--color-status-done)", any: "var(--color-status-planned)" };
export const initials = (id: string): string => id.replace(/[-_]/gu, " ").split(" ").filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "··";
export const colorSeed = (id: string): number => [...id].reduce((total, character) => total + character.charCodeAt(0), 0) % AVATAR_COLORS.length;

export function Crumbs({ children }: { readonly children: ReactNode }) { return <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-faint">{children}</div>; }
export function CrumbSep() { return <span className="text-border-strong">/</span>; }

export function Card({ dashed = false, testId, children }: { readonly dashed?: boolean; readonly testId?: string; readonly children: ReactNode }) { return <section data-testid={testId} className={`mb-3 rounded-lg border bg-surface-raised ${dashed ? "border-dashed border-text-faint/60" : "border-border"}`}>{children}</section>; }
export function CardHead({ children }: { readonly children: ReactNode }) { return <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">{children}</header>; }
export function CardTitle({ children }: { readonly children: ReactNode }) { return <b className="text-[12px] font-[650] tracking-[0.01em] text-text">{children}</b>; }
export function Hint({ children }: { readonly children: ReactNode }) { return <span className="text-[10.5px] text-text-faint">{children}</span>; }
export function Right({ children }: { readonly children: ReactNode }) { return <span className="ml-auto flex items-center gap-2">{children}</span>; }
export function CardBody({ children }: { readonly children: ReactNode }) { return <div className="px-3 py-2.5">{children}</div>; }

export function Sect({ title, desc, right, children }: { readonly title: string; readonly desc?: string; readonly right?: ReactNode; readonly children: ReactNode }) {
  return <section className="border-t border-border first:border-t-0"><header className="flex flex-wrap items-center gap-2 px-3.5 pt-2 pb-0.5"><b className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">{title}</b>{desc && <span className="text-[10.5px] text-text-faint">{desc}</span>}{right && <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-faint">{right}</span>}</header><div className="px-3.5 pt-2 pb-3">{children}</div></section>;
}

export function FieldGrid({ children }: { readonly children: ReactNode }) { return <dl className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-2">{children}</dl>; }
export function Field({ label, value, mono = true, faint = false }: { readonly label: string; readonly value: string; readonly mono?: boolean; readonly faint?: boolean }) { return <div className="min-w-0"><dt className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-faint">{label}</dt><dd className={`[overflow-wrap:anywhere] ${mono ? "font-mono text-[11px]" : "text-[12px]"} ${faint ? "text-text-faint" : "text-text"}`}>{value}</dd></div>; }
export function KV({ children }: { readonly children: ReactNode }) { return <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-[3px] text-[11px]">{children}</dl>; }
export function KVRow({ name, children }: { readonly name: ReactNode; readonly children: ReactNode }) { return <><dt className="whitespace-nowrap font-mono text-[10px] text-text-faint">{name}</dt><dd className="[overflow-wrap:anywhere] text-text">{children}</dd></>; }

export function Chip({ tip, tone = "plain", onClick, children }: { readonly tip?: string; readonly tone?: "plain" | "link" | "mono"; readonly onClick?: () => void; readonly children: ReactNode }) {
  const base = `inline-flex items-center gap-1.5 rounded border border-border-strong bg-surface px-[7px] py-0.5 text-[11px] ${tone === "mono" ? "font-mono text-[10.5px]" : ""}`;
  return onClick ? <button type="button" data-tip={tip} onClick={onClick} className={`${base} hover:border-accent`}>{children}</button> : <span data-tip={tip} className={base}>{children}</span>;
}
export function RoleTag({ tone = "in-review", children }: { readonly tone?: "in-review" | "done" | "active"; readonly children: ReactNode }) { const color = `var(--color-status-${tone})`; return <span className="rounded-[3px] border px-[3px] font-mono text-[9px] tracking-[0.03em]" style={{ color, borderColor: `color-mix(in oklab, ${color} 40%, transparent)`, background: `color-mix(in oklab, ${color} 14%, transparent)` }}>{children}</span>; }
export function Badge({ status, tip, children }: { readonly status?: string; readonly tip?: string; readonly children: ReactNode }) {
  const color = status ? `var(--color-status-${status})` : undefined;
  return <span data-tip={tip} className="inline-flex items-center gap-1 rounded-[3px] border border-border-strong px-1.5 py-px font-mono text-[10px] tracking-[0.03em] text-text-muted" style={color ? { color, borderColor: `color-mix(in oklab, ${color} 45%, transparent)` } : undefined}>{color && <span className="size-1.5 rounded-full" style={{ background: color }} />}{children}</span>;
}
export function KindDot({ kind }: { readonly kind: string }) { return <span data-tip={kind} className="size-2 shrink-0 rounded-full" style={{ background: KIND_COLORS[kind] ?? KIND_COLORS.any }} />; }
export function LiveDot({ state, tip }: { readonly state: "live" | "idle" | "failed"; readonly tip?: string }) { const color = state === "live" ? "var(--color-status-done)" : state === "failed" ? "var(--color-danger)" : "var(--color-text-faint)"; return <span data-tip={tip} className="size-[7px] shrink-0 rounded-full" style={{ background: color, boxShadow: state === "live" ? `0 0 5px color-mix(in oklab, ${color} 70%, transparent)` : undefined }} />; }
export function Avatar({ id, size = "sm" }: { readonly id: string; readonly size?: "sm" | "lg" }) { return <span aria-hidden className={`flex shrink-0 items-center justify-center font-mono font-bold text-[oklch(0.15_0.01_285)] ${size === "lg" ? "size-10 rounded-lg text-[17px]" : "size-[18px] rounded text-[10px]"}`} style={{ background: AVATAR_COLORS[colorSeed(id)] }}>{initials(id)}</span>; }

/** Tri-state capability marker: filled = supported, half = partial, dashed ring = unavailable. */
export function CapDot({ state, tip, size = 11 }: { readonly state: "full" | "part" | "none"; readonly tip: string; readonly size?: number }) {
  const radius = size / 2, tone = state === "full" ? "text-accent" : state === "part" ? "text-stale" : "text-text-faint";
  return <span data-tip={tip} className={`inline-flex shrink-0 items-center align-[-1px] ${tone}`}><svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
    {state === "full" ? <circle cx={radius} cy={radius} r={radius - 1.2} fill="currentColor" />
      : state === "part" ? <><path d={`M ${radius} 1.2 A ${radius - 1.2} ${radius - 1.2} 0 0 1 ${radius} ${size - 1.2} Z`} fill="currentColor" /><circle cx={radius} cy={radius} r={radius - 1.2} fill="none" stroke="currentColor" strokeWidth={1.2} /></>
      : <circle cx={radius} cy={radius} r={radius - 1.6} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="2 1.6" />}
  </svg></span>;
}

export function Btn({ variant = "plain", size = "md", type = "button", tip, testId, disabled, onClick, children }: { readonly variant?: "plain" | "primary" | "danger" | "ghost"; readonly size?: "sm" | "md"; readonly type?: "button" | "submit"; readonly tip?: string; readonly testId?: string; readonly disabled?: boolean; readonly onClick?: () => void; readonly children: ReactNode }) {
  const tone = variant === "primary" ? "border-transparent bg-accent font-semibold text-accent-fg hover:brightness-110" : variant === "danger" ? "border-danger/45 text-danger hover:bg-danger/10" : variant === "ghost" ? "border-transparent text-text-muted hover:border-border-strong" : "border-border-strong text-text hover:border-text-faint hover:bg-surface";
  return <button type={type} data-tip={tip} data-testid={testId} disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded border ${size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]"} ${tone} disabled:cursor-not-allowed disabled:opacity-45`}>{children}</button>;
}
export function AddChip({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) { return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded border border-dashed border-border-strong px-2 py-0.5 text-[11px] text-text-faint hover:border-accent hover:text-accent">{children}</button>; }
export function ChipZone({ children }: { readonly children: ReactNode }) { return <div className="flex flex-wrap items-center gap-1.5">{children}</div>; }
export function Empty({ children }: { readonly children: ReactNode }) { return <p className="py-1 text-[11px] text-text-faint">{children}</p>; }

export function SegCtl<T extends string>({ value, options, onChange, label }: { readonly value: T; readonly options: readonly { readonly value: T; readonly label: string; readonly tip?: string }[]; readonly onChange: (value: T) => void; readonly label?: string }) {
  return <span role="group" aria-label={label} className="inline-flex overflow-hidden rounded border border-border-strong">{options.map((option) => <button key={option.value} type="button" data-tip={option.tip} aria-pressed={option.value === value} onClick={() => onChange(option.value)} className={`px-2.5 py-0.5 text-[11px] ${option.value === value ? "bg-accent font-semibold text-accent-fg" : "text-text-muted hover:bg-surface"}`}>{option.label}</button>)}</span>;
}
export function Toggle({ checked, onChange, label }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-4 w-[30px] shrink-0 rounded-full border transition-colors ${checked ? "border-transparent bg-accent" : "border-border-strong bg-surface"}`}><span className={`absolute top-[2px] size-2.5 rounded-full transition-transform ${checked ? "translate-x-[16px] bg-accent-fg" : "translate-x-[2px] bg-text-faint"}`} /></button>;
}
export function CfgRow({ label, children }: { readonly label: string; readonly children: ReactNode }) { return <div className="mb-1.5 flex flex-wrap items-center gap-2.5"><span className="min-w-[118px] text-[11px] text-text-muted">{label}</span>{children}</div>; }
export function WarnBar({ children }: { readonly children: ReactNode }) { return <div className="mt-2 flex items-start gap-2 rounded border border-dashed border-stale/60 bg-stale/[0.07] px-2.5 py-[7px] text-[11px] leading-[1.45] text-text-muted">{children}</div>; }
export function PlannedBox({ children }: { readonly children: ReactNode }) { return <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 text-[11px] text-text-faint">{children}</div>; }
export function TextInput({ value, onChange, placeholder, mono = false, type = "text", label, disabled, testId }: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder?: string; readonly mono?: boolean; readonly type?: "text" | "password" | "number"; readonly label: string; readonly disabled?: boolean; readonly testId?: string }) {
  return <input type={type} aria-label={label} data-testid={testId} value={value} disabled={disabled} placeholder={placeholder} autoComplete={type === "password" ? "off" : undefined} spellCheck={type === "password" ? false : undefined} onChange={(event) => onChange(event.target.value)} className={`min-w-0 rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-text outline-none focus-visible:border-accent disabled:opacity-50 ${mono ? "font-mono text-[11px]" : ""}`} />;
}
export function Modal({ title, hint, wide = false, testId, footer, onClose, children }: { readonly title: string; readonly hint?: string; readonly wide?: boolean; readonly testId?: string; readonly footer: ReactNode; readonly onClose: () => void; readonly children: ReactNode }) {
  return <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId} className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"><div className={`flex max-h-[calc(100dvh-80px)] w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-2xl ${wide ? "max-w-[760px]" : "max-w-[640px]"}`}>
    <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5"><b className="text-[13px] font-[650]">{title}</b>{hint && <Hint>{hint}</Hint>}<button type="button" aria-label="close" onClick={onClose} className="ml-auto px-1 text-[15px] text-text-faint hover:text-text">✕</button></header>
    <div className="flex-1 overflow-y-auto px-3.5 py-3">{children}</div>
    <footer className="border-t border-border px-3.5 py-2.5">{footer}</footer>
  </div></div>;
}
