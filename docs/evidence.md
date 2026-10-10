# Evidence, and why the manuals are not in the app

## The problem

Five SCE manuals, 2,591 pages, 212 MB of source PDF, plus roughly 400 MB of
rendered page images and figure crops. Shipping all of that inside a desktop
app to make citations work is paying for the corpus twice over: once at install
and once in the reader, in exchange for a feature a citation barely needs.

A citation has to do one thing — let a planner check the answer against the
source of that exact location. It does not need the other 2,590 pages.

## What ships

| Layer | Ships | What it is |
|---|---|---|
| Manual | no | 212 MB of source PDF, an ingest input only |
| Layout | no | MinerU JSON, rebuildable from the manual |
| Render cache | no | 2x DPI page PNGs and figure crops, ~1–2 GB at full corpus |
| Index | **yes** | SQLite + FTS5: chunks, quotes, page labels, chapters, figure captions and OCR |
| Evidence images | **yes** | Downscaled page renders and figure crops under `public/evidence/<manual>/` |
| Page derivative | **yes** | A one-page PDF per cited location, generated at build time |
| Manual registry | **yes** | Title, issue, effective date, classification, numbering scheme |

What a citation resolves to:

```
manual + issue/version
+ printed page label or standard-sheet label
+ chapter / standard number
+ exact verified quote with character offsets into the chunk
+ relevant crop
+ one-page derivative of the cited page
```

That is complete for checking an answer. The full manual is a separate,
optional verification pack.

## Why the manual is not in the bundle

- **Size.** 212 MB of PDF against an app whose code and index are tens of
  megabytes. The index alone answers every question the app can answer.
- **Ambiguity.** The extracted ADS and DOH copies are subsets of larger
  manuals. A page number in the shipped PDF is not the page number in the
  manual a planner holds, so shipping the subset would produce citations that
  look checkable and are not.
- **Staleness.** Each manual is reissued quarterly. A bundled PDF is wrong the
  moment a new issue lands; an index built from a hashed source is rebuildable
  and says which issue it came from.

## Page identity is not the PDF index

Every manual is printed from one FrameMaker template. The running header is the
manual title; the footer carries the printed page label, the chapter or
standard number, the effective date and the section title. That footer is the
only stable citation address — the PDF index is an artefact of which pages
were extracted, and it does not survive the next issue.

`scripts/render/page-facts.py` reads the header and footer bands by text-matrix
position, because `extract_text()` on these files emits the footer as
unmerged fragments in arbitrary order.

Two numbering schemes exist, and the difference is not cosmetic:

| Manual | Numbering | A citation reads |
|---|---|---|
| ESR | pages | `ESR 3-24` |
| ADS | pages | `ADS 10-8` |
| PLM | pages | `PLM 2-12` |
| DOH | standard sheets | `DOH AC 120 Sheet 2 of 2` |
| UGS | standard sheets | `UGS CD 132 Sheet 2 of 2` |

There is no DOH page 402 to cite. The registry carries the scheme
(`src/lib/rag/docs.ts`) and `citeLabel()` composes from it, so no call site has
to remember which manuals are which.

## Building evidence

```bash
npm run parse:manuals          # MinerU layout, two at a time
npm run ingest:manuals         # chunks, crops, OCR, index
npm run build:evidence         # one-page derivatives + downscaled images
bash scripts/app/build-app.sh  # bundle, with a size budget check
```

Ingest is namespaced by manual id everywhere it generates a key — asset ids,
chunk ids, render-cache paths, evidence paths, citation links. Page numbers
repeat across manuals, so a shared key silently overwrites rather than fails.

## Classification

Each manual states its own classification on page one and in every footer:

| Manual | Classification |
|---|---|
| ESR | `SCE Public` |
| UGS | `SCE Public` |
| ADS | `SCE Confidential` |
| DOH | `SCE Internal` |
| PLM | `SCE Internal` |

The registry carries this so the UI can label a citation, and so anything that
*redistributes* a page — a one-page derivative, a crop — is a decision made
with the classification visible rather than inferred. DOH's copyright page
states that no part of the document may be reproduced or transmitted without
prior written permission; that is a fact about the document, recorded here so
the decision is made deliberately.
