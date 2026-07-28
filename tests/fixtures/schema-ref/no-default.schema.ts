import { z } from "zod";

// Negative fixture: a schema file with only a NAMED export and no default.
// resolveSchemaRef must reject this loudly ("no default export"), never guess.
export const schema = z.object({ x: z.string() });
