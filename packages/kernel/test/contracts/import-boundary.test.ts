import assert from "node:assert/strict";
import test from "node:test";
import { readKernelSourceFilesUnder } from "../helpers/source-files.ts";

const forbiddenDomainImports = [
  "node:fs",
  "fs",
  "node:process",
  "process",
  "node:child_process",
  "child_process",
  "node:path",
  "path",
  "node:os",
  "os",
  "node:crypto",
  "crypto",
  "sqlite",
  "better-sqlite3",
  "effect"
];

test("domain source does not import runtime, IO, database or Effect modules", async () => {
  const files = await readKernelSourceFilesUnder("domain");

  for (const file of files) {
    for (const moduleName of forbiddenDomainImports) {
      const importStatement = `from "${moduleName}"`;
      const importStatementSingleQuote = `from '${moduleName}'`;
      assert.equal(file.text.includes(importStatement), false, `${file.path} imports ${moduleName}`);
      assert.equal(file.text.includes(importStatementSingleQuote), false, `${file.path} imports ${moduleName}`);
    }
  }
});

test("layout and docmap logic do not import direct physical IO modules", async () => {
  const files = [
    ...await readKernelSourceFilesUnder("layout"),
    ...await readKernelSourceFilesUnder("docmap")
  ];
  const forbiddenIoImports = [
    "node:fs",
    "fs",
    "node:child_process",
    "child_process"
  ];

  for (const file of files) {
    for (const moduleName of forbiddenIoImports) {
      assert.equal(file.text.includes(`from "${moduleName}"`), false, `${file.path} imports ${moduleName}`);
      assert.equal(file.text.includes(`from '${moduleName}'`), false, `${file.path} imports ${moduleName}`);
    }
  }
});
