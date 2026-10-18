import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { componentTagger } from "lovable-tagger";

// `vite build --mode demo` (npm run build:demo) produces a static, backend-free demo with
// invented data: the Supabase client is swapped for src/demo/client.ts (in-memory mock),
// routing goes through the URL hash and asset paths are relative, so dist-demo/ can be
// dropped into any sub-folder of a static site.
const demoHtml = (): Plugin => ({
  name: "demo-html",
  transformIndexHtml: (html) =>
    html
      .replace(/<title>[\s\S]*?<\/title>/, "<title>Trackora · demo</title>")
      .replace("<head>", '<head>\n    <meta name="robots" content="noindex" />\n    <link rel="icon" href="favicon.ico" />'),
});

// public/realdata-*.json are local exports of REAL portfolios (for viewing them in the demo UI on this
// machine only). Vite copies public/ into every build, so the demo build deletes them from its output —
// dist-demo/ goes onto the public portfolio site.
const stripRealData = (): Plugin => ({
  name: "strip-real-data",
  apply: "build",
  closeBundle() {
    const out = path.resolve(__dirname, "dist-demo");
    if (!fs.existsSync(out)) return;
    for (const f of fs.readdirSync(out)) if (/^realdata-.*\.json$/i.test(f)) fs.rmSync(path.join(out, f));
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    base: demo ? "./" : "/",
    // Demo builds read no .env files at all, so real project settings can never leak in.
    envDir: demo ? path.resolve(__dirname, "./src/demo") : undefined,
    define: demo ? { __DEMO_ANCHOR_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)) } : undefined,
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    build: demo ? { outDir: "dist-demo" } : undefined,
    plugins: [react(), mode === "development" && componentTagger(), demo && demoHtml(), demo && stripRealData()].filter(Boolean),
    resolve: {
      alias: [
        ...(demo
          ? [{ find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "./src/demo/client.ts") }]
          : []),
        { find: "@", replacement: path.resolve(__dirname, "./src") },
      ],
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
  };
});
