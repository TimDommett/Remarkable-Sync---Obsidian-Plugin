/**
 * Unit tests for RemarkableCloudClient blob fetching.
 *
 * Focus: the reMarkable sync v3 `/files/{hash}` endpoint requires an
 * `rm-filename` header whose value matches the blob's logical name. These tests
 * assert the client sends the correct value for every blob type (regression test
 * for the "Failed to fetch file ... HTTP 400" bug).
 *
 * Run: npx tsx --test src/cloud-client.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	RemarkableCloudClient,
	SYNC_HOST,
	type FetchFn,
	type FetchResponse,
	type FileOps,
} from "./cloud-client";

const ROOT_HASH = "roothash000000000000000000000000";
const DOC_HASH = "dochash0000000000000000000000000";
const META_HASH = "metahash000000000000000000000000";
const DOC_UUID = "00000000-0000-4000-8000-000000000001";

function makeResponse(body: string, status = 200): FetchResponse {
	const bytes = new TextEncoder().encode(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
		json: async () => JSON.parse(body),
		arrayBuffer: async () => bytes.buffer,
	};
}

interface Recorded {
	url: string;
	rmFilename?: string;
}

/** Mock FileOps that returns a token.json with a valid (far-future) user token. */
function mockFileOps(): FileOps {
	const token = JSON.stringify({
		device_token: "dev",
		user_token: "usr",
		user_token_expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
	});
	return {
		readFile: async () => token,
		writeFile: async () => {},
		writeBinaryFile: async () => {},
		mkdir: async () => {},
		exists: async () => true,
	};
}

/** Build a fetch mock that serves a one-document tree and records every call. */
function makeFetch(calls: Recorded[]): FetchFn {
	const rootIndex = `3\n${DOC_HASH}:80000000:${DOC_UUID}:1:100`;
	const docIndex = `3\n${META_HASH}:0:${DOC_UUID}.metadata:1:50`;
	const metadata = JSON.stringify({ visibleName: "Test Doc", type: "DocumentType", parent: "" });

	return async (url, options) => {
		const rmFilename = options?.headers?.["rm-filename"];
		calls.push({ url, rmFilename });

		if (url === `${SYNC_HOST}/sync/v3/root`) {
			return makeResponse(JSON.stringify({ hash: ROOT_HASH }));
		}
		if (url === `${SYNC_HOST}/sync/v3/files/${ROOT_HASH}`) return makeResponse(rootIndex);
		if (url === `${SYNC_HOST}/sync/v3/files/${DOC_HASH}`) return makeResponse(docIndex);
		if (url === `${SYNC_HOST}/sync/v3/files/${META_HASH}`) return makeResponse(metadata);
		return makeResponse("not found", 404);
	};
}

test("listDocuments sends rm-filename header for root, doc index, and content blobs", async () => {
	const calls: Recorded[] = [];
	const client = new RemarkableCloudClient("/cfg", mockFileOps(), makeFetch(calls));
	await client.init();

	const docs = await client.listDocuments();

	assert.equal(docs.length, 1);
	assert.equal(docs[0].name, "Test Doc");

	const byHash = (hash: string) =>
		calls.find((c) => c.url === `${SYNC_HOST}/sync/v3/files/${hash}`);

	// Root index blob must be requested as "root.docSchema".
	assert.equal(byHash(ROOT_HASH)?.rmFilename, "root.docSchema");
	// Per-document index blob must be requested as "<uuid>.docSchema".
	assert.equal(byHash(DOC_HASH)?.rmFilename, `${DOC_UUID}.docSchema`);
	// Content blob must be requested with its real filename from the index.
	assert.equal(byHash(META_HASH)?.rmFilename, `${DOC_UUID}.metadata`);
});

test("every /files/ request carries a non-empty rm-filename header", async () => {
	const calls: Recorded[] = [];
	const client = new RemarkableCloudClient("/cfg", mockFileOps(), makeFetch(calls));
	await client.init();
	await client.listDocuments();

	const fileCalls = calls.filter((c) => c.url.includes("/sync/v3/files/"));
	assert.ok(fileCalls.length >= 3);
	for (const c of fileCalls) {
		assert.ok(c.rmFilename && c.rmFilename.length > 0, `missing rm-filename for ${c.url}`);
	}
});

test("downloadDocument requests content blobs with their real filenames", async () => {
	const calls: Recorded[] = [];
	const client = new RemarkableCloudClient("/cfg", mockFileOps(), makeFetch(calls));
	await client.init();

	const zip = await client.downloadDocument(DOC_UUID);
	assert.ok(zip.length > 0);

	const contentCall = calls.find(
		(c) => c.url === `${SYNC_HOST}/sync/v3/files/${META_HASH}`
	);
	assert.equal(contentCall?.rmFilename, `${DOC_UUID}.metadata`);
});
