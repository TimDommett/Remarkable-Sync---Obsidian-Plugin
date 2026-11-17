/**
 * Unit tests for the legacy token migration (1.0.9 file store -> local storage).
 * The bar is that no existing user is signed out by the update.
 *
 * Run: npx tsx --test src/token-migration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	isTokenJson,
	legacyTokenCandidates,
	migrateLegacyToken,
	type TokenMigrationDeps,
} from "./token-migration";

const TOKEN = JSON.stringify(
	{ device_token: "dev-123", user_token: "usr-456", user_token_expiry: "2026-12-01T00:00:00.000Z" },
	null,
	2
);

/** In-memory world: a set of files on disk plus the vault's local storage. */
function world(opts: {
	files?: Record<string, string>;
	stored?: string | null;
	homeDir?: string | null;
	vaultBasePath?: string | null;
}) {
	const files = new Map(Object.entries(opts.files ?? {}));
	const reads: string[] = [];
	let stored = opts.stored ?? null;
	let writes = 0;
	const deps: TokenMigrationDeps = {
		readStored: () => stored,
		writeStored: (json) => {
			stored = json;
			writes++;
		},
		readText: async (p) => {
			reads.push(p);
			const text = files.get(p);
			if (text === undefined) throw new Error(`ENOENT: ${p}`);
			return text;
		},
		homeDir: opts.homeDir === undefined ? null : opts.homeDir,
		vaultBasePath: opts.vaultBasePath === undefined ? null : opts.vaultBasePath,
	};
	return { deps, files, reads, stored: () => stored, writes: () => writes };
}

test("macOS: token in the home folder is migrated, legacy file left untouched", async () => {
	const legacy = "/Users/tim/.remarkable-sync/token.json";
	const w = world({ files: { [legacy]: TOKEN }, homeDir: "/Users/tim", vaultBasePath: "/Users/tim/Documents/Vault" });
	const r = await migrateLegacyToken(w.deps);
	assert.deepEqual(r, { outcome: "migrated", from: legacy });
	assert.equal(w.stored(), TOKEN, "stored byte-for-byte");
	assert.equal(w.files.get(legacy), TOKEN, "legacy file unchanged");
	assert.equal(w.reads[0], legacy, "home folder is tried first");
});

test("Linux: vault outside the home folder still migrates (home candidate)", async () => {
	const legacy = "/home/tim/.remarkable-sync/token.json";
	const w = world({ files: { [legacy]: TOKEN }, homeDir: "/home/tim", vaultBasePath: "/mnt/data/notes/Vault" });
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "migrated", from: legacy });
});

test("Windows: vault on another drive migrates from the profile folder", async () => {
	const legacy = "C:\\Users\\tim\\.remarkable-sync\\token.json";
	const w = world({ files: { [legacy]: TOKEN }, homeDir: "C:\\Users\\tim", vaultBasePath: "D:\\Notes\\Vault" });
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "migrated", from: legacy });
});

test("Windows with a custom HOME: found via the vault's ancestors", async () => {
	// 1.0.9 preferred HOME over USERPROFILE; os.homedir() returns USERPROFILE.
	const legacy = "C:\\Users\\tim\\home\\.remarkable-sync\\token.json";
	const w = world({
		files: { [legacy]: TOKEN },
		homeDir: "C:\\Users\\tim",
		vaultBasePath: "C:\\Users\\tim\\home\\Obsidian\\Vault",
	});
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "migrated", from: legacy });
});

test("a token already in local storage is kept and nothing is read", async () => {
	const w = world({ stored: "existing", files: { "/Users/tim/.remarkable-sync/token.json": TOKEN }, homeDir: "/Users/tim" });
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "already-stored" });
	assert.equal(w.stored(), "existing");
	assert.deepEqual(w.reads, []);
	assert.equal(w.writes(), 0);
});

test("no legacy token anywhere: not-found, nothing written", async () => {
	const w = world({ homeDir: "/Users/new", vaultBasePath: "/Users/new/Vault" });
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "not-found" });
	assert.equal(w.writes(), 0);
	assert.ok(w.reads.length > 0);
});

test("corrupt or partial legacy files are skipped in favour of a valid one", async () => {
	const w = world({
		files: {
			"/Users/tim/.remarkable-sync/token.json": "{ not json",
			"/Users/.remarkable-sync/token.json": JSON.stringify({ device_token: "" }),
			"/.remarkable-sync/token.json": TOKEN,
		},
		homeDir: "/Users/tim",
		vaultBasePath: "/Users/tim/Vault",
	});
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "migrated", from: "/.remarkable-sync/token.json" });
});

test("nothing to search: no home and no local vault", async () => {
	const w = world({});
	assert.deepEqual(await migrateLegacyToken(w.deps), { outcome: "not-found" });
	assert.deepEqual(w.reads, []);
});

test("candidates: home first, then vault and every ancestor, deduplicated", () => {
	assert.deepEqual(legacyTokenCandidates("/Users/tim", "/Users/tim/Documents/Vault"), [
		"/Users/tim/.remarkable-sync/token.json",
		"/Users/tim/Documents/Vault/.remarkable-sync/token.json",
		"/Users/tim/Documents/.remarkable-sync/token.json",
		"/Users/.remarkable-sync/token.json",
		"/.remarkable-sync/token.json",
	]);
	assert.deepEqual(legacyTokenCandidates("C:\\Users\\tim", "C:\\Users\\tim\\Vault\\"), [
		"C:\\Users\\tim\\.remarkable-sync\\token.json",
		"C:\\Users\\tim\\Vault\\.remarkable-sync\\token.json",
		"C:\\Users\\.remarkable-sync\\token.json",
		"C:/.remarkable-sync/token.json",
	]);
	assert.deepEqual(legacyTokenCandidates(null, null), []);
});

test("candidates: UNC vault paths do not throw", () => {
	const c = legacyTokenCandidates(null, "\\\\server\\share\\Vault");
	assert.equal(c[0], "\\\\server\\share\\Vault\\.remarkable-sync\\token.json");
});

test("isTokenJson accepts only a token file with a device token", () => {
	assert.equal(isTokenJson(TOKEN), true);
	assert.equal(isTokenJson(JSON.stringify({ device_token: "" })), false);
	assert.equal(isTokenJson(JSON.stringify({ user_token: "x" })), false);
	assert.equal(isTokenJson("null"), false);
	assert.equal(isTokenJson("[]"), false);
	assert.equal(isTokenJson("not json"), false);
});
