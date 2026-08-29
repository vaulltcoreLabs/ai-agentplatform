import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const serverOnlyPackages = [
  "postgres",
  "undici",
  "@vercel/sandbox",
  "ioredis",
  "better-auth",
  "drizzle-orm",
  "drizzle-kit",
  "@octokit/auth-app",
  "@octokit/rest",
  "jose",
  "@vercel/oidc",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname),
    },
  },
  build: {
    rollupOptions: {
      external: (id) =>
        serverOnlyPackages.some(
          (pkg) => id === pkg || id.startsWith(`${pkg}/`),
        ),
    },
  },
  server: {
    host: true,
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
