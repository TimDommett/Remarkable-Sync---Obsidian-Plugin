/**
 * Reference Sheet Comparison Test
 *
 * Compares synced PDFs against reference PDFs exported from reMarkable.
 * Extracts drawing operations (colors, line widths, paths) from PDF content
 * streams and reports actionable discrepancies.
 *
 * Known architectural differences (reported as WARN, not FAIL):
 * - Reference PDFs render many pens (Pencil, Marker, Paintbrush, Calligraphy,
 *   Mechanical Pencil, Ballpoint) as filled polygons (f* operator), while our
 *   renderer uses stroked lines (S operator). This is a deliberate design choice.
 * - Template backgrounds (Grid, Lined) are not rendered by our converter.
 * - Shader colors use ARGB encoding with slight rounding differences vs reference.
 *
 * Usage: npx tsx compare-reference-sheets.ts [name]
 *   name: optional filter, e.g. "Shader" to only compare Shader.pdf
 */
import { PDFDocument, PDFPage, PDFName, PDFRawStream, PDFArray, PDFRef } from 'pdf-lib';
// @ts-ignore - internal pdf-lib API for decoding content streams
import { decodePDFRawStream } from 'pdf-lib/cjs/core/streams/decode';
import fs from 'fs';
import path from 'path';
// @ts-ignore - no type declarations
import pako from 'pako';

const REF_DIR = 'reference_sheets';
const SYNCED_DIR = 'reMarkable/RefrenceSheets';

// Tolerances
const PAGE_HEIGHT_TOLERANCE = 5.0;  // pt — extended pages are within ~5pt
const PAGE_WIDTH_TOLERANCE = 1.0;   // pt
const COLOR_TOLERANCE = 0.03;       // per channel — handles ARGB rounding
const WIDTH_TOLERANCE = 0.5;        // pt — for stroke width comparison

// --- PDF Content Stream Parser ---

interface DrawOp {
	type: 'stroke' | 'fill';
	color: string;      // "r,g,b" normalized to 4 decimal places
	lineWidth: number;
	opacity: number;
	pathBounds: { minX: number; minY: number; maxX: number; maxY: number };
	pointCount: number;
}

interface PageAnalysis {
	width: number;
	height: number;
	drawOps: DrawOp[];
	colors: Set<string>;
	lineWidths: number[];
	contentBounds: { minX: number; minY: number; maxX: number; maxY: number };
	rawOpsCount: number;
}

function decodeRawStream(stream: PDFRawStream): string {
	try {
		const decoded = decodePDFRawStream(stream).decode();
		return new TextDecoder().decode(decoded);
	} catch {
		const raw = stream.getContents();
		try {
			return new TextDecoder().decode(pako.inflate(raw));
		} catch {
			return new TextDecoder().decode(raw);
		}
	}
}

function decodeStreamArray(arr: PDFArray, context: any): string {
	const parts: string[] = [];
	for (let i = 0; i < arr.size(); i++) {
		const ref = arr.get(i);
		if (ref instanceof PDFRef) {
			const stream = context.lookup(ref);
			if (stream instanceof PDFRawStream) {
				parts.push(decodeRawStream(stream));
			}
		}
	}
	return parts.join('\n');
}

function getContentStream(page: PDFPage, doc: PDFDocument): string {
	const node = page.node;
	const contentsRef = node.get(PDFName.of('Contents'));

	if (!contentsRef) return '';

	const context = doc.context;

	if (contentsRef instanceof PDFArray) {
		return decodeStreamArray(contentsRef, context);
	}

	if (contentsRef instanceof PDFRef) {
		const obj = context.lookup(contentsRef);
		if (obj instanceof PDFRawStream) {
			return decodeRawStream(obj);
		}
		if (obj instanceof PDFArray) {
			return decodeStreamArray(obj, context);
		}
	}

	return '';
}

