import path from 'path';
import fs from 'fs';
import { RemarkableCloudClient, type FileOps } from './src/cloud-client';
import { SyncManager } from './src/sync-manager';

const fileOps: FileOps = {
	readFile: async (p: string) => { try { return await fs.promises.readFile(p, "utf-8"); } catch { return null; } },
	writeFile: async (p: string, data: string) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, data, "utf-8"); },
	writeBinaryFile: async (p: string, data: Uint8Array) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, data); },
	mkdir: async (p: string) => { await fs.promises.mkdir(p, { recursive: true }); },
	exists: async (p: string) => { try { await fs.promises.access(p); return true; } catch { return false; } },
};

async function main() {
	const configDir = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.remarkable-sync');
	console.log('Config dir:', configDir);

	const client = new RemarkableCloudClient(configDir, fileOps);
	await client.init();
	console.log('Authenticated:', client.isAuthenticated);

	const vaultPath = path.resolve('.');
	const manager = await SyncManager.create(vaultPath, 'reMarkable', fileOps);

	console.log('Starting force sync...');
	const results = await manager.sync(client, {
		force: true,
		onProgress: (msg: string) => console.log(msg),
	});

	console.log(`\nDone! Synced: ${results.synced.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);
	for (const e of results.errors) console.log('ERROR:', e);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
