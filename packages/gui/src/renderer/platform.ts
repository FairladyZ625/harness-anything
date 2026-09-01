/** macOS 用 ⌘ 作主修饰键,其余平台用 Ctrl;快捷键表与提示文案都按这一判断分叉。 */
export function isMacPlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /^Mac/u.test(nav.platform) || /Macintosh/u.test(nav.userAgent);
}