function parseContentStream(content: string, pageHeight: number): PageAnalysis {
	const drawOps: DrawOp[] = [];
	const colors = new Set<string>();
	const lineWidths: number[] = [];
	const contentBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

	let currentColor = '0.0000,0.0000,0.0000';
	let currentLineWidth = 1;
	let currentOpacity = 1;
	let pathPoints: { x: number; y: number }[] = [];
	let rawOpsCount = 0;

	const tokens = content.match(/[^\s]+/g) ?? [];
	const stack: string[] = [];

	for (const token of tokens) {
		rawOpsCount++;

		switch (token) {
			case 'rg':
			case 'RG': {
				if (stack.length >= 3) {
					const b = parseFloat(stack.pop()!);
					const g = parseFloat(stack.pop()!);
					const r = parseFloat(stack.pop()!);
					currentColor = `${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`;
					colors.add(currentColor);
				}
				break;
			}
			case 'g':
			case 'G': {
				if (stack.length >= 1) {
					const gray = parseFloat(stack.pop()!);
					currentColor = `${gray.toFixed(4)},${gray.toFixed(4)},${gray.toFixed(4)}`;
					colors.add(currentColor);
				}
				break;
			}

			case 'w': {
				if (stack.length >= 1) {
					currentLineWidth = parseFloat(stack.pop()!);
					lineWidths.push(currentLineWidth);
				}
				break;
			}

			case 'm': {
				if (stack.length >= 2) {
					const y = parseFloat(stack.pop()!);
					const x = parseFloat(stack.pop()!);
					pathPoints = [{ x, y }];
				}
				break;
			}
			case 'l': {
				if (stack.length >= 2) {
					const y = parseFloat(stack.pop()!);
					const x = parseFloat(stack.pop()!);
					pathPoints.push({ x, y });
				}
				break;
			}
			case 'c': {
				if (stack.length >= 6) {
					const y3 = parseFloat(stack.pop()!);
					const x3 = parseFloat(stack.pop()!);
					stack.pop(); stack.pop(); stack.pop(); stack.pop();
					pathPoints.push({ x: x3, y: y3 });
				}
				break;
			}
			case 're': {
				if (stack.length >= 4) {
					const h = parseFloat(stack.pop()!);
					const w = parseFloat(stack.pop()!);
					const y = parseFloat(stack.pop()!);
					const x = parseFloat(stack.pop()!);
					pathPoints = [{ x, y }, { x: x + w, y: y + h }];
				}
				break;
			}

			case 'S':
			case 's':
			case 'f':
			case 'F':
			case 'f*':
			case 'B':
			case 'B*':
			case 'b':
			case 'b*': {
				if (pathPoints.length > 0) {
					const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
					for (const pt of pathPoints) {
						bounds.minX = Math.min(bounds.minX, pt.x);
						bounds.minY = Math.min(bounds.minY, pt.y);
						bounds.maxX = Math.max(bounds.maxX, pt.x);
						bounds.maxY = Math.max(bounds.maxY, pt.y);
					}
					contentBounds.minX = Math.min(contentBounds.minX, bounds.minX);
					contentBounds.minY = Math.min(contentBounds.minY, bounds.minY);
					contentBounds.maxX = Math.max(contentBounds.maxX, bounds.maxX);
					contentBounds.maxY = Math.max(contentBounds.maxY, bounds.maxY);

					const isStroke = 'SsBbBb'.includes(token[0]);
					drawOps.push({
						type: isStroke ? 'stroke' : 'fill',
						color: currentColor,
						lineWidth: currentLineWidth,
						opacity: currentOpacity,
						pathBounds: bounds,
						pointCount: pathPoints.length,
					});
				}
				pathPoints = [];
				break;
			}

			case 'gs': { stack.pop(); break; }
			case 'q':
			case 'Q':
			case 'n':
			case 'h':
			case 'W':
			case 'W*':
				pathPoints = [];
				break;

			case 'Tf': { stack.pop(); stack.pop(); break; }
			case 'Td': { stack.pop(); stack.pop(); break; }
			case 'Tj':
			case 'TJ': { stack.pop(); break; }
			case 'cm': {
				for (let i = 0; i < 6 && stack.length > 0; i++) stack.pop();
				break;
			}

			default: {
				stack.push(token);
				break;
			}
		}
	}

	const uniqueWidths = [...new Set(lineWidths.map(w => Math.round(w * 100) / 100))].sort((a, b) => a - b);

	return {
		width: 0,
		height: pageHeight,
		drawOps,
		colors,
		lineWidths: uniqueWidths,
		contentBounds,
		rawOpsCount,
	};
}

// --- Color matching with tolerance ---

function parseColorString(c: string): [number, number, number] {
	const parts = c.split(',').map(Number);
	return [parts[0], parts[1], parts[2]];
}

function colorsMatch(c1: string, c2: string, tolerance: number): boolean {
	const [r1, g1, b1] = parseColorString(c1);
	const [r2, g2, b2] = parseColorString(c2);
	return Math.abs(r1 - r2) <= tolerance
		&& Math.abs(g1 - g2) <= tolerance
		&& Math.abs(b1 - b2) <= tolerance;
}

function findMatchingColor(color: string, colorSet: Set<string>, tolerance: number): string | null {
	for (const c of colorSet) {
		if (colorsMatch(color, c, tolerance)) return c;
	}
	return null;
}

