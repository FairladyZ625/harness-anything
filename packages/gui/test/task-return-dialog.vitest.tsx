// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { TaskReturnDialog } from "../src/renderer/components/taskDetail/TaskReturnDialog.tsx";
import type { DiffFile } from "../src/renderer/components/agent-ui/AnnotateDiffViewer.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

test("return requires feedback and an explicit mode, with cancellation available", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"),
    root = createRoot(host),
    onReturn = vi.fn(),
    onClose = vi.fn();
  document.body.append(host);
  await act(async () => root.render(<TaskReturnDialog open onClose={onClose} onReturn={onReturn} />));
  try {
    const resume = host.querySelector<HTMLButtonElement>('[data-testid="task-return-resume"]')!,
      fresh = host.querySelector<HTMLButtonElement>('[data-testid="task-return-fresh"]')!,
      textarea = host.querySelector("textarea")!;
    expect(resume.disabled).toBe(true);
    expect(fresh.disabled).toBe(true);
    expect(onReturn).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, " Fix the parser. ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => resume.click());
    expect(onReturn).toHaveBeenLastCalledWith("resume", "Fix the parser.");
    await act(async () => fresh.click());
    expect(onReturn).toHaveBeenLastCalledWith("fresh", "Fix the parser.");
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("stashes 3 diff annotations and batch sends into task return feedback", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  const host = document.createElement("div"),
    root = createRoot(host),
    onReturn = vi.fn(),
    onClose = vi.fn();
  document.body.append(host);
  const diffFiles: readonly DiffFile[] = [
    {
      filePath: "src/renderer/App.tsx",
      lines: [
        { kind: "context", oldLineNo: 1, newLineNo: 1, text: "import React from 'react';" },
        { kind: "remove", oldLineNo: 2, text: "-const config = load();" },
        { kind: "add", newLineNo: 2, text: "+const config = loadConfig();" },
        { kind: "add", newLineNo: 3, text: "+const port = 8080;" },
        { kind: "add", newLineNo: 4, text: "+export default App;" },
      ],
    },
  ];

  await act(async () =>
    root.render(<TaskReturnDialog open onClose={onClose} onReturn={onReturn} diffFiles={diffFiles} />),
  );
  try {
    const resume = host.querySelector<HTMLButtonElement>('[data-testid="task-return-resume"]')!,
      textarea = host.querySelector("textarea")!;
    expect(resume.disabled).toBe(true);

    const addDraft = async (testId: string, note: string) => {
      const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
      await act(async () => button.click());
      const input = host.querySelector<HTMLTextAreaElement>('[data-testid="annotate-composer-text"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, note);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = host.querySelector<HTMLButtonElement>('[data-testid="annotate-composer-save"]')!;
      await act(async () => submit.click());
    };

    // 1. Add 3 annotations on 3 different lines
    await addDraft("annotate-add-new-2", "第一条意见: 添加配置校验");
    await addDraft("annotate-add-new-3", "第二条意见: 端口应支持从环境变量读取");
    await addDraft("annotate-add-new-4", "第三条意见: 补充单元测试");

    expect(host.querySelector('[data-testid="annotate-pending-count"]')!.textContent).toBe("3");

    // 2. Click batch send
    const batchSendButton = host.querySelector<HTMLButtonElement>('[data-testid="annotate-send"]')!;
    await act(async () => batchSendButton.click());

    // 3. Verify textarea got the structured prompt
    expect(textarea.value).toContain("请按以下 3 条批注一次性完成修订");
    expect(textarea.value).toContain("第一条意见: 添加配置校验");
    expect(textarea.value).toContain("第二条意见: 端口应支持从环境变量读取");
    expect(textarea.value).toContain("第三条意见: 补充单元测试");

    // 4. Submit return with resume
    expect(resume.disabled).toBe(false);
    await act(async () => resume.click());
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledWith("resume", textarea.value);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
