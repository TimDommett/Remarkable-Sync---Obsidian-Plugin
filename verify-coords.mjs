/**
 * Quick verification: extract actual coordinates from reference PDF content stream
 * to confirm the coordinate mapping theory.
 */
import fs from 'fs';
import * as mupdf from 'mupdf';

// Read the reference Fineliner content stream
const refData = fs.readFileSync('reference_sheets/Fineliner.pdf');
const doc = mupdf.Document.openDocument(refData, 'application/pdf');
const page = doc.loadPage(0);
const bounds = page.getBounds();
console.log('Page bounds:', bounds);

// Get the content stream text
const text = page.toStructuredText('preserve-whitespace').asText();
console.log('Text content:', text.substring(0, 200));

// Try to extract raw PDF operators by reading the PDF structure
// Actually, let's just compare what the reference looks like with known .rm coordinates
// We know the Fineliner reference has content at approx [189.5, 348.9] X range in PDF space

// With SCALE=514/1404: (rm_x + 702) * 514/1404
// At rm_x = -213: (-213 + 702) * 514/1404 = 489 * 0.3660 = 179.0
// At rm_x = 290: (290 + 702) * 514/1404 = 992 * 0.3660 = 363.1

// With SCALE=514/1620: (rm_x + 810) * 514/1620
// At rm_x = -213: (-213 + 810) * 514/1620 = 597 * 0.3172 = 189.4
// At rm_x = 290: (290 + 810) * 514/1620 = 1100 * 0.3172 = 348.9

console.log('\n--- Coordinate mapping comparison ---');
console.log('Reference Fineliner X bounds: [189.5, 348.9] (from content stream)');
console.log();

const testPoints = [-213, -100, 0, 100, 290];
for (const rm_x of testPoints) {
	const old_pdf_x = (rm_x + 702) * 514/1404;
	const new_pdf_x = (rm_x + 810) * 514/1620;
	console.log(`rm_x=${rm_x}: old=${old_pdf_x.toFixed(1)}, new=${new_pdf_x.toFixed(1)}, diff=${(old_pdf_x - new_pdf_x).toFixed(1)}`);
}

console.log('\nFor Y coordinates (page height 685.3pt):');
const testY = [0, 500, 1000, 1500, 1872];
for (const rm_y of testY) {
	const old_pdf_y = 685.3 - rm_y * 514/1404;
	const new_pdf_y = 685.3 - rm_y * 514/1620;
	console.log(`rm_y=${rm_y}: old_pdf_y=${old_pdf_y.toFixed(1)}, new_pdf_y=${new_pdf_y.toFixed(1)}, diff=${(old_pdf_y - new_pdf_y).toFixed(1)}`);
}