// --- Comparison Logic ---

type Severity = 'pass' | 'warn' | 'fail';

interface Issue {
	severity: Severity;
	message: string;
}

interface ComparisonResult {
	name: string;
	severity: Severity;
	issues: Issue[];
	details: string[];
}

function maxSeverity(a: Severity, b: Severity): Severity {
	if (a === 'fail' || b === 'fail') return 'fail';
	if (a === 'warn' || b === 'warn') return 'warn';
	return 'pass';
}

async function comparePdf(name: string): Promise<ComparisonResult> {
	const refPath = path.join(REF_DIR, `${name}.pdf`);
	const syncedPath = path.join(SYNCED_DIR, `${name}.pdf`);
	const issues: Issue[] = [];
	const details: string[] = [];

	if (!fs.existsSync(refPath)) {
		return { name, severity: 'fail', issues: [{ severity: 'fail', message: `Missing reference: ${refPath}` }], details: [] };
	}
	if (!fs.existsSync(syncedPath)) {
		return { name, severity: 'fail', issues: [{ severity: 'fail', message: `Missing synced: ${syncedPath}` }], details: [] };
	}

	const refDoc = await PDFDocument.load(fs.readFileSync(refPath));
	const syncedDoc = await PDFDocument.load(fs.readFileSync(syncedPath));

	// Page count
	if (refDoc.getPageCount() !== syncedDoc.getPageCount()) {
		issues.push({ severity: 'fail', message: `Page count: ref=${refDoc.getPageCount()} synced=${syncedDoc.getPageCount()}` });
	}

	const pageCount = Math.min(refDoc.getPageCount(), syncedDoc.getPageCount());

	for (let i = 0; i < pageCount; i++) {
		const refPage = refDoc.getPage(i);
		const syncedPage = syncedDoc.getPage(i);
		const refSize = refPage.getSize();
		const syncedSize = syncedPage.getSize();
		const prefix = pageCount > 1 ? `P${i} ` : '';

		// --- Dimensions ---
		const wDiff = Math.abs(refSize.width - syncedSize.width);
		const hDiff = Math.abs(refSize.height - syncedSize.height);
		if (wDiff > PAGE_WIDTH_TOLERANCE || hDiff > PAGE_HEIGHT_TOLERANCE) {
			issues.push({ severity: 'fail', message: `${prefix}Size: ref=${refSize.width.toFixed(1)}x${refSize.height.toFixed(1)} synced=${syncedSize.width.toFixed(1)}x${syncedSize.height.toFixed(1)} (diff w=${wDiff.toFixed(1)} h=${hDiff.toFixed(1)})` });
		} else if (wDiff > 0.5 || hDiff > 0.5) {
			details.push(`${prefix}Size: within tolerance (diff w=${wDiff.toFixed(1)} h=${hDiff.toFixed(1)})`);
		}

		// --- Content stream analysis ---
		const refContent = getContentStream(refPage, refDoc);
		const syncedContent = getContentStream(syncedPage, syncedDoc);

		if (!refContent && !syncedContent) {
			details.push(`${prefix}Both empty (template page)`);
			continue;
		}

		const refAnalysis = parseContentStream(refContent, refSize.height);
		const syncedAnalysis = parseContentStream(syncedContent, syncedSize.height);

		// Detect rendering approach difference (fills vs strokes)
		const refStrokeOps = refAnalysis.drawOps.filter(o => o.type === 'stroke').length;
		const syncedStrokeOps = syncedAnalysis.drawOps.filter(o => o.type === 'stroke').length;
		const refFillOps = refAnalysis.drawOps.filter(o => o.type === 'fill').length;
		const syncedFillOps = syncedAnalysis.drawOps.filter(o => o.type === 'fill').length;
		// Rendering approach differs when:
		// 1. Ref uses only fills, synced uses only strokes (pure case)
		// 2. Ref has fills + template strokes, synced has only strokes (template pages like Grid, Lined, Checklist)
		const refHasFills = refFillOps > 0;
		const syncedUsesStrokes = syncedStrokeOps > 0 && syncedFillOps === 0;
		const renderingApproachDiffers = refHasFills && syncedUsesStrokes;

		if (renderingApproachDiffers) {
			issues.push({ severity: 'warn', message: `${prefix}Rendering: ref uses fills (${refFillOps}), synced uses strokes (${syncedStrokeOps}) [architectural]` });
		}

		details.push(`${prefix}Draw ops: ref=${refStrokeOps}s/${refFillOps}f synced=${syncedStrokeOps}s/${syncedFillOps}f`);

		// --- Colors (with tolerance) ---
		const refColors = [...refAnalysis.colors].sort();
		const syncedColors = [...syncedAnalysis.colors].sort();

		const unmatchedRef: string[] = [];
		const unmatchedSynced: string[] = [];

		for (const rc of refColors) {
			if (!findMatchingColor(rc, syncedAnalysis.colors, COLOR_TOLERANCE)) {
				unmatchedRef.push(rc);
			}
		}
		for (const sc of syncedColors) {
			if (!findMatchingColor(sc, refAnalysis.colors, COLOR_TOLERANCE)) {
				unmatchedSynced.push(sc);
			}
		}

		if (unmatchedRef.length > 0 && !renderingApproachDiffers) {
			issues.push({ severity: 'fail', message: `${prefix}Missing colors: ${unmatchedRef.map(c => `rgb(${c})`).join(', ')}` });
		} else if (unmatchedRef.length > 0) {
			// When rendering approaches differ, color count differences are expected
			issues.push({ severity: 'warn', message: `${prefix}Color differences (expected with fill/stroke): ${unmatchedRef.length} unmatched ref colors` });
		}

		if (unmatchedRef.length === 0 && unmatchedSynced.length === 0) {
			details.push(`${prefix}Colors match: ${refColors.length} ref / ${syncedColors.length} synced (tolerance=${COLOR_TOLERANCE})`);
		}

		// --- Line widths ---
		// Only compare widths when both sides use strokes (same rendering approach).
		// Use widths from actual stroke draw ops, not all `w` operator calls (which
		// include the default graphics state lineWidth=1.00).
		if (!renderingApproachDiffers) {
			const refStrokeWidths = [...new Set(
				refAnalysis.drawOps.filter(o => o.type === 'stroke').map(o => Math.round(o.lineWidth * 100) / 100)
			)].sort((a, b) => a - b);
			const syncedStrokeWidths = [...new Set(
				syncedAnalysis.drawOps.filter(o => o.type === 'stroke').map(o => Math.round(o.lineWidth * 100) / 100)
			)].sort((a, b) => a - b);

			if (refStrokeWidths.length > 0 && syncedStrokeWidths.length > 0) {
				const refWidthRange = `${refStrokeWidths[0].toFixed(2)}..${refStrokeWidths[refStrokeWidths.length-1].toFixed(2)}`;
				const syncedWidthRange = `${syncedStrokeWidths[0].toFixed(2)}..${syncedStrokeWidths[syncedStrokeWidths.length-1].toFixed(2)}`;

				const refMin = refStrokeWidths[0];
				const refMax = refStrokeWidths[refStrokeWidths.length - 1];
				const syncedMin = syncedStrokeWidths[0];
				const syncedMax = syncedStrokeWidths[syncedStrokeWidths.length - 1];

				const minDiff = Math.abs(refMin - syncedMin);
				const maxDiff = Math.abs(refMax - syncedMax);

				if (minDiff > WIDTH_TOLERANCE || maxDiff > WIDTH_TOLERANCE) {
					issues.push({ severity: 'fail', message: `${prefix}Stroke widths: ref=[${refWidthRange}] synced=[${syncedWidthRange}]` });
				} else {
					details.push(`${prefix}Stroke widths match: ref=[${refWidthRange}] synced=[${syncedWidthRange}]`);
				}
			} else if (refStrokeWidths.length === 0 && syncedStrokeWidths.length === 0) {
				details.push(`${prefix}No stroke ops to compare widths`);
			}
		} else {
			details.push(`${prefix}Line widths: skipped (different rendering approaches)`);
		}

		// --- Content bounds ---
		// Only compare when rendering approaches match; CTM coordinate transforms
		// make absolute bounds comparison unreliable across approaches.
		if (!renderingApproachDiffers && refAnalysis.contentBounds.minX !== Infinity && syncedAnalysis.contentBounds.minX !== Infinity) {
			const rb = refAnalysis.contentBounds;
			const sb = syncedAnalysis.contentBounds;

			const xMinDiff = Math.abs(rb.minX - sb.minX);
			const yMinDiff = Math.abs(rb.minY - sb.minY);
			const xMaxDiff = Math.abs(rb.maxX - sb.maxX);
			const yMaxDiff = Math.abs(rb.maxY - sb.maxY);

			if (xMinDiff > 10 || yMinDiff > 10 || xMaxDiff > 10 || yMaxDiff > 10) {
				issues.push({ severity: 'warn', message: `${prefix}Content bounds differ: ref=[${rb.minX.toFixed(1)},${rb.minY.toFixed(1)}]-[${rb.maxX.toFixed(1)},${rb.maxY.toFixed(1)}] synced=[${sb.minX.toFixed(1)},${sb.minY.toFixed(1)}]-[${sb.maxX.toFixed(1)},${sb.maxY.toFixed(1)}]` });
			}
		}

		// --- Per-color analysis (for highlighter/shader) ---
		if (name === 'Highlighter' || name === 'Shader') {
			const refByColor = new Map<string, DrawOp[]>();
			const syncedByColor = new Map<string, DrawOp[]>();

			for (const op of refAnalysis.drawOps) {
				const list = refByColor.get(op.color) ?? [];
				list.push(op);
				refByColor.set(op.color, list);
			}
			for (const op of syncedAnalysis.drawOps) {
				const list = syncedByColor.get(op.color) ?? [];
				list.push(op);
				syncedByColor.set(op.color, list);
			}

			details.push(`${prefix}Color breakdown:`);
			const allColors = new Set([...refByColor.keys(), ...syncedByColor.keys()]);
			for (const color of [...allColors].sort()) {
				const refOps = refByColor.get(color) ?? [];
				const syncedOps = syncedByColor.get(color) ?? [];
				const refW = refOps.length > 0 ? refOps.map(o => o.lineWidth) : [];
				const syncedW = syncedOps.length > 0 ? syncedOps.map(o => o.lineWidth) : [];
				const refWRange = refW.length > 0 ? `w=${Math.min(...refW).toFixed(2)}..${Math.max(...refW).toFixed(2)}` : '';
				const syncedWRange = syncedW.length > 0 ? `w=${Math.min(...syncedW).toFixed(2)}..${Math.max(...syncedW).toFixed(2)}` : '';

				// Check if this color matches something on the other side
				const matchedInSynced = findMatchingColor(color, syncedByColor.size > 0 ? new Set(syncedByColor.keys()) : new Set(), COLOR_TOLERANCE);
				const matchedInRef = findMatchingColor(color, refByColor.size > 0 ? new Set(refByColor.keys()) : new Set(), COLOR_TOLERANCE);

				let label = '';
				if (refOps.length === 0 && !matchedInRef) label = ' [EXTRA]';
				else if (syncedOps.length === 0 && !matchedInSynced) label = ' [MISSING]';
				else if (refOps.length === 0 && matchedInRef) label = ` [~${matchedInRef}]`;
				else if (syncedOps.length === 0 && matchedInSynced) label = ` [~${matchedInSynced}]`;

				details.push(`    rgb(${color}): ref=${refOps.length}ops ${refWRange} | synced=${syncedOps.length}ops ${syncedWRange}${label}`);
			}
		}
	}

	// Determine overall severity
	let overall: Severity = 'pass';
	for (const issue of issues) {
		overall = maxSeverity(overall, issue.severity);
	}

	return { name, severity: overall, issues, details };
}

