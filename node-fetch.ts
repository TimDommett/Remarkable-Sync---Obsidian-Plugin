/**
 * Native-fetch adapter for the Node CLI tools (run-sync.ts, test-download.ts).
 *
 * The plugin injects Obsidian's requestUrl instead (see src/main.ts), so the
 * plugin source never references the global fetch, which Obsidian's
 * guidelines ask plugins to avoid.
 */
import type { FetchFn } from "./src/cloud-client";

export const nodeFetch: FetchFn = async (url, options) => {
	const resp = await fetch(url, options);
	return {
		ok: resp.ok,
		status: resp.status,
		text: () => resp.text(),
		json: () => resp.json(),
		arrayBuffer: () => resp.arrayBuffer(),
	};
};
