import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
const assets = {};
for (const filename of await readdir("dist/client", { recursive: true })) {
  if (!/\.(html|js|css)$/.test(filename)) continue;
  const type = filename.endsWith(".html")
    ? "text/html; charset=utf-8"
    : filename.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8";
  assets[filename === "index.html" ? "/" : `/${filename}`] = {
    body: await readFile(`dist/client/${filename}`, "utf8"),
    type,
  };
}
await mkdir("dist/server", { recursive: true });
await build({
  entryPoints: ["edge/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["node:*"],
  plugins: [
    {
      name: "client-assets",
      setup(b) {
        b.onLoad({ filter: /generated-assets\.ts$/ }, () => ({
          contents: `export const assets = ${JSON.stringify(assets)};`,
          loader: "js",
        }));
      },
    },
  ],
});
console.log("Built edge API and React assets.");