// --- Main ---

async function main() {
	const filterName = process.argv[2];
	const refFiles = fs.readdirSync(REF_DIR)
		.filter(f => f.endsWith('.pdf'))
		.map(f => f.replace('.pdf', ''))
		.filter(f => !filterName || f.toLowerCase().includes(filterName.toLowerCase()))
		.sort();

	console.log(`\nComparing ${refFiles.length} reference sheets...\n`);

	let passed = 0;
	let warned = 0;
	let failed = 0;

	for (const name of refFiles) {
		const result = await comparePdf(name);

		const icon = result.severity === 'pass' ? 'PASS' : result.severity === 'warn' ? 'WARN' : 'FAIL';

		if (result.severity === 'pass') {
			console.log(`  [${icon}] ${name}`);
			passed++;
		} else if (result.severity === 'warn') {
			console.log(`  [${icon}] ${name}`);
			for (const issue of result.issues) {
				const tag = issue.severity === 'warn' ? 'warn' : 'FAIL';
				console.log(`         [${tag}] ${issue.message}`);
			}
			warned++;
		} else {
			console.log(`  [${icon}] ${name}`);
			for (const issue of result.issues) {
				const tag = issue.severity === 'warn' ? 'warn' : 'FAIL';
				console.log(`         [${tag}] ${issue.message}`);
			}
			failed++;
		}

		// Show details when filtered or when there are issues
		if (result.severity !== 'pass' || filterName) {
			for (const detail of result.details) {
				console.log(`         ${detail}`);
			}
		}

		console.log();
	}

	console.log(`${'='.repeat(60)}`);
	console.log(`Results: ${passed} passed, ${warned} warnings, ${failed} failed out of ${refFiles.length}`);
	console.log(`${'='.repeat(60)}`);

	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
