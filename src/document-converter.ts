/**
 * Document Converter
 *
 * Full pipeline from reMarkable ZIP archive to PDF:
 * 1. Extract .rm files and metadata from ZIP
 * 2. Parse .rm files to get strokes and text
 * 3. Render to PDF with optional background
 */

import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { parseRmFile, type Page } from "./rm-parser";
import { renderPageToPdf, renderNotebookToPdf } from "./pdf-renderer";

// --- Data structures ---

export interface PageInfo {
	pageId: string;
	rmData: Uint8Array | null;
	template: string | null;
	verticalScroll: number | null;
}

export interface DocumentContent {
	docId: string;
	docType: "notebook" | "pdf" | "epub";
	name: string;
	pages: PageInfo[];
	originalPdf: Uint8Array | null;
	originalEpub: Uint8Array | null;
	metadata: Record<string, any>;
}

// --- Converter ---

export class DocumentConverter {
	private docId: string;
	private zipData: Uint8Array;
	private content: DocumentContent | null = null;
	private contentInfo: Record<string, any> = {};

	constructor(docId: string, zipData: Uint8Array) {
		this.docId = docId;
		this.zipData = zipData;
	}

	async parse(): Promise<DocumentContent> {
		if (this.content) return this.content;

		const zip = await JSZip.loadAsync(this.zipData);
		const fileList = Object.keys(zip.files);

		const metadata = await this.readMetadata(zip);
		this.contentInfo = await this.readContentInfo(zip);
		const docType = this.determineDocType(this.contentInfo, fileList);
		const pages = await this.extractPages(zip, this.contentInfo);
		const originalPdf = await this.extractOriginalPdf(zip, fileList);
		const originalEpub = await this.extractOriginalEpub(zip, fileList);

		this.content = {
			docId: this.docId,
			docType,
			name: metadata.visibleName ?? "Untitled",
			pages,
			originalPdf,
			originalEpub,
			metadata,
		};

		return this.content;
	}

	async convertToPdf(): Promise<Uint8Array> {
		const content = await this.parse();

		if (content.pages.length === 0) {
			throw new Error("No pages found in document");
		}

		const parsedPages: Page[] = [];
		const backgroundPdfs: (Uint8Array | null)[] = [];

		for (let i = 0; i < content.pages.length; i++) {
			const pageInfo = content.pages[i];

			if (pageInfo.rmData) {
				try {
					const page = parseRmFile(new Uint8Array(pageInfo.rmData).buffer.slice(
						pageInfo.rmData.byteOffset,
						pageInfo.rmData.byteOffset + pageInfo.rmData.byteLength
					));
					page.pageId = pageInfo.pageId;

					// Extend page height for vertically scrolled pages.
					// The 0.885 scale factor accounts for the difference between
					// raw stroke coordinate bounds and reMarkable's export bounds.
					// Only extend if content significantly exceeds the default height.
					if (pageInfo.verticalScroll != null) {
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
					}

					parsedPages.push(page);
				} catch {
					parsedPages.push(emptyPage(pageInfo.pageId));
				}
			} else {
				parsedPages.push(emptyPage(pageInfo.pageId));
			}

			if (content.originalPdf) {
				try {
					const bgPage = await this.extractPdfPage(content.originalPdf, i);
					backgroundPdfs.push(bgPage);
				} catch {
					backgroundPdfs.push(null);
				}
			} else {
				backgroundPdfs.push(null);
			}
		}

		if (parsedPages.length === 1) {
			return renderPageToPdf(parsedPages[0], backgroundPdfs[0] ?? undefined);
		}
		return renderNotebookToPdf(parsedPages, backgroundPdfs);
	}

	// --- ZIP processing ---

