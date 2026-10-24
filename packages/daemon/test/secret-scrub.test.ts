// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { scrubSecretText } from "../src/secret-scrub.ts";

// Public, structurally valid samples only: they pin the shape each rule matches without being
// live credentials. A rule that keeps any of these strings verbatim fails the write boundary.
const awsAccessKeyId = "AKIAIOSFODNN7EXAMPLE",
  googleApiKey = "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  rsaPrivateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7examplekeybody\n-----END RSA PRIVATE KEY-----",
  opensshPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nbm9uY2U=\n-----END OPENSSH PRIVATE KEY-----";

test("scrubber redacts cloud access keys, Google API keys, JWTs and PEM private keys", () => {
  const scrubbed = scrubSecretText(
    [
      `aws access key: ${awsAccessKeyId}`,
      `google api key: ${googleApiKey}`,
      `session token ${jwt}`,
      rsaPrivateKey,
      opensshPrivateKey,
    ].join("\n"),
  );
  for (const secret of [awsAccessKeyId, googleApiKey, jwt, "MIIEowIBAAKCAQEA7examplekeybody", "bm9uY2U="])
    assert.equal(scrubbed.includes(secret), false, `${secret} must not survive the scrubber`);
  assert.match(scrubbed, /\[REDACTED\]/u);
  assert.match(scrubbed, /aws access key/u, "the sentence around the credential survives");
});

test("assignments redact compound credential names and quoted JSON values", () => {
  for (const text of [
    "OPENAI_API_KEY=plainvalue123",
    "AZURE_OPENAI_API_KEY=plainvalue123",
    "AWS_SECRET_ACCESS_KEY=plainvalue123",
    "GITHUB_TOKEN=plainvalue123",
    "anthropic_api_key=plainvalue123",
    '{"OPENAI_API_KEY": "plainvalue123"}',
  ]) {
    const scrubbed = scrubSecretText(text);
    assert.equal(scrubbed.includes("plainvalue123"), false, `${text} leaked its value`);
    assert.match(scrubbed, /\[REDACTED\]/u, `${text} produced no redaction`);
  }
});

test("ordinary key-shaped prose and public material stay readable", () => {
  for (const text of [
    "monkey=banana",
    "the api key is read from OPENAI_API_KEY when it is set",
    "AKIA1234 is not an access key",
    "AIza-too-short",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----",
    "secretary: hello",
    "totalTokens: 15",
    "input_tokens: 120",
  ])
    assert.equal(scrubSecretText(text), text, `benign text changed: ${text}`);
});
