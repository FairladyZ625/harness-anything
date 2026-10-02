// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BinaryDocumentPreview } from "../src/renderer/components/BinaryDocumentPreview.tsx";
import { BinaryArtifactPanel } from "../src/renderer/components/BinaryArtifactPanel.tsx";
const loaders = vi.hoisted(() => ({ pdf: vi.fn(), docx: vi.fn(), open: vi.fn() }));
vi.mock("../src/renderer/artifact-open-client.ts", () => ({ openArtifactExternally: loaders.open }));
vi.mock("pdfjs-dist", () => ({ getDocument: loaders.pdf, GlobalWorkerOptions: {} }));
vi.mock("docx-preview", () => ({ renderAsync: loaders.docx }));
let host: HTMLDivElement;
let root: Root;
const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  loaders.pdf.mockReset();
  loaders.docx.mockReset();
  loaders.open.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function show(mediaType: string, bytes: string) {
  await act(async () => root.render(<BinaryDocumentPreview path="same-file" mediaType={mediaType} bytes={bytes} />));
}
it("recovers from a rejected PDF when bytes change without remounting the file", async () => {
  const destroy = vi.fn(async () => {});
  loaders.pdf.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("Invalid PDF")), destroy }));
  await show("application/pdf", "YQ==");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid PDF");
  loaders.pdf.mockImplementationOnce(() => ({
    destroy,
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      }),
    }),
  }));
  await show("application/pdf", "Yg==");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelectorAll("canvas")).toHaveLength(1);
  expect(destroy).toHaveBeenCalledTimes(1);
});
it("recovers from a rejected DOCX on the next content revision", async () => {
  loaders.docx.mockRejectedValueOnce(new Error("Invalid DOCX"));
  await show(docxType, "YQ==");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid DOCX");
  loaders.docx.mockImplementationOnce(async (_bytes: Uint8Array, body: HTMLElement) => {
    body.textContent = "Readable document";
  });
  await show(docxType, "Yg==");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Readable document");
});
it("does not let an older DOCX render replace the current document", async () => {
  let finishOld!: () => void;
  loaders.docx.mockImplementationOnce(
    (_bytes: Uint8Array, body: HTMLElement) =>
      new Promise<void>((resolve) => {
        finishOld = () => {
          body.textContent = "Obsolete document";
          resolve();
        };
      }),
  );
  await show(docxType, "YQ==");
  loaders.docx.mockImplementationOnce(async (_bytes: Uint8Array, body: HTMLElement) => {
    body.textContent = "Current document";
  });
  await show(docxType, "Yg==");
  await act(async () => finishOld());
  expect(host.textContent).toContain("Current document");
  expect(host.textContent).not.toContain("Obsolete document");
});

it("keeps the original-file action reachable when an inline PDF cannot be parsed", async () => {
  loaders.pdf.mockImplementationOnce(() => ({
    promise: Promise.reject(new Error("Invalid PDF")),
    destroy: vi.fn(async () => {}),
  }));
  loaders.open.mockResolvedValue({ error: null });
  await act(async () =>
    root.render(
      <BinaryArtifactPanel
        repoId="remote-repo"
        taskId="task-one"
        path="artifacts/broken.pdf"
        packagePath="tasks/task-one"
        read={
          {
            bytes: "YQ==",
            mediaType: "application/pdf",
            size: 1,
            blobSha256: null,
            repositoryPath: "tasks/task-one/artifacts/broken.pdf",
          } as never
        }
      />,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid PDF");
  const open = host.querySelector<HTMLButtonElement>('[data-testid="task-document-binary-open"]')!;
  expect(open.disabled).toBe(false);
  await act(async () => open.click());
  expect(loaders.open).toHaveBeenCalledWith({
    repoId: "remote-repo",
    taskId: "task-one",
    path: "tasks/task-one/artifacts/broken.pdf",
  });
});
