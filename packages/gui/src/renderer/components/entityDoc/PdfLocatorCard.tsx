import { FilePdf } from "@phosphor-icons/react";

/**
 * PDF 的事实卡(task_a494eac2 Goal 2)。
 *
 * 「用内置查看器渲染 PDF」当前做不到,而且不是渲染层缺一个组件:GUI↔daemon 协议里没有
 * 任何字节通道,两条读面——`repo.entity.locator.read` 与 `repo.entity.content.read`——对
 * 二进制一律返回 `binary` 且 `content: null`;「在系统中打开」那条 IPC 也只收
 * `tasks/<pkg>/artifacts/` 下的 html/md。要内置 PDF 查看器,前置是协议上新增一条二进制
 * 读面,那不在渲染层的可改面里。在通道落地之前,这张卡如实说明,不假装能渲染。
 */
export function PdfLocatorCard({ path }: { readonly path: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6" data-testid="entity-locator-pdf">
      <FilePdf className="text-text-faint" size={28} />
      <p className="break-all font-mono ui-micro text-text-muted">{path}</p>
      <p className="max-w-md text-center ui-meta leading-relaxed text-text-faint">
        PDF 还不能在应用内打开——阅读面只取得到文本。文件本身完好,按上面的路径在系统里打开即可。
      </p>
    </div>
  );
}
