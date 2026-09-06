import { FilePdf } from "@phosphor-icons/react";

/**
 * PDF locator 的事实卡(task_a494eac2 Goal 2)。
 *
 * 「用内置查看器渲染 PDF」当前做不到,而且不是渲染层缺一个组件:GUI↔daemon 协议里
 * 没有任何字节通道,locator 读面对二进制文件一律返回 `binary` 且不载正文;「在系统中
 * 打开」那条 IPC 也只收 `tasks/<pkg>/artifacts/` 下的 html/md。要内置 PDF 查看器,
 * 前置是 daemon 侧新增二进制读面(或等宽的产物通道)——那不在本任务的可改面里。
 * 在通道落地之前,这张卡如实说明缺口,不假装能渲染。
 */
export function PdfLocatorCard({ path }: { readonly path: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6" data-testid="entity-locator-pdf">
      <FilePdf className="text-text-faint" size={28} />
      <p className="break-all font-mono ui-micro text-text-muted">{path}</p>
      <p className="max-w-md text-center ui-meta leading-relaxed text-text-faint">
        PDF 正文需要字节读面;GUI 现有 locator 读面对二进制文件不载正文,协议里也没有字节通道,
        所以内置查看器暂不可用——这是已上报的能力缺口,不是这个文件的问题。
      </p>
    </div>
  );
}
