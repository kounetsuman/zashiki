#!/usr/bin/env node
import { run } from "../src/launcher.mjs";

run(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`zashiki: unexpected error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
