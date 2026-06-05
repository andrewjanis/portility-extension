# Portility Extension — Bug Log

Bugs found during UAT testing. Each entry includes the test case ID, description, and repro steps.

Format: `[TEST-ID] [SEVERITY] — Description`
Severity: **P0** (blocker), **P1** (major), **P2** (minor), **P3** (cosmetic)

---

<!-- Add bugs below this line -->

## [T2.3] P1 — Tier not updating after Stripe upgrade

**Description:** After completing a Stripe checkout (free → Premium), reopening the popup still shows the free tier UI. The tier was only read from `chrome.storage.local` cache on popup load — never refreshed from Firestore.

**Root cause:** `checkUserTier()` only read the cached `userTier` from storage. The Stripe webhook correctly set the new tier in Firestore, but the extension never fetched it until a specific action triggered `refreshTierSilently()`.

**Fix:** Added a background Firestore tier fetch to `checkUserTier()` — shows cached tier immediately, then updates if the fresh tier differs. (`src/popup.js`)

## [T2.10] P1 — Second Opinion fails with "Invalid MIME type" on OpenAI API

**Description:** Second Opinion crashes with OpenAI error "Invalid MIME type. Only image types are supported." when the conversation contains non-image assets (PDFs, DOCXs, etc.).

**Root cause:** The OpenAI `/second-opinion` path sent all assets as `image_url` content blocks without filtering by MIME type. The Anthropic path correctly filtered with `data:image/...` regex, but the OpenAI path only checked for `dataUrl` existence.

**Fix:** Added `!(/^data:image\//i.test(oImg.dataUrl))` filter to skip non-image assets in the OpenAI path. (`worker/worker.js`)

## [T2.2] P1 — Phantom HTML artifact appears in image selector

**Description:** Image selection shows a non-existent HTML file as a selectable asset. Claude artifacts (rendered HTML previews) are detected as file attachments because they use the same `data-testid="file-thumbnail"` DOM marker as real uploaded files.

**Root cause:** `detectClaudeFileAttachments()` in `content.js` scans for `[data-testid="file-thumbnail"]` markers. Claude's artifact previews reuse the same DOM structure, so the function picks up artifact cards, clicks them to extract content via `extractFileViaClick()`, and produces a data URL from the rendered artifact HTML.

Additionally, the separate artifact detection (`[class*="artifact"]`) was matching every nested element inside artifact containers, creating duplicate bloated entries with the full rendered textContent as alt text.

**Fix:** (1) Added artifact container check in `detectClaudeFileAttachments` — skips any file-thumbnail inside `[class*="artifact"]` or `[data-testid*="artifact"]`. (2) Tightened artifact detection to only match outermost containers, deduplicate by title, and prefer aria-label/title attributes over raw textContent. (`src/content.js`)

## [T2.3-Gemini] P0 — Suggestion chips trigger never-ending loop on Gemini

**Description:** Gemini's follow-up suggestion buttons use the same `<generated-file>` custom element as real file cards. The file detection code clicks these, submitting new queries to Gemini and creating an infinite loop.

**Root cause:** `scanForGeneratedFileElements()` in `content-gemini.js` treats every `<generated-file>` element as a file card. Gemini reuses this element for suggestion chips, image captions, and other non-file content. These lack a `.file-name` child element and file type labels but were still processed and clicked.

**Fix:** Added guard in `scanForGeneratedFileElements` — skip elements that have neither a `.file-name` element nor a recognized file type label (PDF, DOCX, etc.). Real file cards always have at least one of these. (`src/content-gemini.js`)
