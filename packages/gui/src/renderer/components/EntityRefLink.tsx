import type { ReactNode } from "react";

/**
 * 实体互链不变量(清册 G-10)的唯一被批准渲染出口。
 *
 * 不变量:页面显示的实体 ID 必须是通往该实体的可激活路径。凡要把一个实体
 * 引用(task/<id>、decision/<id>、fact/<id>、agent/<id>、squad/<id>、
 * provider/<id>、session/<id>)渲染到页面上,一律走本组件;onNavigate 必填 ——
 * 没有回调就没有「路」,本组件不允许退化成死文本(由 G37 entity-id-links 审计)。
 *
 * 消费方接线:视图层从 App 拿 navigateToEntity / navigateToTask /
 * selectRuntimeEntity 等回调并下钻;自引用(实体详情页显示自己的 ID)导航为
 * no-op(导航栈对等价位置不推栈),可安全使用。
 */
export function EntityRefLink({
  entityRef,
  onNavigate,
  children,
  title,
  className,
}: {
  /** canonical 实体引用;kind 见 navigation/entityRoutes.ts 的可寻址七类。 */
  entityRef: string;
  /** 点击后的导航出口;必填,不提供回调就没有路径。 */
  onNavigate: (ref: string) => void;
  /** 覆盖默认显示文本(默认显示 entityRef 原文)。 */
  children?: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(entityRef)}
      title={title ?? entityRef}
      className={className ?? "font-mono text-[11px] text-accent hover:underline"}
    >
      {children ?? entityRef}
    </button>
  );
}

/** kind + 裸 ID(+ decision anchor)→ canonical 引用。Facts use their own ID and never take an owner segment. */
export function entityRefOf(kind: "fact", id: string): string;
export function entityRefOf(
  kind: "task" | "decision" | "agent" | "squad" | "provider" | "session",
  id: string,
  anchor?: string,
): string;
export function entityRefOf(kind: string, id: string, anchor?: string): string {
  return anchor === undefined ? `${kind}/${id}` : `${kind}/${id}/${anchor}`;
}
