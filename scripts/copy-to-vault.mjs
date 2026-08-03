#!/usr/bin/env node
/**
 * Copy the built plugin into the vault for live testing.
 * Usage: node scripts/copy-to-vault.mjs [vaultPath]
 * Default vault: ~/work/hashicorp/obsidian-notes
 */
import { copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const vaultPath = process.argv[2] || join(process.env.HOME || "~", "work/hashicorp/obsidian-notes");
const target = join(vaultPath, ".obsidian/plugins/pi-chat-local");

mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(join(repoRoot, file), join(target, file));
}
console.log(`Copied plugin -> ${target}`);
