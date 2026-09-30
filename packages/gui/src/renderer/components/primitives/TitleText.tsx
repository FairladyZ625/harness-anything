/**
 * 标题两段渲染(标准 §1「先回答问题,再给数据」):标题只写一个重点,按第一个全角/半角
 * 冒号拆成重点与补充——重点继承所在行的字色,补充(含冒号)用弱色并随行截断。冒号前
 * 不足 4 个字符视作没有可拆的重点,整条按原文渲染。总览、工作列表、工作详情的标题
 * 都经这里,不在各页各写一套。
 */
export function splitTitleFocus(title: string): { readonly focus: string; readonly supplement: string | null } {
  const half = title.indexOf(":"),
    full = title.indexOf("："),
    at = half < 0 ? full : full < 0 ? half : Math.min(half, full);
  if (at < 0) return { focus: title, supplement: null };
  const focus = title.slice(0, at);
  if ([...focus].length < 4) return { focus: title, supplement: null };
  return { focus, supplement: title.slice(at) };
}

/** 布局中立:不自带块级结构与字号,只把补充段染弱,放进调用方已有的标题槽位。 */
export function TitleText({ title }: { readonly title: string }) {
  const { focus, supplement } = splitTitleFocus(title);
  return (
    <>
      {focus}
      {supplement === null ? null : <span className="text-text-faint">{supplement}</span>}
    </>
  );
}
