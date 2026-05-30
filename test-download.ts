/**
 * Test script: list documents and download one as a ZIP for inspection.
 * Usage:
 *   npx tsx test-download.ts               <- list all documents
 *   npx tsx test-download.ts "Notizen"     <- download first doc whose path contains "Notizen"
 */
import path from 'path';
import fs from 'fs';
import { RemarkableCloudClient, type FileOps, buildFolderTree } from './src/cloud-client';

const fileOps: FileOps = {
	readFile: async (p) => { try { return await fs.promises.readFile(p, 'utf-8'); } catch { return null; } },
	writeFile: async (p, data) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, data, 'utf-8'); },
	writeBinaryFile: async (p, data) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, data); },
	mkdir: async (p) => { await fs.promises.mkdir(p, { recursive: true }); },
	exists: async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } },
};

async function main() {
	const configDir = path.join(process.env.HOME || '.', '.remarkable-sync');
	const client = new RemarkableCloudClient(configDir, fileOps);
	await client.init();

	if (!client.isAuthenticated) {
		console.error('Not authenticated. Run the Obsidian plugin first to register.');
		process.exit(1);
	}

	console.log('Fetching document list...');
	const docs = await client.listDocuments();
	const paths = buildFolderTree(docs);

	const candidates = docs.filter(d => !d.isTrashed && d.docType === 'DocumentType');
	if (candidates.length === 0) {
		console.error('No documents found.');
		process.exit(1);
	}

	const match = candidates[Math.floor(Math.random() * candidates.length)];

	const docPath = paths.get(match.id) ?? match.name;
	console.log(`\nDownloading: ${docPath} (${match.id})`);

	const files = await client.downloadDocument(match.id);
	const outDir = `test-download-${match.id.slice(0, 8)}`;
	await fs.promises.mkdir(outDir, { recursive: true });
	for (const [name, data] of files) {
		const safeName = name.replace(/[/\\]/g, "_");
		await fs.promises.writeFile(path.join(outDir, safeName), data);
	}
	console.log(`\nSaved ${files.size} file(s) to: ${outDir}/`);
	console.log(`Inspect with: ls -l ${outDir}`);
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
