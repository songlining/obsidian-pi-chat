import esbuild from "esbuild";
import process from "process";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const production = process.argv[2] === "production";
const vaultPluginsDir = join(
  process.env.HOME ?? "~",
  "work/hashicorp/obsidian-notes/.obsidian/plugins/obsidian-pi-chat",
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

  // Local convenience: copy the bundle into a dev vault for live testing.
  // Only when the plugin is already installed there (or forced), so CI
  // builds never touch a local vault path.
  const shouldCopy =
    existsSync(vaultPluginsDir) || process.env.PI_CHAT_COPY_TO_VAULT === "1";
  if (shouldCopy) {
    mkdirSync(vaultPluginsDir, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css", "versions.json"]) {
      if (existsSync(file)) copyFileSync(file, join(vaultPluginsDir, file));
    }
    console.log(`\nCopied build -> ${vaultPluginsDir}`);
  }
} else {
  await context.watch();
  console.log("Watching for changes...");
}