	private async readMetadata(zip: JSZip): Promise<Record<string, any>> {
		for (const name of Object.keys(zip.files)) {
			if (name.endsWith(".metadata")) {
				try {
					const text = await zip.files[name].async("text");
					return JSON.parse(text);
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private async readContentInfo(zip: JSZip): Promise<Record<string, any>> {
		for (const name of Object.keys(zip.files)) {
			if (name.endsWith(".content")) {
				try {
					const text = await zip.files[name].async("text");
					return JSON.parse(text);
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private determineDocType(
		contentInfo: Record<string, any>,
		fileList: string[]
	): "notebook" | "pdf" | "epub" {
		for (const name of fileList) {
			if (name.endsWith(".pdf")) return "pdf";
			if (name.endsWith(".epub")) return "epub";
		}
		const fileType = contentInfo.fileType ?? "";
		if (fileType === "pdf") return "pdf";
		if (fileType === "epub") return "epub";
		return "notebook";
	}

	private async extractPages(
		zip: JSZip,
		contentInfo: Record<string, any>
	): Promise<PageInfo[]> {
		const fileList = Object.keys(zip.files);
		let pageIds: string[] = contentInfo.pages ?? [];

		// Check cPages (newer format) and extract per-page metadata
		const cPages = contentInfo.cPages;
		const pageVerticalScroll = new Map<string, number>();
		if (cPages && cPages.pages) {
			pageIds = cPages.pages.map((p: any) => {
				const id = typeof p === "object" ? p.id ?? p : p;
				if (typeof p === "object" && p.verticalScroll?.value != null) {
					pageVerticalScroll.set(id, p.verticalScroll.value);
				}
				return id;
			});
		}

		// Fallback: scan for .rm files
		if (pageIds.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					if (!pageIds.includes(stem)) {
						pageIds.push(stem);
					}
				}
			}
		}

		const pages: PageInfo[] = [];

		for (const pageId of pageIds) {
			const pageInfo: PageInfo = {
				pageId,
				rmData: null,
				template: null,
				verticalScroll: pageVerticalScroll.get(pageId) ?? null,
			};

			// Find .rm file
			for (const name of fileList) {
				if (name.endsWith(`${pageId}.rm`)) {
					try {
						pageInfo.rmData = await zip.files[name].async("uint8array");
					} catch {
						// ignore
					}
					break;
				}
			}

			// Find page metadata
			for (const name of fileList) {
				if (name.includes(`${pageId}-metadata.json`)) {
					try {
						const text = await zip.files[name].async("text");
						const meta = JSON.parse(text);
						pageInfo.template = meta.template ?? null;
					} catch {
						// ignore
					}
				}
			}

			pages.push(pageInfo);
		}

		// Final fallback: grab any .rm files
		if (pages.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					try {
						const rmData = await zip.files[name].async("uint8array");
						pages.push({ pageId: stem, rmData, template: null, verticalScroll: null });
					} catch {
						// ignore
					}
				}
			}
		}

		return pages;
	}

	private async extractOriginalPdf(
		zip: JSZip,
		fileList: string[]
	): Promise<Uint8Array | null> {
		for (const name of fileList) {
			if (name.endsWith(".pdf") && !name.endsWith("-metadata.pdf")) {
				try {
					return await zip.files[name].async("uint8array");
				} catch {
					// ignore
				}
			}
		}
		return null;
	}

	private async extractOriginalEpub(
		zip: JSZip,
		fileList: string[]
	): Promise<Uint8Array | null> {
		for (const name of fileList) {
			if (name.endsWith(".epub")) {
				try {
					return await zip.files[name].async("uint8array");
				} catch {
					// ignore
				}
			}
		}
		return null;
	}

	private async extractPdfPage(
		pdfData: Uint8Array,
		pageNum: number
	): Promise<Uint8Array | null> {
		try {
			const srcDoc = await PDFDocument.load(pdfData);
			if (pageNum >= srcDoc.getPageCount()) return null;

			const newDoc = await PDFDocument.create();
			const [copiedPage] = await newDoc.copyPages(srcDoc, [pageNum]);
			newDoc.addPage(copiedPage);
			return new Uint8Array(await newDoc.save());
		} catch {
			return null;
		}
	}
}

function emptyPage(pageId: string): Page {
	return {
		pageId,
		layers: [],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: 1872,
	};
}

export async function convertDocument(
	docId: string,
	zipData: Uint8Array
): Promise<Uint8Array> {
	const converter = new DocumentConverter(docId, zipData);
	return converter.convertToPdf();
}
