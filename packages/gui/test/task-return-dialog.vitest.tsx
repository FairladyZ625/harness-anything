// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { TaskReturnDialog } from "../src/renderer/components/taskDetail/TaskReturnDialog.tsx";

test("return requires feedback and an explicit mode, with cancellation available", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"),
    root = createRoot(host),
    onReturn = vi.fn(),
    onClose = vi.fn();
  document.body.append(host);
  await act(async () => root.render(<TaskReturnDialog onClose={onClose} onReturn={onReturn} />));
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
