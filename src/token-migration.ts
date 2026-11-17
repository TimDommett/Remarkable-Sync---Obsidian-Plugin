/**
 * One-time migration of the reMarkable auth token into Obsidian's per-vault
 * local storage.
 *
 * Up to 1.0.9 the token lived in `~/.remarkable-sync/token.json`, written with
 * Node's `fs` at a path built from the HOME/USERPROFILE environment variables.
 * The plugin now keeps it in `app.saveLocalStorage()`, which is still outside
 * the vault's files (so it is never synced or committed with a vault) and needs
 * neither `fs` nor environment variables.
 *
 * To keep every existing user signed in, the first load after updating copies
 * the legacy token across. The legacy file is only read, never changed or
 * deleted: other vaults on the same machine and older plugin versions keep
 * working from it.
 *
 * Pure logic: file reads, the home directory and storage are injected, so this
 * module stays free of Obsidian and Node imports and is unit-testable.
 */

/** Local-storage key holding the token JSON (device token, user token, expiry). */
export const TOKEN_STORAGE_KEY = "remarkable-sync-token";

const LEGACY_DIR = ".remarkable-sync";
const LEGACY_FILE = "token.json";

export interface TokenMigrationDeps {
	/** Token JSON currently in local storage, or null if none. */
	readStored(): string | null;
	/** Store the token JSON in local storage. */
	writeStored(json: string): void;
	/** Read a local file as text. Rejects if it is missing or unreadable. */
	readText(absPath: string): Promise<string>;
	/** The user's home directory (where 1.0.9 and earlier wrote the token), if known. */
	homeDir: string | null;
	/** Absolute path of the vault, if it is on the local file system. */
	vaultBasePath: string | null;
}

export type TokenMigrationResult =
	| { outcome: "already-stored" }
	| { outcome: "migrated"; from: string }
	| { outcome: "not-found" };

/** Copy the legacy token into local storage unless a token is already stored there. */
export async function migrateLegacyToken(deps: TokenMigrationDeps): Promise<TokenMigrationResult> {
	if (deps.readStored() !== null) return { outcome: "already-stored" };

	for (const candidate of legacyTokenCandidates(deps.homeDir, deps.vaultBasePath)) {
		let text: string;
		try {
			text = await deps.readText(candidate);
		} catch {
			continue; // Not there (or unreadable): try the next location.
		}
		if (isTokenJson(text)) {
			deps.writeStored(text);
			return { outcome: "migrated", from: candidate };
		}
	}
	return { outcome: "not-found" };
}

/**
 * Absolute paths where 1.0.9 and earlier may have written the token, most
 * likely first: the home directory (what the old code used), then the vault
 * folder and each of its ancestors. The ancestors cover a Windows user whose
 * custom HOME variable differs from their profile folder, as long as the vault
 * lives under it.
 */
export function legacyTokenCandidates(homeDir: string | null, vaultBasePath: string | null): string[] {
	const dirs: string[] = [];
	if (homeDir) dirs.push(homeDir);
	if (vaultBasePath) dirs.push(...selfAndAncestors(vaultBasePath));

	const candidates: string[] = [];
	for (const dir of dirs) {
		const candidate = joinNative(dir, LEGACY_DIR, LEGACY_FILE);
		if (!candidates.includes(candidate)) candidates.push(candidate);
	}
	return candidates;
}

/** Whether `text` is a token file as written by `TokenStore.save()`. */
export function isTokenJson(text: string): boolean {
	try {
		const parsed = JSON.parse(text) as { device_token?: unknown } | null;
		return typeof parsed?.device_token === "string" && parsed.device_token.length > 0;
	} catch {
		return false;
	}
}

/** `dir` followed by each parent up to the root, keeping its separator style. */
function selfAndAncestors(dir: string): string[] {
	const sep = separatorOf(dir);
	const lead = /^[\\/]*/.exec(dir)?.[0] ?? "";
	const rest = dir.slice(lead.length).replace(/[\\/]+$/, "");
	const parts = rest ? rest.split(/[\\/]+/) : [];

	const dirs: string[] = [];
	for (let i = parts.length; i >= 0; i--) {
		const path = lead + parts.slice(0, i).join(sep);
		if (path) dirs.push(path);
	}
	return dirs;
}

/** Join path segments using the separator style of `dir` (backslashes on Windows). */
function joinNative(dir: string, ...names: string[]): string {
	const sep = separatorOf(dir);
	return dir.replace(/[\\/]+$/, "") + sep + names.join(sep);
}

function separatorOf(path: string): string {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}
