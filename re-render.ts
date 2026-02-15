/**
 * Re-renders all reference sheet .rm files to PDFs using our renderer.
 * Usage: npx tsx re-render.ts
 */
import fs from 'fs';
import path from 'path';
import { parseRmFile } from './src/rm-parser';
import { renderPageToPdf, renderNotebookToPdf } from './src/pdf-renderer';

const REF_DIR = 'reference_sheets';
const OUTPUT_DIR = 'reMarkable/RefrenceSheets';

async function main() {
	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	const dirs = fs.readdirSync(REF_DIR, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort();

	for (const name of dirs) {
		const dir = path.join(REF_DIR, name);
		const rmFiles = fs.readdirSync(dir)
			.filter(f => f.endsWith('.rm'))
			.sort();

		if (rmFiles.length === 0) {
			console.log(`  [SKIP] ${name} — no .rm files`);
			continue;
		}

		try {
			const pages = [];
			for (const rmFile of rmFiles) {
				const data = fs.readFileSync(path.join(dir, rmFile));
				const page = parseRmFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

				// Auto-detect extended pages (same logic as DocumentConverter)
				const defaultHeight = page.height; // 1872
				const threshold = defaultHeight * 1.05;
				let maxY = 0;
				for (const layer of page.layers) {
					for (const stroke of layer.strokes) {
						for (const pt of stroke.points) {
							if (pt.y > maxY) maxY = pt.y;
						}
					}
				}
				const scaledHeight = maxY * 0.885;
				if (scaledHeight > threshold) {
					page.height = scaledHeight;
				}

				pages.push(page);
			}

			let pdfBytes: Uint8Array;
			if (pages.length === 1) {
				pdfBytes = await renderPageToPdf(pages[0]);
			} else {
				pdfBytes = await renderNotebookToPdf(pages);
			}

			const outPath = path.join(OUTPUT_DIR, `${name}.pdf`);
			fs.writeFileSync(outPath, pdfBytes);
			console.log(`  [OK] ${name} — ${pages.length} page(s)`);
		} catch (e: any) {
			console.log(`  [ERR] ${name}: ${e.message}`);
		}
	}
}

main();
