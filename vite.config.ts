import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies /api to the FastAPI backend on :8000.
export default defineConfig(({ mode }) => {
  // Extra Host headers the dev server accepts (reverse-proxy / tunnel domains), comma-separated.
  // Keep them in the gitignored `.env.local` (STATESCOPE_ALLOWED_HOSTS=a.example,b.example),
  // not in source. No VITE_ prefix, so it is never exposed to client code.
  const env = loadEnv(mode, ".", "");
  const extraHosts = (env.STATESCOPE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": "http://localhost:8000",
      },
      allowedHosts: ["localhost", "127.0.0.1", ...extraHosts],
    },
    build: { outDir: "dist" },
  };
});
