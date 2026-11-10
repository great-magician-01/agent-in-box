import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controlPlaneHost = process.env.CONTROL_PLANE_HOST ?? "127.0.0.1";
const controlPlanePort = process.env.CONTROL_PLANE_PORT ?? "3000";
const webPort = Number(process.env.WEB_DEV_PORT ?? "5173");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://${controlPlaneHost}:${controlPlanePort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
