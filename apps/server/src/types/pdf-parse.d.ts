/**
 * Minimal ambient declaration for pdf-parse's internal entrypoint, which ships
 * without bundled types. We import the lib path directly to avoid the package's
 * debug harness that runs when the index module is imported.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
  }
  function pdf(dataBuffer: Buffer): Promise<PdfParseResult>;
  export default pdf;
}
