import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositorySkills = path.resolve(packageRoot, "..", "..", "skills");
const publishedSkills = path.join(packageRoot, "skills");

rmSync(publishedSkills, { recursive: true, force: true });
mkdirSync(publishedSkills, { recursive: true });
cpSync(repositorySkills, publishedSkills, { recursive: true });
