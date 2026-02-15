/**
 * Pixel-to-pixel PDF comparison tool.
 *
 * Rasterizes reference and synced PDFs using MuPDF (WASM), then compares
 * pixel by pixel. Generates diff images and reports metrics.
 *
 * Usage: node compare-pixels.mjs [name] [--dpi=150]
 *   name: optional filter, e.g. "Shader" to only compare Shader.pdf
 *   --dpi=N: render resolution (default 150)
 *
 * Output: pixel-diffs/ directory with:
 *   - <name>_ref.png     — rasterized reference
 *   - <name>_synced.png  — rasterized synced output
 *   - <name>_diff.png    — difference visualization (red = different pixels)
 *   - <name>_overlay.png — side-by-side: ref | diff | synced
 *   - summary.txt        — comparison metrics
 */
import fs from 'fs';
import path from 'path';
import { createCanvas } from 'canvas';
import * as mupdf from 'mupdf';

const REF_DIR = 'reference_sheets';
const SYNCED_DIR = 'reMarkable/RefrenceSheets';
const OUTPUT_DIR = 'pixel-diffs';
const DEFAULT_DPI = 150;

// --- PDF Rasterization via MuPDF ---

function renderPdfPage(pdfPath, pageNum, dpi) {
	const data = fs.readFileSync(pdfPath);
	const doc = mupdf.Document.openDocument(data, 'application/pdf');
	const page = doc.loadPage(pageNum);
	const scale = dpi / 72;
	const matrix = mupdf.Matrix.scale(scale, scale);
	const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
	const width = pixmap.getWidth();
	const height = pixmap.getHeight();
	const samples = pixmap.getPixels();
	// mupdf RGB (3 bytes/px) → RGBA (4 bytes/px) for canvas
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = samples[i * 3];
		rgba[i * 4 + 1] = samples[i * 3 + 1];
		rgba[i * 4 + 2] = samples[i * 3 + 2];
		rgba[i * 4 + 3] = 255;
	}
	return { pixels: rgba, width, height };
}

function getPageCount(pdfPath) {
	const data = fs.readFileSync(pdfPath);
	const doc = mupdf.Document.openDocument(data, 'application/pdf');
	return doc.countPages();
}

// --- Pixel Comparison ---

function pixelsToCanvas(pixels, width, height) {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	const imgData = ctx.createImageData(width, height);
	imgData.data.set(pixels);
	ctx.putImageData(imgData, 0, 0);
	return canvas;
}

