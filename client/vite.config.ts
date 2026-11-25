import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

declare const process: { env: { AXIS_API_URL?: string } };

const proxy = {
  "/api": {
    target: process.env.AXIS_API_URL ?? "http://localhost:3000",
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: false,
    css: { include: [/\.css\?raw$/] },
  },
});
