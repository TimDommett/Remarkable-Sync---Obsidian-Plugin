// Run the community-review scan replica against the plugin source.
//
//   npm ci --prefix scripts/community-scan   # once, installs the scan's own toolchain
//   npm run scan:community                   # scan this repository
//   node scripts/community-scan/scan.mjs DIR # scan another checkout
//
// The directory's reviewer type-checks the plugin without @types/node and does
// not look at test files, so the scan runs on a scratch copy of src/ that has
// no tests and uses this folder's node_modules (which has no @types/node).
// Exits non-zero on any finding, warnings included.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, "..", ".."));
const scanModules = join(here, "node_modules");

if (!existsSync(join(scanModules, "eslint-plugin-obsidianmd"))) {
	console.error("Install the scan toolchain first: npm ci --prefix scripts/community-scan");
	process.exit(2);
}
if (existsSync(join(scanModules, "@types", "node"))) {
	console.error("scripts/community-scan/node_modules must not contain @types/node (the directory's scan has none).");
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "community-scan-"));
try {
	for (const entry of ["src", "tsconfig.json", "package.json", "manifest.json"]) {
		cpSync(join(root, entry), join(work, entry), { recursive: true });
	}
	for (const file of readdirSync(join(work, "src"))) {
		if (file.endsWith(".test.ts")) rmSync(join(work, "src", file));
	}
	symlinkSync(scanModules, join(work, "node_modules"), "junction");

	const eslint = join(scanModules, "eslint", "bin", "eslint.js");
	const result = spawnSync(
		process.execPath,
		[eslint, "--no-config-lookup", "-c", join(here, "eslint.config.mjs"), "--max-warnings", "0", "src/**/*.ts"],
		{ cwd: work, stdio: "inherit", env: { ...process.env, SCAN_ROOT: work } }
	);
	if (result.status === 0) console.log("Community review scan: no findings.");
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(work, { recursive: true, force: true });
}