function compareImages(refPixels, refW, refH, syncPixels, syncW, syncH, threshold = 32) {
	const maxW = Math.max(refW, syncW);
	const maxH = Math.max(refH, syncH);

	const refCanvas = pixelsToCanvas(refPixels, refW, refH);
	const syncedCanvas = pixelsToCanvas(syncPixels, syncW, syncH);

	const diffCanvas = createCanvas(maxW, maxH);
	const diffCtx = diffCanvas.getContext('2d');
	diffCtx.fillStyle = 'white';
	diffCtx.fillRect(0, 0, maxW, maxH);
	const diffImgData = diffCtx.createImageData(maxW, maxH);

	const gap = 10;
	const labelH = 24;
	const overlayCanvas = createCanvas(maxW * 3 + gap * 2, maxH + labelH);
	const overlayCtx = overlayCanvas.getContext('2d');
	overlayCtx.fillStyle = '#e0e0e0';
	overlayCtx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);

	let differentPixels = 0;
	let sumSquaredError = 0;
	let maxDiff = 0;
	let diffMinX = maxW, diffMinY = maxH, diffMaxX = 0, diffMaxY = 0;

	for (let y = 0; y < maxH; y++) {
		for (let x = 0; x < maxW; x++) {
			const diffIdx = (y * maxW + x) * 4;

			let rR = 255, rG = 255, rB = 255;
			if (x < refW && y < refH) {
				const idx = (y * refW + x) * 4;
				rR = refPixels[idx]; rG = refPixels[idx + 1]; rB = refPixels[idx + 2];
			}

			let sR = 255, sG = 255, sB = 255;
			if (x < syncW && y < syncH) {
				const idx = (y * syncW + x) * 4;
				sR = syncPixels[idx]; sG = syncPixels[idx + 1]; sB = syncPixels[idx + 2];
			}

			const dR = Math.abs(rR - sR);
			const dG = Math.abs(rG - sG);
			const dB = Math.abs(rB - sB);
			const channelMax = Math.max(dR, dG, dB);

			sumSquaredError += (dR * dR + dG * dG + dB * dB) / 3;
			if (channelMax > maxDiff) maxDiff = channelMax;

			if (channelMax > threshold) {
				differentPixels++;
				const intensity = Math.min(255, channelMax * 3);
				diffImgData.data[diffIdx] = intensity;
				diffImgData.data[diffIdx + 1] = 0;
				diffImgData.data[diffIdx + 2] = 0;
				diffImgData.data[diffIdx + 3] = 255;

				if (x < diffMinX) diffMinX = x;
				if (y < diffMinY) diffMinY = y;
				if (x > diffMaxX) diffMaxX = x;
				if (y > diffMaxY) diffMaxY = y;
			} else {
				diffImgData.data[diffIdx] = Math.floor(rR * 0.3 + 255 * 0.7);
				diffImgData.data[diffIdx + 1] = Math.floor(rG * 0.3 + 255 * 0.7);
				diffImgData.data[diffIdx + 2] = Math.floor(rB * 0.3 + 255 * 0.7);
				diffImgData.data[diffIdx + 3] = 255;
			}
		}
	}

	diffCtx.putImageData(diffImgData, 0, 0);

	overlayCtx.drawImage(refCanvas, 0, labelH);
	overlayCtx.drawImage(diffCanvas, maxW + gap, labelH);
	overlayCtx.drawImage(syncedCanvas, maxW * 2 + gap * 2, labelH);

	overlayCtx.fillStyle = 'black';
	overlayCtx.font = 'bold 16px sans-serif';
	overlayCtx.fillText('Reference', 10, 18);
	overlayCtx.fillText('Diff (red = different)', maxW + gap + 10, 18);
	overlayCtx.fillText('Synced', maxW * 2 + gap * 2 + 10, 18);

	const totalPixels = maxW * maxH;

	// Content cut off detection
	let cutoffBottom = 0;
	if (refH > syncH) {
		for (let y = syncH; y < refH; y++) {
			for (let x = 0; x < refW; x += 4) {
				const idx = (y * refW + x) * 4;
				if (refPixels[idx] < 240 || refPixels[idx + 1] < 240 || refPixels[idx + 2] < 240) {
					cutoffBottom++;
					break;
				}
			}
		}
	}

	return {
		metrics: {
			totalPixels,
			differentPixels,
			matchPercent: ((totalPixels - differentPixels) / totalPixels) * 100,
			rmse: Math.sqrt(sumSquaredError / totalPixels),
			maxDiff,
			diffBounds: differentPixels > 0
				? { minX: diffMinX, minY: diffMinY, maxX: diffMaxX, maxY: diffMaxY }
				: null,
			cutoffBottom,
		},
		diffCanvas,
		overlayCanvas,
		refCanvas,
		syncedCanvas,
	};
}

// --- Main ---

