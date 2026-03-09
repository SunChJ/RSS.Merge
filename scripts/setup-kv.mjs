#!/usr/bin/env node
/**
 * Bootstrap Cloudflare KV namespaces and patch wrangler.toml automatically.
 *
 * Requirements:
 * - `wrangler` installed (devDependency)
 * - `wrangler login`
 *
 * Usage:
 *   node scripts/setup-kv.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const wranglerTomlPath = path.join(root, "wrangler.toml");

function runWrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  }).trim();
}

function createKv(title) {
  // Wrangler prints JSON if --json is supported.
  const out = runWrangler(["kv", "namespace", "create", title, "--json"]);
  const parsed = JSON.parse(out);
  // wrangler returns either {id} or {namespace_id}
  const id = parsed.id || parsed.namespace_id || parsed?.result?.id;
  if (!id) throw new Error(`Could not parse KV id from wrangler output: ${out}`);
  return id;
}

function patchToml(toml, binding, id) {
  // Replace the first occurrence of id = "REPLACE_WITH_..." under the matching binding.
  // This is intentionally simple and works with the template in this repo.
  const lines = toml.split(/\n/);
  let inBlock = false;
  let bindingMatch = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "[[kv_namespaces]]") {
      inBlock = true;
      bindingMatch = false;
      continue;
    }
    if (!inBlock) continue;

    const b = line.match(/^\s*binding\s*=\s*"([A-Z0-9_]+)"\s*$/);
    if (b) {
      bindingMatch = b[1] === binding;
      continue;
    }

    if (bindingMatch) {
      const idLine = line.match(/^\s*id\s*=\s*"([^"]*)"\s*$/);
      if (idLine) {
        lines[i] = `id = "${id}"`;
        return lines.join("\n");
      }
    }
  }
  throw new Error(
    `Could not patch wrangler.toml for binding=${binding}. Is the template unchanged?`,
  );
}

function main() {
  const toml0 = fs.readFileSync(wranglerTomlPath, "utf8");

  console.log("Creating KV namespaces...");
  const configId = createKv("rss-merge-config");
  const cacheId = createKv("rss-merge-cache");

  let toml = toml0;
  toml = patchToml(toml, "CONFIG", configId);
  toml = patchToml(toml, "CACHE", cacheId);

  fs.writeFileSync(wranglerTomlPath, toml);

  console.log("\nDone.");
  console.log("- CONFIG KV id:", configId);
  console.log("- CACHE  KV id:", cacheId);
  console.log("Patched:", wranglerTomlPath);
  console.log("\nNext: npm run deploy");
}

main();
