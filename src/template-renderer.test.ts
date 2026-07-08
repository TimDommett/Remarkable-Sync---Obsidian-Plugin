/**
 * Tests for template (page background) resolution and rendering.
 *
 * Run: npx tsx --test src/template-renderer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { resolveTemplate, drawTemplate, type TemplateEnv } from "./template-renderer";

// --- resolveTemplate: name → spec mapping ---

test("blank / unset templates resolve to a blank spec (nothing to warn about)", () => {
	for (const name of [null, undefined, "", "Blank", "P Blank"]) {
		const spec = resolveTemplate(name);
		assert.ok(spec, `expected a spec for ${JSON.stringify(name)}`);
		assert.equal(spec!.kind, "blank");
	}
});

test("the real reMarkable name 'P Lines medium' resolves to lines/medium", () => {
	const spec = resolveTemplate("P Lines medium");
	assert.deepEqual(spec, { kind: "lines", size: "medium" });
});

test("grid / dots / checklist are detected before plain lines", () => {
	assert.equal(resolveTemplate("P Grid medium")!.kind, "grid");
	assert.equal(resolveTemplate("P Dots medium")!.kind, "dots");
	assert.equal(resolveTemplate("Checklist")!.kind, "checklist");
	// A checklist contains rules but must not be mistaken for plain lines.
	assert.notEqual(resolveTemplate("Checklist")!.kind, "lines");
});

test("size is parsed from the name, defaulting to medium", () => {
	assert.equal(resolveTemplate("P Lines small")!.size, "small");
	assert.equal(resolveTemplate("P Lines large")!.size, "large");
	assert.equal(resolveTemplate("P Lines")!.size, "medium");
	assert.equal(resolveTemplate("LS Grid large")!.size, "large");
});

test("unsupported templates resolve to null so the caller can fall back + warn", () => {
	assert.equal(resolveTemplate("P Planner Weekly"), null);
	assert.equal(resolveTemplate("Music Staff"), null);
	assert.equal(resolveTemplate("Perspective 1"), null);
});

// --- drawTemplate: actually emits vector content ---

const ENV: TemplateEnv = { pageWidthPt: 514, pageHeightPt: 685.3, coordScale: 514 / 1620 };

async function renderedSize(template: string | null): Promise<number> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([ENV.pageWidthPt, ENV.pageHeightPt]);
	const spec = resolveTemplate(template);
	if (spec) drawTemplate(page, spec, ENV);
	return (await doc.save()).byteLength;
}

test("a lines template adds drawing content vs a blank page", async () => {
	const blank = await renderedSize("Blank");
	const lines = await renderedSize("P Lines medium");
	assert.ok(lines > blank, `lines (${lines}) should be larger than blank (${blank})`);
});

test("a grid template adds more content than lines (it adds verticals too)", async () => {
	const lines = await renderedSize("P Lines medium");
	const grid = await renderedSize("P Grid medium");
	assert.ok(grid > lines, `grid (${grid}) should be larger than lines (${lines})`);
});

test("an unsupported template draws nothing (same size as blank)", async () => {
	const blank = await renderedSize("Blank");
	const unsupported = await renderedSize("Music Staff");
	assert.equal(unsupported, blank);
});
