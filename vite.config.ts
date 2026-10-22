import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Multi-page: / is the landing page, /app.html is the trading terminal.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Same-origin proxies for public RPCs that browsers can't reach directly (CORS / bot filters).
  // Production: vercel.json rewrites the same paths.
  server: {
    proxy: {
      "/rpc/solana": { target: "https://solana-rpc.publicnode.com", changeOrigin: true, rewrite: () => "/" },
      "/rpc/ethereum": { target: "https://ethereum-rpc.publicnode.com", changeOrigin: true, rewrite: () => "/" },
    },
  },
  build: {
    rollupOptions: {
      input: {
        landing: path.resolve(__dirname, "index.html"),
        app: path.resolve(__dirname, "app.html"),
        proof: path.resolve(__dirname, "proof.html"),
      },
    },
  },
});
