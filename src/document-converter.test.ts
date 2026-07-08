/**
 * Tests for the document converter.
 *
 * Covers two regression areas:
 *   - Content-driven page-height extension (long / vertically-scrolled pages
 *     were clipped because extension was gated behind optional metadata and
 *     ignored typed text).
 *   - Conversion of un-annotated imported PDFs (issue #16), which used to fail
 *     the whole document with "Can't embed page with missing Contents".
 *
 * Run: npx tsx --test src/document-converter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { convertDocument, extendPageHeightForContent } from "./document-converter";
import { computeTextBlocksBottomRawY } from "./pdf-renderer";
import type { Page, Stroke, TextBlock } from "./rm-parser";

const DEFAULT_HEIGHT = 1872;
// A page is extended only when maxY * 0.885 exceeds DEFAULT_HEIGHT * 1.05.
const THRESHOLD_MAX_Y = (DEFAULT_HEIGHT * 1.05) / 0.885; // ≈ 2221

function strokeReachingY(maxY: number): Stroke {
	return {
		penType: 0,
		color: 0,
		colorArgb: null,
		thicknessScale: 1,
		points: [
			{ x: 0, y: 0, speed: 0, direction: 0, width: 1, pressure: 1 },
			{ x: 0, y: maxY, speed: 0, direction: 0, width: 1, pressure: 1 },
		],
	};
}

// A text block of `lines` single-word lines (no wrapping, so the rendered line
// count is deterministic regardless of glyph widths) anchored at `posY`.
function textBlockAt(posY: number, lines: number, text?: string): TextBlock {
	return {
		text: text ?? Array.from({ length: lines }, () => "x").join("\n"),
		posX: -576,
		posY,
		width: 1152,
		paragraphStyles: new Map<number, number>(),
	};
}

function makePage(opts: { strokeMaxY?: number; textBlocks?: TextBlock[] }): Page {
	return {
		pageId: "page",
		layers: opts.strokeMaxY
			? [{ name: "", strokes: [strokeReachingY(opts.strokeMaxY)] }]
			: [],
		textSpans: [],
		textBlocks: opts.textBlocks ?? [],
		width: 1404,
		height: DEFAULT_HEIGHT,
	};
}

// --- Stroke-driven extension (existing behaviour, now async) ---

test("normal-height content leaves the page height unchanged", async () => {
	const page = makePage({ strokeMaxY: 1500 });
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("long page (no verticalScroll metadata) is extended so content isn't clipped", async () => {
	const maxY = 3000;
	assert.ok(maxY > THRESHOLD_MAX_Y, "test fixture must exceed the extension threshold");
	const page = makePage({ strokeMaxY: maxY });
	await extendPageHeightForContent(page);
	assert.equal(page.height, maxY * 0.885);
	assert.ok(page.height > DEFAULT_HEIGHT, "long page must be taller than the default");
});

test("content just past the screen but under the threshold is not extended", async () => {
	// 2000 * 0.885 = 1770, which is below DEFAULT_HEIGHT * 1.05 (= 1965.6).
	const page = makePage({ strokeMaxY: 2000 });
	assert.ok(2000 < THRESHOLD_MAX_Y);
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("a page with no strokes or text keeps the default height", async () => {
	const page = makePage({});
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

// --- Typed-text-driven extension (the new fix) ---

test("typed text below the strokes extends the page so it isn't clipped", async () => {
	// Strokes end well within a normal page; a long text block sits below them.
	const tb = textBlockAt(1800, 12);
	const page = makePage({ strokeMaxY: 1500, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(
		textBottom > THRESHOLD_MAX_Y,
		"fixture: text must extend past the threshold the strokes don't reach"
	);
	assert.ok(textBottom > 1500, "fixture: text must extend below the strokes");

	await extendPageHeightForContent(page);
	// Height is driven by the (lower) text bottom, not the strokes.
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
	assert.ok(page.height > DEFAULT_HEIGHT, "mixed text+drawing page must grow to fit the text");
});

test("text extent is honoured even when strokes already trigger extension", async () => {
	// Strokes already exceed the threshold, but the text reaches even lower —
	// the page must grow to the text, proving text isn't dropped once strokes
	// alone would extend the page.
	const tb = textBlockAt(2600, 4);
	const page = makePage({ strokeMaxY: 2300, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom > 2300, "fixture: text must reach below the strokes");

	await extendPageHeightForContent(page);
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
});

test("short typed text near the top neither shrinks nor extends a normal page", async () => {
	const tb = textBlockAt(234, 3); // a few lines near the default text anchor
	const page = makePage({ textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom < THRESHOLD_MAX_Y, "fixture: short text must stay under the threshold");

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("empty / whitespace-only text blocks are ignored", async () => {
	// Anchored very low, but with no real content — must contribute nothing,
	// mirroring renderTextBlock's `if (!tb.text.trim()) return`.
	const tb = textBlockAt(3000, 0, "   \n  ");
	const page = makePage({ textBlocks: [tb] });

	assert.equal(await computeTextBlocksBottomRawY(page), 0);

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

// --- Un-annotated imported PDFs (issue #16) ---
//
// A PDF imported to the reMarkable but never drawn on has pages with no .rm
// stroke data, so each page renders to a blank overlay with no /Contents
// stream. Merging that overlay onto the original PDF page used to throw pdf-lib's
// "Can't embed page with missing Contents" (the check runs lazily during save),
// and a missing `await` in mergeWithBackground let that rejection escape its
// try/catch and fail the whole document — every un-annotated PDF errored out.
// convertDocument must now produce the original PDF unchanged for these.

// A minimal reMarkable archive for an imported PDF with `pageCount` pages and no
// annotations, mirroring what the sync downloads: a .content listing the pages,
// a .metadata, and the original .pdf — but no per-page .rm files.
async function unannotatedPdfArchive(
	docId: string,
	pageSizes: [number, number][]
): Promise<Map<string, Uint8Array>> {
	const original = await PDFDocument.create();
	for (const [w, h] of pageSizes) {
		// Draw real content so the *background* has a /Contents stream; the bug is
		// about the blank annotation overlay, not the page being merged onto.
		original.addPage([w, h]).drawText("original page content", { x: 40, y: h - 60 });
	}
	const pdfBytes = new Uint8Array(await original.save());

	const pageIds = pageSizes.map((_, i) => `page-${i}`);
	const enc = (s: string) => new TextEncoder().encode(s);

	const files = new Map<string, Uint8Array>();
	files.set(`${docId}.pdf`, pdfBytes);
	files.set(`${docId}.metadata`, enc(JSON.stringify({ visibleName: "Imported PDF", type: "DocumentType" })));
	files.set(`${docId}.content`, enc(JSON.stringify({ fileType: "pdf", pages: pageIds })));
	// Deliberately NO `${docId}/<pageId>.rm` files — the pages are un-annotated.
	return files;
}

test("un-annotated single-page PDF converts and preserves the original page", async () => {
	const files = await unannotatedPdfArchive("doc1", [[612, 792]]);

	// Before the fix this rejected with "Can't embed page with missing Contents".
	const out = await convertDocument("doc1", files);

	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 1);
	// The output keeps the original PDF page size, proving the background was kept
	// rather than replaced by the 1404x1872 blank-annotation default.
	const { width, height } = doc.getPage(0).getSize();
	assert.equal(Math.round(width), 612);
	assert.equal(Math.round(height), 792);
});

test("un-annotated multi-page PDF converts every page", async () => {
	const files = await unannotatedPdfArchive("doc2", [
		[612, 792],
		[595, 842],
		[612, 792],
	]);

	const out = await convertDocument("doc2", files);

	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 3);
	// Each background page is preserved at its own size (incl. the A4 middle page).
	const sizes = doc.getPages().map((p) => {
		const s = p.getSize();
		return [Math.round(s.width), Math.round(s.height)];
	});
	assert.deepEqual(sizes, [
		[612, 792],
		[595, 842],
		[612, 792],
	]);
});

// --- Notebook template backgrounds ---
//
// A reMarkable notebook records each page's template (background) name in
// .content under cPages.pages[].template.value. That name used to be dropped by
// extractPages, and nothing drew a background, so templated notebooks (lined,
// grid, etc.) synced onto plain white. convertDocument must now capture the
// template and render it.

// A minimal notebook archive: a .content with cPages listing pages and their
// template names, a .metadata, and no .pdf (notebooks have no background PDF).
// Pages carry no .rm files, so they are empty — the template is still drawn.
function notebookArchive(docId: string, templates: (string | null)[]): Map<string, Uint8Array> {
	const enc = (s: string) => new TextEncoder().encode(s);
	const pages = templates.map((template, i) => ({
		id: `page-${i}`,
		...(template != null ? { template: { value: template } } : {}),
	}));
	const files = new Map<string, Uint8Array>();
	files.set(`${docId}.metadata`, enc(JSON.stringify({ visibleName: "Notebook", type: "DocumentType" })));
	files.set(`${docId}.content`, enc(JSON.stringify({ fileType: "notebook", cPages: { pages } })));
	return files;
}

test("a notebook template is captured and rendered as a page background", async () => {
	const blank = await convertDocument("nb-blank", notebookArchive("nb-blank", ["Blank"]));
	const lined = await convertDocument("nb-lined", notebookArchive("nb-lined", ["P Lines medium"]));

	// Both produce a valid single-page PDF...
	assert.equal((await PDFDocument.load(blank)).getPageCount(), 1);
	assert.equal((await PDFDocument.load(lined)).getPageCount(), 1);
	// ...but the lined page carries extra vector content (the ruled background)
	// that the blank page does not, proving the template was drawn.
	assert.ok(
		lined.byteLength > blank.byteLength,
		`lined (${lined.byteLength}) should exceed blank (${blank.byteLength})`
	);
});

test("an unsupported template warns and still converts (blank fallback)", async () => {
	const warnings: string[] = [];
	const out = await convertDocument(
		"nb-x",
		notebookArchive("nb-x", ["P Planner Weekly"]),
		(msg) => warnings.push(msg)
	);

	assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /P Planner Weekly/);
});
