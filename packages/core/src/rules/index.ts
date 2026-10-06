import type { Rule } from "./types";
import { R01 } from "./r01-cron-frequency";
import { R02 } from "./r02-double-trigger";
import { R03 } from "./r03-cancel-in-progress";
import { R04 } from "./r04-macos-without-need";
import { R05 } from "./r05-missing-cache";
import { R06 } from "./r06-no-timeout";
import { R13 } from "./r13-slim-runner";
import { R14 } from "./r14-runner-routing";

/** Rules shipped in M1. R07 to R12 arrive later (ROADMAP.md). R14 is evaluated last on purpose. */
export const ALL_RULES: readonly Rule[] = [R01, R02, R03, R04, R05, R06, R13, R14];
export { R01, R02, R03, R04, R05, R06, R13, R14 };
