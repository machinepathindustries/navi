import { z } from "zod";

// Co-located output schema for the schema-ref fixture. The top-level export is
// a Zod object whose keys become the
// step's honest `outputFields`. The fields exercise exactly the two shapes the
// inline token grammar cannot express:
//   - `findings`: z.array(z.object({…}))  → code-review's finding-object array
//   - `verdict`:  z.enum([…])             → founder's GO/REFINE/REJECT verdict
// No logic lives here — a schema file is a shape declaration, nothing else.
export default z.object({
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string(),
    }),
  ),
  verdict: z.enum(["GO", "REFINE", "REJECT"]),
});
