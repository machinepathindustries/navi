import { z } from "zod";

export default z.object({
  nonce: z.string(),
  read_with_tool: z.boolean(),
});
