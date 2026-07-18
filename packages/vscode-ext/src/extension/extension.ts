import * as vscode from "vscode";
import { disposeExtensionResources } from "./lifecycle.ts";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("harnessAnything.refresh", () => undefined));
}

export async function deactivate(): Promise<void> {
  // Connection ownership is wired by the W-D3 composition root. Deactivation
  // disposes clients; it never terminates daemon-owned terminal sessions.
  await disposeExtensionResources();
}
