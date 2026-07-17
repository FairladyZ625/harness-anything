import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// GUI unit tests assert English copy. Pin locale so zh developer hosts
// (and environments that expose navigator.language) stay deterministic.
setActiveLocale("en-US");
