import esbuild from "esbuild";
import process from "process";
import { copyFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const production = process.argv[2] === "production";
const vaultPluginsDir = join(
  process.env.HOME ?? "~",
  "work/hashicorp/obsidian-notes/.obsidian/plugins/pi-chat",
);

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian provides `obsidian` and the Electron/node builtins at runtime.
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "path",
    "os",
    "util",
    "crypto",
    "stream",
    "string_decoder",
    "events",
    "http",
    "https",
    "net",
    "tty",
    "zlib",
    "buffer",
    "url",
    "process",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();

  // Copy the plugin bundle into the vault for live testing.
  mkdirSync(vaultPluginsDir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    copyFileSync(join("", file), join(vaultPluginsDir, file));
  }
  console.log(`\nCopied main.js, manifest.json, styles.css -> ${vaultPluginsDir}`);
} else {
  await context.watch();
  console.log("Watching for changes...");
}
