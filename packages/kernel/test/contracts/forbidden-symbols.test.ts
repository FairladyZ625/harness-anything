import assert from "node:assert/strict";
import test from "node:test";
import { readKernelSourceFiles } from "../helpers/source-files.ts";

const forbiddenSymbols = [
  ["request", "Transition"].join(""),
  ["sync", "Mode"].join(""),
  ["binding", "Role"].join("")
];

test("kernel source does not expose rejected lifecycle vocabulary", async () => {
  const files = await readKernelSourceFiles();

  for (const file of files) {
    for (const symbol of forbiddenSymbols) {
      assert.equal(file.text.includes(symbol), false, `${file.path} contains ${symbol}`);
    }
  }
});
