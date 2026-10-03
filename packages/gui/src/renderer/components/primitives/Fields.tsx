import type { ReactNode } from "react";

/**
 * 只读字段契约(标准 §2.5,C9):详情卡与记录区里「标签 + 值」的两种密度——
 * - FieldGrid/Field:多列自适应网格里的字段块(标签上、值下),长值词内换行;
 * - KV/KVRow:紧凑两列键值表(键 nowrap 等宽、值 anywere 换行)。
 * 表单输入行(设置页 label 上/控件下的 Row)与 runtime 配置行(CfgRow)是
 * 各自平面的布局行,不在此组件里合并;值被收束/截断时原始串放 title 悬停
 * (视觉基线 v2:机器编号不当主文字)。
 */
export function FieldGrid({ children }: { readonly children: ReactNode }) {
  return <dl className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-2">{children}</dl>;
}
export function Field({
  label,
  value,
  mono = true,
  faint = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly faint?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 font-mono ui-micro uppercase tracking-[0.08em] text-text-faint">{label}</dt>
      <dd
        className={`[overflow-wrap:anywhere] ${mono ? "font-mono ui-micro" : "ui-meta"} ${faint ? "text-text-faint" : "text-text"}`}
      >
        {value}
      </dd>
    </div>
  );
}
export function KV({ children }: { readonly children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-[3px] ui-micro">{children}</dl>;
}
export function KVRow({
  name,
  title,
  children,
}: {
  readonly name: ReactNode;
  /** 值被收束/截断时,原始串放悬停(视觉基线 v2:机器编号不当主文字)。 */
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="whitespace-nowrap font-mono ui-micro text-text-faint">{name}</dt>
      <dd title={title} className="[overflow-wrap:anywhere] text-text">
        {children}
      </dd>
    </>
  );
}
