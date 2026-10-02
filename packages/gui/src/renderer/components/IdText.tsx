import { REF_LAYOUT_STYLE, REF_TYPOGRAPHY } from "./EntityRefLink.tsx";

/**
 * 没有导航落点的长值展示叶(标准 §4.1):哈希、路径、本页自引用的 ID 等。
 *
 * 与 EntityRefLink 共用同一份排版(REF_TYPOGRAPHY)与截断布局(REF_LAYOUT_STYLE
 * 内联样式),不建第二套实体展示体系;区别只在语义——这里没有可激活路径,渲染成
 * 原生文本。超宽 truncate 省略、不 break、不撑列;悬停 title 给完整值,自定义
 * title 只作前缀、完整值始终可达。class 叠加抹不掉截断(内联样式优先级)。
 *
 * 复制不在这里:详情场景的完整值复制放行/卡片的动作位(如 CopyContextButton),
 * 不在文字上叠按钮(标准 §4.1)。
 */
export function IdText({
  value,
  title,
  className,
}: {
  /** 完整原值;显示与 title 都基于它,调用方不做预截断。 */
  readonly value: string;
  /** 悬停前缀(人话说明等);完整值始终拼在后面,不因它丢失。 */
  readonly title?: string;
  className?: string;
}) {
  return (
    <span
      title={title === undefined || title === value ? value : `${title} · ${value}`}
      className={`${REF_TYPOGRAPHY} ${className ?? "text-text-faint"}`}
      style={REF_LAYOUT_STYLE}
    >
      {value}
    </span>
  );
}
