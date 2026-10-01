/** macOS 用 ⌘ 作主修饰键,其余平台用 Ctrl;快捷键表与提示文案都按这一判断分叉。 */
export function isMacPlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /^Mac/u.test(nav.platform) || /Macintosh/u.test(nav.userAgent);
}

/**
 * 窗口 chrome 的平台分叉只有这一个判断点(task_e2786fc223f0a039317cc649d2):main.tsx
 * 启动时调用一次,给 <html> 打 data-platform;顶行拖拽区与红绿灯留白全部由 styles.css
 * 按 html[data-platform="mac"] 生效,组件里不再各自判断平台。
 */
export function applyWindowChromePlatformMarker(
  doc: Pick<Document, "documentElement"> = document,
  nav: Pick<Navigator, "platform" | "userAgent"> = navigator,
): void {
  const mac = isMacPlatform(nav);
  doc.documentElement.dataset.platform = mac ? "mac" : "other";
  if (!mac) {
    // 重复调用不残留 mac 的内联留白(否则非 mac 平台会带上一次的值)。
    doc.documentElement.style.removeProperty("--titlebar-top-inset");
    return;
  }
  // hiddenInset 下系统红绿灯的实测几何(macOS 27,物理点):组右缘 80、圆心 y 21、
  // 圆底 27.5。侧栏顶行在红绿灯下方让出一条带(其下 8pt 呼吸位)。CSS px 与物理点
  // 的换算随窗口缩放变(本机 1 CSS px = 1.2pt),留白必须按比率换算,固定 px 会在
  // 别的缩放下压线。
  const ptPerCssPx = window.outerWidth / window.innerWidth;
  doc.documentElement.style.setProperty("--titlebar-top-inset", `${Math.ceil((27.5 + 8) / ptPerCssPx)}px`);
}
