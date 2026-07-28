import { z } from "zod";

// Negative fixture: the default export is a Zod schema but NOT an object — a bare
// array. resolveSchemaRef must reject it ("not a Zod object schema"): the step's
// outputFields are the object's keys, so the top-level export has to be z.object.
export default z.array(z.object({ file: z.string() }));
