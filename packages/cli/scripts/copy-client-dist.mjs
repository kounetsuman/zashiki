//! Copy the @zashiki/client build output (packages/client/dist) into the client-dist/
//! directory bundled with the published zashiki package. Invoked from zashiki's `build`.
//! The bundled files are served statically as zashiki-server's ZK_CLIENT_DIST (the lifeline
//! that avoids a blank screen).

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const src = join(pkgRoot, "..", "client", "dist");
const dest = join(pkgRoot, "client-dist");

if (!existsSync(join(src, "index.html"))) {
  process.stderr.write(
    `client dist not found (${src}).\n` +
      "Build @zashiki/client first: pnpm -F @zashiki/client build\n",
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
process.stdout.write(`bundled client dist: ${src} → ${dest}\n`);
