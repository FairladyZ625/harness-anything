# @harness-anything/gui

Harness Anything GUI foundation package.

This package is the local desktop controller surface for KR-09. It defines the
Electron window security contract, preload API allowlist, localhost API guards,
renderer view model, document sanitization, and shell panel boundary.

The GUI is not an agent runtime control plane. Shell output is display-only and
never becomes task state implicitly.

Electron Harness client package. GUI and CLI share the same Controller/Service
layer; GUI does not parse or control agent runtime sessions.

## Launch

Run `ha gui` from the repository to open, or pass `ha gui --root <path>`. This
is the only production launch entry: the CLI builds the renderer and preload,
acquires the default daemon through its canonical autostart path, and detaches
Electron. The Electron process is attach-only; it never starts, restarts, or
stops the daemon.

`npm run dev:electron` remains package-local for contributor hot reload. It
does not fast-forward Git and is not a production entry.

## Distribution Status

Version 0.0.1 retains packaging checks for the macOS Local candidate, but the
unsigned DMG is not a supported launch surface. Signing, notarization,
auto-update, and direct packaged-app launch remain unshipped capabilities.

The policy separates:

- desktop app distribution for macOS, Windows, and Linux;
- local daemon install/update behavior across macOS, Windows, and Linux;
- remote daemon bootstrap/update over the existing system SSH tunnel and daemon
  API contract.

The unsigned candidate is installed manually with the documented macOS
right-click Open flow. It is not a claim of signed production distribution.

## Component catalog

For contributor previews, run `npm run dev -w @harness-anything/gui` and open
`/component-catalog.html` on the printed local Vite URL. This separate development
entry imports the real primitives and uses synthetic data; it does not invoke
daemon mutations or appear in production navigation. Theme, motion preference,
container width, list selection, tabs and entity-reference callbacks are interactive.

Add examples here when a shared component contract changes. Keep behavior in the
component, not a second implementation in the catalog. Electron automation should
use its default hidden window and an isolated profile; only use visible windows
when a person explicitly requests a demonstration.

开发者可运行上述命令并打开 `/component-catalog.html`。目录直接复用真实组件，以示例数据
检查主题、动效、窄容器、键盘与状态，不写 daemon。共享契约变化时同步例子，不能在目录里
复制第二套实现；自动化验证保持 Electron 隐藏与独立 profile。

## Workbench panel composition

The panel workbench (面板工作台) composes every real App route as floating panels.
The route coverage table and the mounting contract live in the
`src/renderer/panel-workspace/workbench-panels.tsx` module doc: a view gains a
`renderHeader` slot, a panel wrapper under `panel-workspace/panels/` reuses the
feature body, and `WORKBENCH_PANEL_CATALOG` registers the identity. Detail panels
select entities through `PanelEntityPicker` locally; terminal and browser panels
reuse the page adapters so closing a panel detaches or destroys exactly what the
page would. Follow that path for new pages instead of mounting a second shell.

GUI implementation guidance: [harness-gui skill](../../skills/harness-gui/SKILL.md). GUI agents and the `gui-development` preset use this shared contract.

GUI 开发指引：[harness-gui skill](../../skills/harness-gui/SKILL.md)。GUI Agent 与 `gui-development` preset 复用此契约。
