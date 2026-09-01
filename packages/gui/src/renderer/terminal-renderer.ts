/**
 * WebGL 是可选 renderer：W4b 的性能结果会决定是否把此偏好写为 enabled。
 * 未设置时保持 xterm 的 DOM renderer，避免将 GPU 成本默认为所有 pane 的前提。
 */
export const terminalWebglStorageKey = "harness-terminal-webgl";

export function terminalWebglEnabled(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(terminalWebglStorageKey) === "enabled";
}

export function terminalTheme(theme: "dark" | "light") {
  return theme === "light"
    ? {
        background: "#fcfcfd",
        foreground: "#36363a",
        cursor: "#157783",
        selectionBackground: "#b7e0e5",
      }
    : {
        background: "#1d1d20",
        foreground: "#e8e7ea",
        cursor: "#74d4dd",
        selectionBackground: "#365d69",
      };
}
