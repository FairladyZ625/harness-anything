import assert from "node:assert/strict";
import test from "node:test";
import { readKernelSourceFiles } from "../helpers/source-files.ts";

const oldRuntimePath = ["scripts", "kernel", "task"].join("/");
const oldBindingName = ["Task", "Binding"].join("");

test("kernel source does not import or reference the old task runtime", async () => {
  const files = await readKernelSourceFiles();

  for (const file of files) {
    assert.equal(file.text.includes(oldRuntimePath), false, `${file.path} references old runtime path`);
    assert.equal(file.text.includes(oldBindingName), false, `${file.path} references old binding type`);
  }
});
