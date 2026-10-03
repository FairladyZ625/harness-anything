import type { ReactNode } from "react";

// Visual primitives for the Agent Runtime configuration plane. Every shape here is a
// direct transcription of the design prototype (card / sect / chip / badge / field grid /
// segmented control / switch / avatar / dots), so the surfaces below stay declarative and
// no view re-invents a border radius.

// Avatar 身份色已入 @theme token(--color-avatar-*,两主题成对,C13):
// 组件不再持有 oklch 字面色,亮色主题跟随。
export const AVATAR_COLORS = [
  "var(--color-avatar-1)",
  "var(--color-avatar-2)",
  "var(--color-avatar-3)",
  "var(--color-avatar-4)",
  "var(--color-avatar-5)",
  "var(--color-avatar-6)",
] as const;
export const KIND_COLORS: Record<string, string> = {
  codex: "var(--color-status-in-review)",
  claude: "var(--color-status-active)",
  agy: "var(--color-status-done)",
  any: "var(--color-status-planned)",
};
export const initials = (id: string): string =>
  id
    .replace(/[-_]/gu, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "··";
export const colorSeed = (id: string): number =>
  [...id].reduce((total, character) => total + character.charCodeAt(0), 0) % AVATAR_COLORS.length;

export function Crumbs({ children }: { readonly children: ReactNode }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-1.5 ui-micro text-text-faint">{children}</div>;
}
export function CrumbSep() {
  return <span className="text-border-strong">/</span>;
}

export function Card({
  dashed = false,
  testId,
  children,
}: {
  readonly dashed?: boolean;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className={`mb-3 rounded-lg border bg-surface-raised ${dashed ? "border-dashed border-text-faint/60" : "border-border"}`}
    >
      {children}
    </section>
  );
}
export function CardHead({ children }: { readonly children: ReactNode }) {
  return <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">{children}</header>;
}
export function CardTitle({ children }: { readonly children: ReactNode }) {
  return <b className="ui-meta font-[650] tracking-[0.01em] text-text">{children}</b>;
}
export function Hint({ children }: { readonly children: ReactNode }) {
  return <span className="ui-micro text-text-faint">{children}</span>;
}
export function Right({ children }: { readonly children: ReactNode }) {
  return <span className="ml-auto flex items-center gap-2">{children}</span>;
}
export function CardBody({ children }: { readonly children: ReactNode }) {
  return <div className="px-3 py-2.5">{children}</div>;
}

export function Sect({
  title,
  desc,
  right,
  children,
}: {
  readonly title: string;
  readonly desc?: string;
  readonly right?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t border-border first:border-t-0">
      <header className="flex flex-wrap items-center gap-2 px-3.5 pt-2 pb-0.5">
        <b className="ui-micro font-bold uppercase tracking-[0.08em] text-text-muted">{title}</b>
        {desc && <span className="ui-micro text-text-faint">{desc}</span>}
        {right && <span className="ml-auto flex items-center gap-2 ui-micro text-text-faint">{right}</span>}
      </header>
      <div className="px-3.5 pt-2 pb-3">{children}</div>
    </section>
  );
}

// 只读字段/键值(FieldGrid/Field/KV/KVRow)已迁入 primitives/Fields.tsx(C9):
// 详情字段是跨域共享契约,不随 runtime 第二库生长。

// 可交互 Chip 已迁入 primitives/Chip.tsx(C8):点击/链接/删除贴片是跨域契约;
// AddChip/ChipZone 是 runtime 配置面的伴生形状,留在此域。

export function KindDot({ kind }: { readonly kind: string }) {
  return (
    <span
      data-tip={kind}
      className="size-2 shrink-0 rounded-full"
      style={{ background: KIND_COLORS[kind] ?? KIND_COLORS.any }}
    />
  );
}
export function LiveDot({ state, tip }: { readonly state: "live" | "idle" | "failed"; readonly tip?: string }) {
  const color =
    state === "live"
      ? "var(--color-status-done)"
      : state === "failed"
        ? "var(--color-danger)"
        : "var(--color-text-faint)";
  return (
    <span
      data-tip={tip}
      className="size-[7px] shrink-0 rounded-full"
      style={{
        background: color,
        boxShadow: state === "live" ? `0 0 5px color-mix(in oklab, ${color} 70%, transparent)` : undefined,
      }}
    />
  );
}
export function Avatar({ id, size = "sm" }: { readonly id: string; readonly size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-mono font-bold text-avatar-fg ${size === "lg" ? "size-10 rounded-lg ui-title" : "size-[18px] rounded ui-micro"}`}
      style={{ background: AVATAR_COLORS[colorSeed(id)] }}
    >
      {initials(id)}
    </span>
  );
}

/** Tri-state capability marker: filled = supported, half = partial, dashed ring = unavailable. */
export function CapDot({
  state,
  tip,
  size = 11,
}: {
  readonly state: "full" | "part" | "none";
  readonly tip: string;
  readonly size?: number;
}) {
  const radius = size / 2,
    tone = state === "full" ? "text-accent" : state === "part" ? "text-stale" : "text-text-faint";
  return (
    <span data-tip={tip} className={`inline-flex shrink-0 items-center align-[-1px] ${tone}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {state === "full" ? (
          <circle cx={radius} cy={radius} r={radius - 1.2} fill="currentColor" />
        ) : state === "part" ? (
          <>
            <path
              d={`M ${radius} 1.2 A ${radius - 1.2} ${radius - 1.2} 0 0 1 ${radius} ${size - 1.2} Z`}
              fill="currentColor"
            />
            <circle cx={radius} cy={radius} r={radius - 1.2} fill="none" stroke="currentColor" strokeWidth={1.2} />
          </>
        ) : (
          <circle
            cx={radius}
            cy={radius}
            r={radius - 1.6}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeDasharray="2 1.6"
          />
        )}
      </svg>
    </span>
  );
}

export function AddChip({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-dashed border-border-strong px-2 py-0.5 ui-micro text-text-faint hover:border-accent hover:text-accent"
    >
      {children}
    </button>
  );
}
export function ChipZone({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}
export function CfgRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
      <span className="min-w-[118px] ui-micro text-text-muted">{label}</span>
      {children}
    </div>
  );
}
export function PlannedBox({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-text-faint/55 px-2.5 py-2 ui-micro text-text-faint">
      {children}
    </div>
  );
}
