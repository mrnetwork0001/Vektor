import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Public RPCs 403 requests that carry a browser Origin/Referer; the proxy drops them.
const stripBrowserHeaders = (proxy: any) => {
  proxy.on("proxyReq", (req: any) => { req.removeHeader("origin"); req.removeHeader("referer"); req.removeHeader("cookie"); });
};

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
      "/rpc/solana": { target: "https://api.mainnet-beta.solana.com", changeOrigin: true, rewrite: () => "/", configure: stripBrowserHeaders },
      "/rpc/ethereum": { target: "https://ethereum-rpc.publicnode.com", changeOrigin: true, rewrite: () => "/", configure: stripBrowserHeaders },
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
