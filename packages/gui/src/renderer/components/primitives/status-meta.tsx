import type { SnapshotStatus } from "../../model/types";
import {
  Archive,
  CheckCircle,
  Circle,
  CircleHalf,
  CircleNotch,
  PaperPlaneTilt,
  PauseCircle,
  Question,
  XCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * 标签文案必须是读取时求值的 getter:spread 会把 getter 在模块导入那一刻固化成
 * 当期 locale 的字符串,运行时切换语言后所有标签仍显示导入时的语言(F-D3DBB3FB)。
 * 这里把 key 与静态字段合并成带活 getter 的条目,调用方不再自行 spread。
 */
export function localizedLabel<T extends object>(key: MessageKey, rest: T): T & { readonly label: string } {
  return {
    get label() {
      return t(key);
    },
    ...rest,
  };
}

// 状态→{label,color,icon} 的词表。放在 primitives 叶子层,StatusTag 与图例/画布/
// 筛选面板共用同一份颜色与文案,组件之间不互相 import。
export const STATUS_META: Record<SnapshotStatus, { label: string; color: string; icon: ReactNode }> = {
  planned: localizedLabel("components.badges.planned", {
    color: "var(--color-status-planned)",
    icon: <Circle weight="duotone" />,
  }),
  active: localizedLabel("components.badges.active", {
    color: "var(--color-status-active)",
    icon: <CircleNotch weight="bold" />,
  }),
  submitted: localizedLabel("components.badges.submitted", {
    color: "var(--color-status-submitted)",
    icon: <PaperPlaneTilt weight="duotone" />,
  }),
  blocked: localizedLabel("components.badges.blocked", {
    color: "var(--color-status-blocked)",
    icon: <PauseCircle weight="duotone" />,
  }),
  in_review: localizedLabel("components.badges.inReview", {
    color: "var(--color-status-in-review)",
    icon: <CircleHalf weight="duotone" />,
  }),
  done: localizedLabel("components.badges.done", {
    color: "var(--color-status-done)",
    icon: <CheckCircle weight="duotone" />,
  }),
  cancelled: localizedLabel("components.badges.cancelled", {
    color: "var(--color-status-cancelled)",
    icon: <XCircle weight="duotone" />,
  }),
  unknown: localizedLabel("components.badges.unknown", {
    color: "var(--color-status-unknown)",
    icon: <Question weight="bold" />,
  }),
  archived: localizedLabel("components.badges.archived", {
    color: "var(--color-status-archived)",
    icon: <Archive weight="duotone" />,
  }),
};
