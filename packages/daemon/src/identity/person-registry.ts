// @slice-activation PLT-Boundary W1 exposes this module through the package root API.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel";
import type { PeopleRoster, PersonRecord, PersonRegistry } from "./types.ts";

export function personRegistryPath(rootInput: HarnessLayoutInput): string {
  return path.join(resolveHarnessLayout(rootInput).authoredRoot, "persons.yaml");
}

export function hasPersonRegistry(rootInput: HarnessLayoutInput): boolean {
  return existsSync(personRegistryPath(rootInput));
}

export function loadPersonRegistry(rootInput: HarnessLayoutInput): PersonRegistry {
  const layout = resolveHarnessLayout(rootInput);
  const filePath = path.join(layout.authoredRoot, "persons.yaml");
  if (!existsSync(filePath)) {
    throw new Error(`persons.yaml not found: ${path.relative(layout.rootDir, filePath)}`);
  }
  return personRegistryFromDocument(readFileSync(filePath, "utf8"));
}

export function personRegistryFromDocument(body: string): PersonRegistry {
  const raw = parsePersonsYaml(body);
  if (raw.schema !== "harness-persons/v1") throw new Error("persons.yaml schema must be harness-persons/v1");
  if (!Array.isArray(raw.people)) throw new Error("persons.yaml people must be an array");
  return personRegistryFromRecords(raw.people);
}

export function personRegistryFromRecords(people: ReadonlyArray<PersonRecord>): PersonRegistry {
  const byId = new Map<string, PersonRecord>();
  for (const person of people) {
    for (const key of Object.keys(person)) {
      if (key !== "personId" && key !== "displayName" && key !== "disabled") {
        throw new Error(`Unsupported person registry key: ${key}`);
      }
    }
    if (!person.personId) throw new Error("personId is required");
    if (!person.displayName) throw new Error(`displayName is required for ${person.personId}`);
    if (person.disabled !== undefined && typeof person.disabled !== "boolean") {
      throw new Error(`disabled must be true or false for ${person.personId}`);
    }
    if (byId.has(person.personId)) throw new Error(`duplicate personId: ${person.personId}`);
    byId.set(person.personId, person);
  }
  return {
    schema: "harness-persons/v1",
    people: [...people],
    find: (personId) => byId.get(personId)
  };
}

export function personRegistryFromLegacyRoster(roster: PeopleRoster): PersonRegistry {
  return personRegistryFromRecords(roster.people.map((person) => {
    if (!person.displayName) throw new Error(`displayName is required for legacy person ${person.personId}`);
    return {
      personId: person.personId,
      displayName: person.displayName,
      ...(person.disabled ? { disabled: true } : {})
    };
  }));
}

export function validatePeopleRosterReferences(registry: PersonRegistry, roster: PeopleRoster): void {
  for (const binding of roster.people) {
    if (!registry.find(binding.personId)) {
      throw new Error(`people.yaml references unregistered personId: ${binding.personId}`);
    }
  }
}

function parsePersonsYaml(body: string): { readonly schema: string; readonly people: PersonRecord[] } {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    return JSON.parse(body) as { readonly schema: string; readonly people: PersonRecord[] };
  }

  let schema = "";
  let inPeople = false;
  let current: { personId: string; displayName: string; disabled?: boolean } | undefined;
  const people: Array<{ personId: string; displayName: string; disabled?: boolean }> = [];

  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim()) continue;
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (topLevel) {
      const [, key, value = ""] = topLevel;
      if (key === "schema") schema = unquotePersonRegistryScalar(value.trim());
      else if (key === "people") inPeople = true;
      else throw new Error(`Unsupported persons.yaml key: ${key}`);
      current = undefined;
      continue;
    }
    if (inPeople) {
      const started = /^  - personId:\s*(.+)$/u.exec(line);
      if (started) {
        current = { personId: unquotePersonRegistryScalar(started[1]), displayName: "" };
        people.push(current);
        continue;
      }
      if (!current) throw new Error(`people entry must start with personId: ${line.trim()}`);
      const scalar = /^    (displayName|disabled):\s*(.+)$/u.exec(line);
      if (scalar) {
        if (scalar[1] === "displayName") current.displayName = unquotePersonRegistryScalar(scalar[2]);
        else if (scalar[2] === "true") current.disabled = true;
        else if (scalar[2] !== "false") throw new Error(`disabled must be true or false for ${current.personId}`);
        continue;
      }
    }
    throw new Error(`Unsupported persons.yaml line: ${line.trim()}`);
  }
  return { schema, people };
}

function unquotePersonRegistryScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
