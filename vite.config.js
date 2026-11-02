import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome105", "safari13"],
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url))
      }
    }
  }
});
