import { PushPin, PushPinSlash } from "@phosphor-icons/react";

/** Shared presentation; callers retain ownership of pin commands and concurrency. */
export function PinButton({
  pinned,
  onClick,
  testId,
  label,
}: {
  readonly pinned: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly label?: string;
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
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border px-2 py-1 ui-meta text-text hover:border-accent hover:text-accent"
    >
      <Icon weight="bold" aria-hidden />
      {text}
    </button>
  );
}
