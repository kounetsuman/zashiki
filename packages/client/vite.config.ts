import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        mermaidProbe: fileURLToPath(
          new URL("./mermaid-probe.html", import.meta.url),
        ),
      },
    },
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
});
