import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The console is served by `pitwall serve` off the built output, so it builds to
// dist/ui/ beside the compiled CLI rather than to a top-level dist/.
//
// ui/ is a self-contained directory on purpose: the managed tier serves the same
// bundle, and lifting it into its own repository later is a move, not an untangling.
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
});
