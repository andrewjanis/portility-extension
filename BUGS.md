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
