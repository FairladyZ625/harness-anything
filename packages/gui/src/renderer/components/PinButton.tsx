import { PushPin, PushPinSlash } from "@phosphor-icons/react";

/**
 * Shared presentation; callers retain ownership of pin commands and concurrency.
 * 可发现性来自边框加正文对比度,不是那两个字——所以侧栏这种窄容器用 compact 去掉文字,
 * 标题才留得下,而按钮仍然看得见(此前的缺陷是 24px 淡色无边框图标)。
 */
export function PinButton({
  pinned,
  onClick,
  testId,
  label,
  compact = false,
}: {
  readonly pinned: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly label?: string;
  readonly compact?: boolean;
}) {
  const Icon = pinned ? PushPinSlash : PushPin;
  const text = pinned ? "解除置顶" : "置顶";
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-pressed={pinned}
      aria-label={label ?? text}
      title={text}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border ui-meta text-text hover:border-accent hover:text-accent
        ${compact ? "p-1" : "px-2 py-1"}`}
    >
      <Icon weight="bold" aria-hidden />
      {compact ? null : text}
    </button>
  );
}
