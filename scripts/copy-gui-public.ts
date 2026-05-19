// Build step: copy the GUI static asset tree from src/gui/public/ into
// dist/gui/public/ so the compiled server can locate it via the same
// `path.dirname(fileURLToPath(import.meta.url)) + "/public"` lookup that
// tsx-mode (npm run gui) and node-mode (npm start, dist/) both share.
//
// Zero external deps — uses fs.cpSync (Node ≥ 16.7) to avoid pulling cpx,
// fs-extra, or a glob CLI into the dependency tree. Idempotent + recursive.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const src = path.join(repo, "src", "gui", "public");
const dest = path.join(repo, "dist", "gui", "public");

function fail(msg: string): never {
  process.stderr.write(`[copy-gui-public] ${msg}\n`);
  process.exit(1);
}

function countFiles(root: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) n += countFiles(p);
    else if (entry.isFile()) n += 1;
  }
  return n;
}

function main(): void {
  if (!fs.existsSync(src)) {
    fail(`source missing: ${src}`);
  }
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) {
    fail(`source is not a directory: ${src}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, force: true });

  const copied = countFiles(dest);
  process.stdout.write(
    `[copy-gui-public] ${copied} file(s) → ${path.relative(repo, dest)}\n`,
  );
}

main();
