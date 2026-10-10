/**
 * The manual registry.
 *
 * Five SCE standards manuals, one shape of footer, five numbering schemes.
 * Every manual is printed from the same FrameMaker template, so a page's
 * running header is its manual title and its footer carries the printed page
 * label, the chapter/sheet id, the effective date and the section title. That
 * footer is the only reliable place a citation can get its identity from: the
 * PDF page index is an artefact of which pages were extracted, not something a
 * planner can look up.
 *
 * The distinction that matters is numbering. ESR, ADS and PLM number pages
 * ("PAGE 3-24"), so a citation is "ESR 3-24". DOH and UGS number *standards
 * sheets* ("AC 120 Sheet 2 of 2"), so there is no page 402 to cite at all —
 * a citation is "DOH AC 120 Sheet 2". Treating those as one numbering scheme
 * is what would make a cross-manual citation meaningless, so the type is in the
 * registry rather than inferred at each call site.
 */

export type ManualId = "esr" | "ads" | "doh" | "plm" | "ugs";

/** How a citation points at a location inside a manual. */
export type ManualNumbering = "page" | "sheet";

/**
 * What the manual's own footer says about who it is for. Read from page one of
 * each PDF rather than assumed, because the distinction decides whether a page
 * may be redistributed at all.
 */
export type ManualClassification = "public" | "internal" | "confidential";

export type Manual = {
  id: ManualId;
  /** Three/four letter code as crews say it out loud: "DOH", "UGS". */
  code: string;
  /** Full title as printed on page one, without the code in parentheses. */
  title: string;
  /** Source PDF filename, resolved against the manual directory. */
  fileName: string;
  /** Issue line from page one, e.g. "2026 Third Quarter Issue". */
  issue: string;
  /** Effective date from the footer, ISO-ish as printed: "07-31-2026". */
  effectiveDate: string;
  classification: ManualClassification;
  numbering: ManualNumbering;
  /** Page count as shipped; a mismatch against the PDF means a bad copy. */
  pageCount: number;
};

/**
 * Printed from one FrameMaker template, verified against page footers in all
 * five manuals. `PAGE` is the printed page label on page-numbered manuals;
 * page-numbered chapters read `ESR-3`, `ADS-10`, `PLM-2`.
 */
const PAGE_NUMBERED = {
  printedPage: /^PAGE\s+(.+)$/i,
  chapter: /^(?:ESR|ADS|PLM)[-–—]\s*(\d+)$/i,
  effectiveDate: /^(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/,
} as const;

/**
 * Sheet-numbered manuals put the standard number and sheet count in the
 * footer instead: `AC 120` + `Sheet` + `2` + `of` + `2`. The chapter is the
 * standard number, which is what a planner actually cites.
 */
const SHEET_NUMBERED = {
  sheet: /^([A-Z]{2,4}\s*\d{2,4})$/,
  sheetOf: /^Sheet$/i,
  sheetCount: /^(?:of)\s*(\d{1,4})$/i,
  effectiveDate: /^(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/,
} as const;

export const MANUALS: Record<ManualId, Manual> = {
  esr: {
    id: "esr",
    code: "ESR",
    title: "Electrical Service Requirements",
    fileName: "Electrical Service Requirements (ESR).pdf",
    issue: "2022 Fourth Quarter Issue",
    effectiveDate: "10-28-2022",
    classification: "public",
    numbering: "page",
    pageCount: 282,
  },
  ads: {
    id: "ads",
    code: "ADS",
    title: "Applicant Distribution Design Standards",
    fileName: "Extracted Pages from Applicant Distribution Design Standards (ADS).pdf",
    issue: "2026 Third Quarter Issue",
    effectiveDate: "07-31-2026",
    classification: "confidential",
    numbering: "page",
    pageCount: 157,
  },
  doh: {
    id: "doh",
    code: "DOH",
    title: "Distribution Overhead Construction Standards",
    fileName: "Extracted Pages from Distribution Overhead Construction Standards (DOH).pdf",
    issue: "2026 Third Quarter Issue",
    effectiveDate: "07-31-2026",
    classification: "internal",
    numbering: "sheet",
    pageCount: 1126,
  },
  plm: {
    id: "plm",
    code: "PLM",
    title: "Pole Loading Manual",
    fileName: "Pole Loading Manual (PLM).pdf",
    issue: "2026 Third Quarter Issue",
    effectiveDate: "07-31-2026",
    classification: "internal",
    numbering: "page",
    pageCount: 258,
  },
  ugs: {
    id: "ugs",
    code: "UGS",
    title: "Underground Structures Standards",
    fileName: "UGS.pdf",
    issue: "2026 Third Quarter Issue",
    effectiveDate: "09-25-2026",
    classification: "public",
    numbering: "sheet",
    pageCount: 768,
  },
};

export const MANUAL_IDS = Object.keys(MANUALS) as ManualId[];

export const isManualId = (value: string): value is ManualId =>
  Object.prototype.hasOwnProperty.call(MANUALS, value);

export const manual = (id: string | null | undefined): Manual | null =>
  id && isManualId(id) ? MANUALS[id] : null;

/**
 * What a citation row reads.
 *
 * Page-numbered manuals cite the printed page: "ESR 3-24". Sheet-numbered
 * manuals cite the standard and sheet: "DOH AC 120 Sheet 2 of 2". The PDF
 * index never appears — a planner cannot use it, and for the extracted
 * manuals it is not even stable across issues.
 */
export const citeLabel = (
  id: ManualId,
  printedPage: string | null,
  chapter: string | null,
  sheet: string | null,
  sheetOf: number | null,
  sheetCount: number | null
): string => {
  const m = MANUALS[id];
  if (m.numbering === "sheet") {
    const std = sheet ?? chapter;
    if (!std) return m.code;
    return sheetOf && sheetCount
      ? `${m.code} ${std} Sheet ${sheetOf} of ${sheetCount}`
      : `${m.code} ${std}`;
  }
  return printedPage ? `${m.code} ${printedPage}` : m.code;
};

/** Serialisable footer rules for the Python page-facts worker. */
export const footerRulesFor = (id: ManualId) => ({
  id,
  code: MANUALS[id].code,
  numbering: MANUALS[id].numbering,
  ...(MANUALS[id].numbering === "page" ? PAGE_NUMBERED : SHEET_NUMBERED),
});

/**
 * Where a citation opens.
 *
 * Not the manual. A citation points at the evidence generated for that one
 * cited page — the crop plus a single-page PDF carrying the page's text and
 * vector drawing — because the corpus is 2,591 pages of source PDF that has no
 * business being inside an app bundle. What a citation has to let a planner do
 * is check the answer against the source of that location, and a one-page
 * derivative does that; the full manual is a separate, optional pack.
 *
 * The PDF page index appears in this path and nowhere else. It is the only
 * stable address the derived evidence has.
 */
export const evidencePageLink = (id: ManualId, page: number): string =>
  `/evidence/${id}/pdf/page-${page}.pdf`;

export const evidenceImageLink = (id: ManualId, name: string): string =>
  `/evidence/${id}/${name}`;
