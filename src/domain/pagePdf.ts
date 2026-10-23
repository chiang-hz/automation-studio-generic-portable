export interface PagePdfConfiguration {
  pdfPageSize?: "A4" | "Letter";
  pdfOrientation?: "portrait" | "landscape";
  pdfPrintBackground?: boolean;
  pdfMarginTopMm?: number;
  pdfMarginRightMm?: number;
  pdfMarginBottomMm?: number;
  pdfMarginLeftMm?: number;
  pdfDisplayHeaderFooter?: boolean;
  pdfHeaderTemplate?: string;
  pdfFooterTemplate?: string;
  pdfScale?: number;
}

export interface NativePagePdfOptions {
  format: "A4" | "Letter";
  landscape: boolean;
  printBackground: boolean;
  displayHeaderFooter: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  scale: number;
  margin: { top: string; right: string; bottom: string; left: string };
}

function marginMm(value: unknown): string {
  const numeric = Number(value ?? 10);
  return `${Math.min(50, Math.max(0, Number.isFinite(numeric) ? numeric : 10))}mm`;
}

function pdfScale(value: unknown): number {
  const numeric = Number(value ?? 1);
  return Math.min(2, Math.max(0.1, Number.isFinite(numeric) ? numeric : 1));
}

function templateHtml(value: unknown): string | undefined {
  const text = String(value ?? "");
  return text.trim() ? text.slice(0, 10_000) : undefined;
}

export function buildNativePagePdfOptions(configuration: PagePdfConfiguration): NativePagePdfOptions {
  return {
    format: configuration.pdfPageSize === "Letter" ? "Letter" : "A4",
    landscape: configuration.pdfOrientation === "landscape",
    printBackground: configuration.pdfPrintBackground === true,
    displayHeaderFooter: configuration.pdfDisplayHeaderFooter === true,
    headerTemplate: templateHtml(configuration.pdfHeaderTemplate),
    footerTemplate: templateHtml(configuration.pdfFooterTemplate),
    scale: pdfScale(configuration.pdfScale),
    margin: {
      top: marginMm(configuration.pdfMarginTopMm),
      right: marginMm(configuration.pdfMarginRightMm),
      bottom: marginMm(configuration.pdfMarginBottomMm),
      left: marginMm(configuration.pdfMarginLeftMm)
    }
  };
}
