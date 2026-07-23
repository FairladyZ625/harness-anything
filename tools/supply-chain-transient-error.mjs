// A transient npm registry / transport failure (5xx, rate limit, connection
// reset, DNS, socket hang up) must be retried inside the network budget rather
// than hard-failing a required gate on a registry blip. Real `npm audit`
// findings (actual advisories) never contain these transport tokens, so this
// predicate cannot mistake a genuine vulnerability report for a transient error.
export function isTransientRegistryError(output) {
  if (typeof output !== "string" || output === "") return false;
  return /\b(50[0234]|429)\b|service unavailable|bad gateway|gateway time-?out|too many requests|audit endpoint returned an error|econnreset|etimedout|eai_again|enotfound|socket hang ?up|npm (?:error|err|warn) network|network (?:error|timeout)|request to https?:\/\/\S*registry\S* failed/iu.test(
    output
  );
}
