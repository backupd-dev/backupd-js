/**
 * Builds standalone `backupd` binaries (no Node.js needed) for every platform
 * the installer supports, plus a SHA256SUMS file. Release assets are named
 * `backupd-<os>-<arch>[.exe]`; https://backupd.dev/install relies on that.
 *
 *   bun scripts/compile.ts            all targets
 *   bun scripts/compile.ts linux-x64  one target
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
] as const;

const root = join(import.meta.dir, "..");
const entry = join(root, "packages/cli/src/bin.ts");
const outDir = join(root, "packages/cli/dist/bin");
mkdirSync(outDir, { recursive: true });

const wanted = process.argv.slice(2);
const targets = wanted.length > 0 ? TARGETS.filter((t) => wanted.includes(t)) : TARGETS;

const sums: string[] = [];
for (const target of targets) {
  const name = `backupd-${target}${target.startsWith("windows") ? ".exe" : ""}`;
  const outfile = join(outDir, name);
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      entry,
      "--compile",
      "--minify",
      `--target=bun-${target}`,
      `--outfile=${outfile}`,
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (build.exitCode !== 0) {
    throw new Error(`Building ${name} failed.`);
  }
  const digest = createHash("sha256").update(readFileSync(outfile)).digest("hex");
  sums.push(`${digest}  ${name}`);
  process.stdout.write(`built ${name}\n`);
}
writeFileSync(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
