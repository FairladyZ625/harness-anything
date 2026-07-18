import assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("harness-anything.harness-anything-vscode");
  assert.ok(extension, "packaged extension is discoverable by the Extension Host");
  await extension.activate();
  assert.equal(extension.isActive, true);
}
