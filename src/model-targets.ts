// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { readFileSync } from "node:fs";
import { match, P } from "ts-pattern";
import { z } from "zod";

const ModelRoles = z.object({
  quick: z.string().min(1),
  workflow: z.string().min(1),
});

const TestedModelManifest = z.object({
  runtime: z.object({
    default_provider: z.string().min(1),
  }),
  providers: z.array(
    z.object({
      id: z.string().min(1),
      models: ModelRoles,
    }),
  ),
});

export const TESTED_MODEL_TARGETS = TestedModelManifest.parse(
  JSON.parse(readFileSync(new URL("../config/tested-models.json", import.meta.url), "utf8")),
);

const defaultProvider = match(
  TESTED_MODEL_TARGETS.providers.find(
    ({ id }) => id === TESTED_MODEL_TARGETS.runtime.default_provider,
  ),
)
  .with(P.nullish, (): never => {
    throw new Error(
      `tested-model manifest has no default provider named ${TESTED_MODEL_TARGETS.runtime.default_provider}`,
    );
  })
  .otherwise((provider) => provider);

export const DEFAULT_MODEL = defaultProvider.models.quick;
export const DEFAULT_WORKFLOW_MODEL = defaultProvider.models.workflow;
