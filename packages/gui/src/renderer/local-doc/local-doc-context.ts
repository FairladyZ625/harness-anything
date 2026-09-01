import { createContext, useContext } from "react";

/**
 * 「GUI 内读本机文档」的打开入口上下文(task_89d324b5)。
 *
 * Markdown 锚点组件(MarkdownAnchor)与本机文档浮层(LocalDocLayer)之间唯一的耦合面:
 * 锚点把 local-file 路径交给 openLocalDocument,浮层负责读取与展示。context 单独成
 * 模块是为了不引入 DocReader → 浮层 → DocReader 的模块环(浮层复用 DocReader 渲染)。
 * 缺省值是 no-op:宿主没挂 LocalDocLayer 时链接不炸,只是不开浮层(单测可不包 provider)。
 */
export interface LocalDocOpener {
  readonly openLocalDocument: (path: string) => void;
}

export const LocalDocContext = createContext<LocalDocOpener>({ openLocalDocument: () => {} });

export function useLocalDocOpener(): LocalDocOpener {
  return useContext(LocalDocContext);
}
