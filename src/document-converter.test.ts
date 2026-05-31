/**
 * Tests for content-driven page-height extension.
 *
 * Regression test for the bug where long / vertically-scrolled pages were
 * clipped: page-height extension used to be gated behind the optional
 * `verticalScroll` metadata, so a long page that lacked it kept the default
 * height and had its content cut off at the bottom. Extension must be
 * content-driven (based on stroke bounds), matching the reference renderer.
 *
 * Run: npx tsx --test src/document-converter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extendPageHeightForContent } from "./document-converter";
import type { Page, Stroke } from "./rm-parser";

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

function makePage(maxY: number): Page {
	return {
		pageId: "page",
		layers: [{ name: "", strokes: [strokeReachingY(maxY)] }],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: DEFAULT_HEIGHT,
	};
}

test("normal-height content leaves the page height unchanged", () => {
	const page = makePage(1500);
	extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("long page (no verticalScroll metadata) is extended so content isn't clipped", () => {
	const maxY = 3000;
	assert.ok(maxY > THRESHOLD_MAX_Y, "test fixture must exceed the extension threshold");
	const page = makePage(maxY);
	extendPageHeightForContent(page);
	assert.equal(page.height, maxY * 0.885);
	assert.ok(page.height > DEFAULT_HEIGHT, "long page must be taller than the default");
});

test("content just past the screen but under the threshold is not extended", () => {
	// 2000 * 0.885 = 1770, which is below DEFAULT_HEIGHT * 1.05 (= 1965.6).
	const page = makePage(2000);
	assert.ok(2000 < THRESHOLD_MAX_Y);
	extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("a page with no strokes keeps the default height", () => {
	const page: Page = {
		pageId: "page",
		layers: [],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: DEFAULT_HEIGHT,
	};
	extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});
