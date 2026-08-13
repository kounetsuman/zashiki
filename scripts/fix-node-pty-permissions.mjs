// Workaround for a known issue where node-pty's prebuilds/**/spawn-helper loses its
// execute permission when pnpm unpacks it (causing pty.spawn to die with posix_spawnp
// failed). We chmod it in postinstall.
import { chmodSync, globSync } from "node:fs";

const helpers = globSync(
  "node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper",
);
for (const helper of helpers) {
  chmodSync(helper, 0o755);
  console.log(`fixed exec permission: ${helper}`);
}
