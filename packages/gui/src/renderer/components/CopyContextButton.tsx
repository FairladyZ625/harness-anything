import { useState, useCallback } from "react";
import { Clipboard, Check } from "@phosphor-icons/react";

/**
 * 一键复制上下文按钮(W2B §3)。
 *
 * 把 agent 继续干活所需的一整串信息(task/decision/fact ID + 摘要 + 当前问题)
 * 复制到剪贴板,人自己起 coding agent 粘贴。
 *
 * rejected 红线:不注入终端/不预填命令——只复制纯文本到剪贴板。
 */
export function CopyContextButton({
  buildText,
  label = "复制上下文",
  compact = false,
}: {
  /** 惰性构造:点击时才算上下文文本(避免每帧重算) */
  buildText: () => string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const text = buildText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 降级:clipboard API 不可用时(无 secure context)用 execCommand 兜底
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        // 静默失败:不阻塞交互
      }
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [buildText]);

  return (
    <button
      onClick={onCopy}
      title={copied ? "已复制到剪贴板" : "复制 agent 可用的上下文包(粘贴给你自己的 coding agent)"}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
        copied
          ? "border-success/40 bg-success/10 text-success"
          : "border-border bg-surface-raised text-text-muted hover:border-border-strong hover:text-text"
      }`}
    >
      {copied ? <Check weight="bold" className="text-[12px]" /> : <Clipboard weight="bold" className="text-[12px]" />}
      {compact ? (copied ? "已复制" : label) : copied ? "已复制" : label}
    </button>
  );
}
