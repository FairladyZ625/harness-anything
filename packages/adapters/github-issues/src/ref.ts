import type { EngineError } from "../../../kernel/src/index.ts";
import type { GithubIssueRef, GithubRepositoryRef } from "./types.ts";

const ownerPattern = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const repoPattern = /^(?!\.\.?$)[A-Za-z0-9._-]+$/u;
const issueRefPattern = /^([^/#\s]+)\/([^/#\s]+)#([0-9]+)$/u;
const repositoryPattern = /^([^/#\s]+)\/([^/#\s]+)$/u;

export function parseGithubIssueRef(input: string): GithubIssueRef | EngineError {
  const trimmed = input.trim();
  const shorthand = trimmed.match(issueRefPattern);
  if (shorthand) return issueRef(shorthand[1] ?? "", shorthand[2] ?? "", shorthand[3] ?? "", input);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { _tag: "RefNotFound", ref: input };
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") {
    return { _tag: "RefNotFound", ref: input };
  }
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[2] !== "issues") return { _tag: "RefNotFound", ref: input };
  return issueRef(segments[0] ?? "", segments[1] ?? "", segments[3] ?? "", input);
}

export function parseGithubRepositoryRef(input: string): GithubRepositoryRef | EngineError {
  const trimmed = input.trim();
  const match = trimmed.match(repositoryPattern);
  if (!match) return { _tag: "RefNotFound", ref: input };
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  if (!validRepository(owner, repo)) return { _tag: "RefNotFound", ref: input };
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    normalized: `${normalizedOwner}/${normalizedRepo}`
  };
}

export function isEngineError(value: GithubIssueRef | GithubRepositoryRef | EngineError): value is EngineError {
  return "_tag" in value;
}

function issueRef(owner: string, repo: string, numberText: string, original: string): GithubIssueRef | EngineError {
  if (!validRepository(owner, repo)) return { _tag: "RefNotFound", ref: original };
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return { _tag: "RefNotFound", ref: original };
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    number,
    normalized: `${normalizedOwner}/${normalizedRepo}#${number}`
  };
}

function validRepository(owner: string, repo: string): boolean {
  return ownerPattern.test(owner) && repoPattern.test(repo);
}