async function comparePdf(name, dpi) {
	const refPath = path.join(REF_DIR, `${name}.pdf`);
	const syncedPath = path.join(SYNCED_DIR, `${name}.pdf`);

	if (!fs.existsSync(refPath)) {
		console.log(`  [SKIP] ${name} — no reference PDF`);
		return null;
	}
	if (!fs.existsSync(syncedPath)) {
		console.log(`  [SKIP] ${name} — no synced PDF`);
		return null;
	}

	const refPageCount = getPageCount(refPath);
	const syncedPageCount = getPageCount(syncedPath);
	const pageCount = Math.min(refPageCount, syncedPageCount);

	if (refPageCount !== syncedPageCount) {
		console.log(`  ${name}: page count mismatch (ref=${refPageCount} synced=${syncedPageCount})`);
	}

	let totalDiff = 0;
	let totalPixels = 0;
	let totalCutoff = 0;
	let worstRmse = 0;

	for (let i = 0; i < pageCount; i++) {
		const suffix = pageCount > 1 ? `_p${i}` : '';

		const ref = renderPdfPage(refPath, i, dpi);
		const synced = renderPdfPage(syncedPath, i, dpi);

		const { metrics, diffCanvas, overlayCanvas, refCanvas, syncedCanvas } = compareImages(
			ref.pixels, ref.width, ref.height,
			synced.pixels, synced.width, synced.height
		);

		fs.writeFileSync(path.join(OUTPUT_DIR, `${name}${suffix}_ref.png`), refCanvas.toBuffer('image/png'));
		fs.writeFileSync(path.join(OUTPUT_DIR, `${name}${suffix}_synced.png`), syncedCanvas.toBuffer('image/png'));
		fs.writeFileSync(path.join(OUTPUT_DIR, `${name}${suffix}_diff.png`), diffCanvas.toBuffer('image/png'));
		fs.writeFileSync(path.join(OUTPUT_DIR, `${name}${suffix}_overlay.png`), overlayCanvas.toBuffer('image/png'));

		totalDiff += metrics.differentPixels;
		totalPixels += metrics.totalPixels;
		totalCutoff = Math.max(totalCutoff, metrics.cutoffBottom);
		worstRmse = Math.max(worstRmse, metrics.rmse);

		const pct = metrics.matchPercent.toFixed(2);
		const sizeInfo = `ref=${ref.width}x${ref.height} synced=${synced.width}x${synced.height}`;
		const cutInfo = metrics.cutoffBottom > 0 ? ` [${metrics.cutoffBottom}rows cut off!]` : '';
		console.log(`  ${name}${suffix}: ${pct}% match | ${sizeInfo} | ${metrics.differentPixels} diff px | RMSE=${metrics.rmse.toFixed(1)}${cutInfo}`);
	}

	return {
		totalPixels,
		differentPixels: totalDiff,
		matchPercent: totalPixels > 0 ? ((totalPixels - totalDiff) / totalPixels) * 100 : 100,
		rmse: worstRmse,
		cutoffBottom: totalCutoff,
	};
}

async function main() {
	const args = process.argv.slice(2);
	let filterName = null;
	let dpi = DEFAULT_DPI;

	for (const arg of args) {
		if (arg.startsWith('--dpi=')) {
			dpi = parseInt(arg.slice(6), 10);
		} else {
			filterName = arg;
		}
	}

	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	const refFiles = fs.readdirSync(REF_DIR)
		.filter(f => f.endsWith('.pdf'))
		.map(f => f.replace('.pdf', ''))
		.filter(f => !filterName || f.toLowerCase().includes(filterName.toLowerCase()))
		.sort();

	console.log(`\nPixel comparison of ${refFiles.length} reference sheets at ${dpi} DPI\n`);

	const results = [];

	for (const name of refFiles) {
		try {
			const metrics = await comparePdf(name, dpi);
			if (metrics) {
				results.push({ name, metrics });
			}
		} catch (e) {
			console.log(`  [ERROR] ${name}: ${e.message}`);
		}
		console.log();
	}

	// Summary table sorted worst to best
	console.log('='.repeat(80));
	console.log('PIXEL COMPARISON SUMMARY');
	console.log('='.repeat(80));
	console.log(`${'Name'.padEnd(22)} ${'Match%'.padStart(8)} ${'DiffPx'.padStart(10)} ${'RMSE'.padStart(8)} ${'CutOff'.padStart(8)}`);
	console.log('-'.repeat(80));

	for (const r of results.sort((a, b) => a.metrics.matchPercent - b.metrics.matchPercent)) {
		const cutoff = r.metrics.cutoffBottom > 0 ? `${r.metrics.cutoffBottom}rows` : '-';
		console.log(
			`${r.name.padEnd(22)} ${r.metrics.matchPercent.toFixed(2).padStart(7)}% ${r.metrics.differentPixels.toString().padStart(10)} ${r.metrics.rmse.toFixed(1).padStart(8)} ${cutoff.padStart(8)}`
		);
	}

	console.log('='.repeat(80));
	console.log(`\nDiff images saved to: ${OUTPUT_DIR}/`);
	console.log('Open *_overlay.png for side-by-side: Reference | Diff | Synced');

	const summaryLines = results.map(r =>
		`${r.name}: ${r.metrics.matchPercent.toFixed(2)}% match, ${r.metrics.differentPixels} diff pixels` +
		(r.metrics.cutoffBottom > 0 ? `, ${r.metrics.cutoffBottom} rows cut off` : '')
	);
	fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.txt'), summaryLines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
