import { appendFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const artifactPath = process.env.HARNESS_TEST_FAILURE_ARTIFACT;

export default async function* reportTestFailures(source) {
  for await (const event of source) {
    if (event.type !== "test:fail" || artifactPath === undefined) continue;
    const file = event.data.file ?? event.data.name ?? "<unknown>";
    const name = event.data.name ?? "<unnamed test>";
    const error = event.data.details?.error;
    const stack =
      typeof error?.stack === "string"
        ? error.stack
        : `${error?.name ?? "Error"}: ${error?.message ?? "No error details provided"}`;
    const absoluteFile = resolve(file);
    const relativeFile = relative(process.cwd(), absoluteFile);
    const record = {
      type: event.type,
      name,
      file:
        relativeFile === ".." || relativeFile.startsWith(`..${sep}`)
          ? String(file).replaceAll("\\", "/")
          : relativeFile.split(sep).join("/"),
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? "No error details provided",
        stack,
        ...(error?.code === undefined ? {} : { code: error.code }),
      },
    };
    appendFileSync(artifactPath, `${JSON.stringify(record)}\n`, "utf8");
  }
  yield "";
}
