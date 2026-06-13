/**
 * Regression tests for background merging of un-annotated pages.
 *
 * Bug (issue #16): documents whose pages carry no annotations — unread imported
 * PDFs, the default "Go further" reMarkable doc, etc. — render to a blank
 * overlay with no /Contents stream. Merging that overlay onto the original PDF
 * page threw pdf-lib's "Can't embed page with missing Contents" during save.
 * Two compounding faults:
 *   1. `mergeWithBackground` used `return bgDoc.save()` (no `await`), so the
 *      save rejection escaped the surrounding try/catch and failed the whole
 *      document.
 *   2. Even once caught, the fallback returned the blank annotation, discarding
 *      the original PDF page content.
 * The fix skips embedding empty overlays, awaits the save, and falls back to the
 * background so the PDF's own content is preserved.
 *
 * Run: npx tsx --test src/pdf-renderer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { renderPageToPdf, renderNotebookToPdf } from "./pdf-renderer";
import type { Page } from "./rm-parser";

function emptyPage(id: string): Page {
	return {
		pageId: id,
		layers: [],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: 1872,
	};
}

async function backgroundPdf(label: string): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([600, 800]);
	page.drawText(label, { x: 50, y: 700 });
	return new Uint8Array(await doc.save());
}

test("blank annotation over a background does not throw (issue #16)", async () => {
	const background = await backgroundPdf("ORIGINAL");
	const out = await renderPageToPdf(emptyPage("a"), background);
	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 1);
	// Background content is preserved (page size comes from the background, not
	// the 1404x1872 annotation default).
	const { width } = doc.getPage(0).getSize();
	assert.equal(Math.round(width), 600);
});

test("notebook of blank annotations merges every background page", async () => {
	const out = await renderNotebookToPdf(
		[emptyPage("a"), emptyPage("b")],
		[await backgroundPdf("P1"), await backgroundPdf("P2")]
	);
	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 2);
});
