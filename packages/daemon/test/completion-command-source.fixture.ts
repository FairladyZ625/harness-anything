import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const researchScript = `import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT).witnessInput, "utf8"));
if (input.code !== null) throw new Error("Expected an artifact-only submission");
const experiment = input.subjects.find(s => s.path.endsWith("/experiment.json"));
const metadata = JSON.parse(readFileSync(experiment.file, "utf8"));
const csv = input.subjects.find(s => s.path.endsWith("/data.csv"));
const png = input.subjects.find(s => s.path.endsWith("/chart.png"));
if (readFileSync(csv.file, "utf8") !== "x,y\\n1,2\\n" || readFileSync(png.file).toString("base64") !== "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==") throw new Error("Submitted bytes changed");
const subjects = input.subjects.map(({file, ...anchor}) => anchor);
console.log(JSON.stringify({schema:"preset-script-result/v1", produces:[{capabilityId:"completion-witness",payload:{
result: Number.isInteger(metadata.seed) ? "pass" : "fail", subjects, predicateType:"research/version-pinned/v1",
predicate: metadata, diagnostic: Number.isInteger(metadata.seed) ? "Seed and submitted inputs verified" : "gates.version-pinned.predicate.seed: required"}}]}));`;

export function researchPackage(root: string, script = researchScript, outputShape = "task-package-artifact") {
  const source = path.join(root, "source/research-checks");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  const capability = { id: "completion-witness", kind: "checker", version: "1" };
  writeFileSync(
    path.join(source, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "research-checks",
      title: "Research checks",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      outputShape,
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [{ ...capability, required: true }],
      entrypoints: {
        anchors: {
          type: "script",
          intent: "Check frozen experiment inputs",
          inputs: [{ name: "witnessInput", type: "string", required: true }],
          requires: [],
          produces: [capability],
          sideEffects: [],
          command: "scripts/anchors.mjs",
        },
      },
      profiles: [
        {
          id: "experiment",
          title: "Experiment",
          completionGates: ["version-pinned"],
          templateSelections: [],
          closeoutOverrides: { fact: false },
        },
      ],
      defaultProfile: "experiment",
      completion: {
        sources: {
          "research/anchor-check": {
            kind: "command",
            entrypoint: "research-checks/anchors",
            predicateType: "research/version-pinned/v1",
            resultSchema: {
              type: "object",
              required: ["seed"],
              additionalProperties: false,
              properties: { seed: { type: "integer" } },
            },
          },
        },
        gates: {
          "version-pinned": {
            source: "research/anchor-check",
            appliesTo: "artifacts",
            subjects: "all-artifacts",
            bindings: { seed: { artifact: "artifacts/experiment.json", pointer: "/seed" } },
          },
        },
        closeoutDefaults: { review: false, consent: false, factDisposition: false, codeDoc: false },
      },
    }),
  );
  writeFileSync(
    path.join(source, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Validate submitted experiments.\nwhenToUse: Artifact-only research.\n---\n# Research\n",
  );
  writeFileSync(path.join(source, "scripts/anchors.mjs"), script);
  return source;
}
