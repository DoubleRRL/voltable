#!/usr/bin/env osascript -l JavaScript
// Render one PDF page to PNG using macOS-native PDFKit.
//
// Replaces pdfjs-dist + node-canvas, which silently produced blank white
// images under Node (page.render() resolved without drawing anything).
// Zero dependencies, correct output, verified visually.
//
// usage: osascript -l JavaScript render-page.js <pdf> <page1indexed> <out.png> [scale]

ObjC.import("AppKit");
ObjC.import("Quartz");

function run(argv) {
  if (argv.length < 4) {
    throw new Error(
      "usage: render-page.js <pdf> <page1indexed> <out.png> [scale]"
    );
  }
  const pdfPath = argv[0];
  const pageNumber = parseInt(argv[1], 10);
  const outPath = argv[2];
  const scale = argv.length > 3 ? parseFloat(argv[3]) : 2.0;

  if (!isNaN(pageNumber) && pageNumber < 1) {
    throw new Error(`page must be >= 1, got ${pageNumber}`);
  }

  const url = $.NSURL.fileURLWithPath($(pdfPath).stringByStandardizingPath);
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc) {
    throw new Error(`cannot open PDF: ${pdfPath}`);
  }

  const index = pageNumber - 1;
  if (index >= doc.pageCount) {
    throw new Error(
      `page ${pageNumber} out of range; document has ${doc.pageCount} pages`
    );
  }

  const page = doc.pageAtIndex(index);
  const bounds = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  const w = Math.round(bounds.size.width * scale);
  const h = Math.round(bounds.size.height * scale);

  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h));
  img.lockFocus;
  $.NSColor.whiteColor.set;
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, w, h));
  const ctx = $.NSGraphicsContext.currentContext;
  ctx.saveGraphicsState;
  $.CGContextScaleCTM(ctx.CGContext, scale, scale);
  page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, ctx.CGContext);
  ctx.restoreGraphicsState;
  img.unlockFocus;

  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  if (!rep) {
    throw new Error("failed to rasterise page to bitmap");
  }
  const png = rep.representationUsingTypeProperties(
    $.NSBitmapImageFileTypePNG,
    $.NSDictionary.dictionary
  );
  if (!png) {
    throw new Error("failed to encode PNG");
  }
  if (!png.writeToFileAtomically($(outPath).stringByStandardizingPath, true)) {
    throw new Error(`failed to write ${outPath}`);
  }
  return `ok ${w}x${h}`;
}