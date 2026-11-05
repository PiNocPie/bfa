import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/app.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: "dist/app.js",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  alias: { util: "./src/shims/util.cjs" },
  logLevel: "warning",
});
copyFileSync("src/index.html", "dist/index.html");
copyFileSync("../../site/mascot.svg", "dist/mascot.svg");
copyFileSync("src/pages/privacy.html", "dist/privacy.html");
copyFileSync("src/pages/terms.html", "dist/terms.html");
console.log("web: dist/index.html, dist/app.js");
