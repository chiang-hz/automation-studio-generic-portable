import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPagePdfFilename, localPdfFilenameTimestamp } from "../src/domain/localTimestamp.ts";
import { buildNativePagePdfOptions } from "../src/domain/pagePdf.ts";

test("PDF filename uses local YYYYMMDD_HHmmss and a PDF extension", () => {
  const local = new Date(2026, 9, 7, 10, 30, 0);
  assert.equal(localPdfFilenameTimestamp(local), "20261007_103000");
  assert.equal(buildPagePdfFilename("台灣銀行決算_品質檢測結果.pdf", "保存頁面 PDF", true, local), "台灣銀行決算_品質檢測結果_20261007_103000.pdf");
});

test("PDF filename replaces a stale timestamp, strips folders and forces .pdf", () => {
  const local = new Date(2026, 9, 7, 10, 30, 0);
  assert.equal(buildPagePdfFilename("C:\\reports\\檢測_20260101_000000.txt", "保存頁面 PDF", true, local), "檢測_20261007_103000.pdf");
  assert.equal(buildPagePdfFilename("結果.pdf", "保存頁面 PDF", false, local), "結果.pdf");
});

test("native PDF options preserve page size, orientation, background and bounded margins", () => {
  assert.deepEqual(buildNativePagePdfOptions({
    pdfPageSize: "Letter",
    pdfOrientation: "landscape",
    pdfPrintBackground: true,
    pdfMarginTopMm: 0,
    pdfMarginRightMm: 12.5,
    pdfMarginBottomMm: 99,
    pdfMarginLeftMm: Number.NaN,
    pdfDisplayHeaderFooter: true,
    pdfHeaderTemplate: '<div><span class="title"></span></div>',
    pdfFooterTemplate: '<div><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    pdfScale: 1.25
  }), {
    format: "Letter",
    landscape: true,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div><span class="title"></span></div>',
    footerTemplate: '<div><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    scale: 1.25,
    margin: { top: "0mm", right: "12.5mm", bottom: "50mm", left: "10mm" }
  });
});

test("header/footer settings and scale use safe PDF defaults and bounds", () => {
  assert.deepEqual(buildNativePagePdfOptions({ pdfScale: 3, pdfHeaderTemplate: "  " }), {
    format: "A4",
    landscape: false,
    printBackground: false,
    displayHeaderFooter: false,
    headerTemplate: undefined,
    footerTemplate: undefined,
    scale: 2,
    margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" }
  });
  assert.equal(buildNativePagePdfOptions({ pdfScale: 0 }).scale, 0.1);
  assert.equal(buildNativePagePdfOptions({ pdfScale: Number.NaN }).scale, 1);
});

test("designer exposes header/footer templates and the supported scale range", async () => {
  const app = await fs.readFile(path.resolve("public/app.js"), "utf8");
  assert.match(app, /id="pdfDisplayHeaderFooter"/);
  assert.match(app, /id="pdfHeaderTemplate"/);
  assert.match(app, /id="pdfFooterTemplate"/);
  assert.match(app, /id="pdfScale" type="number" min="10" max="200"/);
  assert.match(app, /function applyPendingStepProperties\(\)/);
  assert.match(app, /if \(!applyPendingStepProperties\(\)\) return;/);
  assert.match(app, /if \(state\.dirty && !\(await saveProject\(\)\)\) return;/);
});
