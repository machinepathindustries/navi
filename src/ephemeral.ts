// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// This side-effect module must load before src/mastra/index.ts constructs the
// store. cli.ts imports it first so --ephemeral can set NAVI_DB before the
// default ledger is opened.
//
// Product face of the NAVI_DB seam: `navi --ephemeral …` points the whole
// runtime at a throwaway sqlite file under a temp dir, then rmSyncs that dir
// on process exit so nothing is kept in the ledger (by design — experiments).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { match } from "ts-pattern";

// Exact argv element equality only: a quoted query that merely contains the
// text "--ephemeral" is one argv element with spaces and will not match.
const wantsEphemeral = process.argv.some((a) => a === "--ephemeral");

match(wantsEphemeral)
  .with(true, () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-ephemeral-"));
    process.env.NAVI_DB = `file:${join(dir, "navi.db")}`;
    // process.on("exit") handlers must be sync-only — rmSync is sync.
    process.on("exit", () => {
      rmSync(dir, { recursive: true, force: true });
    });
  })
  .with(false, () => undefined)
  .exhaustive();
