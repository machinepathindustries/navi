import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin NAVI_DB for the whole suite, before any test file is imported.
//
// Several suites (guard, compiler, edge-walk) import src/mastra/index.ts directly
// for createWorkspace. That module builds LibSQLStore at load, so importing it is
// enough to open the real ledger. Pinning NAVI_DB here protects user data.
//
// Individual suites may still set their own NAVI_DB; this is the floor, not a lid.
const dir = mkdtempSync(join(tmpdir(), "navi-suite-db-"));
process.env.NAVI_DB = `file:${join(dir, "navi.db")}`;

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
