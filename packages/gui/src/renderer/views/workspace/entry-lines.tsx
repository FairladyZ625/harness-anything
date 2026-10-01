import { Fragment, type ReactNode } from "react";
import { splitTitleFocus } from "../../components/primitives/TitleText.tsx";
import type { BlockingContributor } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 工作页两行条目的共用拼装(标准 §2.4:第一行状态 + 标题,元信息放第二行弱色):
 * 标题按冒号拆成第一行的重点与第二行末尾的补充;第二行由调用方给的若干段拼成,
 * 空段不占位。行高与字号仍只在 DenseRow 里定,这里不碰版式。
 */

/** 搜索命中片段的高亮:命不中都原样返回,不猜大小写。 */
export function highlightText(text: string, needle: string): ReactNode {
  if (needle === "") return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <span data-search-hit className="rounded-[1px] bg-status-submitted/35">
        {text.slice(index, index + needle.length)}
      </span>
      {text.slice(index + needle.length)}
    </>
  );
}

/** 标题拆两行:focus 进第一行;冒号后的补充去掉冒号进第二行,没有补充就是 undefined。 */
export function entryTitle(
  title: string,
  needle = "",
): { readonly focus: ReactNode; readonly supplement: ReactNode | undefined } {
  const { focus, supplement } = splitTitleFocus(title),
    rest = supplement?.replace(/^[:：]\s*/u, "") ?? "";
  return {
    focus: highlightText(focus, needle),
    supplement: rest === "" ? undefined : highlightText(rest, needle),
  };
}

/** 第二行:非空段用「 · 」串起;全空返回 undefined(由 DenseRow 决定不渲染第二行)。 */
export function metaLine(parts: readonly ReactNode[]): ReactNode | undefined {
  const present = parts.filter((part) => part !== undefined && part !== null && part !== false && part !== "");
  if (present.length === 0) return undefined;
  return present.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? " · " : null}
      {part}
    </Fragment>
  ));
}

/**
 * 卡点或等待原因:取读面给的第一条阻塞贡献(awaits 边报等谁、问了什么;depends-on 边报
 * 被哪个任务卡住),多于一条时带上其余条数。没有阻塞贡献返回 undefined,不编原因。
 */
export function waitingReason(
  blockers: readonly BlockingContributor[] | undefined,
  titleOf: (taskId: string) => string | undefined,
): string | undefined {
  const first = blockers?.[0];
  if (blockers === undefined || first === undefined) return undefined;
  const reason =
    first.kind === "awaits"
      ? t("views.workspace.wait.awaits", { person: first.personId, question: first.question })
      : t("views.workspace.wait.dependsOn", {
          title: splitTitleFocus(titleOf(first.targetTaskId) ?? first.targetTaskId).focus,
        });
  return blockers.length > 1 ? t("views.workspace.wait.more", { reason, count: blockers.length - 1 }) : reason;
}
