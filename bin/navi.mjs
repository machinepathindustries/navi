#!/usr/bin/env node

import { tsImport } from "tsx/esm/api";

await tsImport("../src/cli.ts", { parentURL: import.meta.url, tsconfig: false });
