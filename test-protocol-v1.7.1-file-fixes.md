# Test Protocol — v1.7.1 Fixes

Scoped protocol covering all v1.7.1 changes:

**File attachment fixes (commit `892d316`, 2026-07-16/17):**
1. Claude Office-doc/PDF attachments no longer silently dropped from the file picker
2. Files Portility can't auto-extract are now shown (disabled, with a reason) instead of vanishing
3. When multiple versions of the same document are detected, only the latest version is pre-checked
4. Garbage-text false-positive fixed: Claude's generic "can't preview, download to view" overlay text is no longer mistaken for real file content, which previously blocked the real download link from being used

**Second Opinion fixes (commits `1c327d3`, `08bbfe7`, deployed to `portility-proxy` worker 2026-07-17):**
5. The "Port My Chat" continuation header no longer leaks into the Second Opinion brief sent to `/second-opinion` and `/summarize-pro`
6. The Second Opinion evaluator no longer injects "what should be explored/done next" framing into agreements, divergences, or the restated key question — unless the user's original question actually asked for next steps

**Build under test:** `releases/portility-1.7.1-dev.zip` ("Portility DEV", red/pink icon)
**Worker under test:** `portility-proxy` (live at `https://portility-proxy.andrewjanis.workers.dev`), version `7b13b298`, deployed 2026-07-17 — Second Opinion fixes are server-side and apply regardless of which build (dev or production) you use

## Prerequisites
1. Unzip `portility-1.7.1-dev.zip` to a folder
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select the extracted folder
3. Confirm toolbar icon is the red/pink "DEV" variant (not blue/purple) — confirms you're testing the right build
4. Open DevTools console on each test tab before running (`F12` → Console) — the fixes rely on `[Portility] ...` diagnostic logs
5. You'll need a Claude.ai conversation with a `.docx`, `.xlsx`, or `.pptx` attached. If you don't have one, upload one now and ask Claude a question about it.

---

## T1 — Claude Office-doc attachment is detected (core bug fix)

1. On claude.ai, open the conversation with the `.docx`/`.xlsx`/`.pptx` attachment
2. Open the Portility popup → **Port My Chat Pro** → pick any AI destination (not Save)
3. Watch the console for `[Portility] Detected Claude file attachment: <filename> ...`
   - **Verify**: suffix is `(has URL)` or `(content extracted)` — NOT `(metadata only)`
   - If you see `(metadata only)`, also check for a logged line starting `[Portility] Overlay HTML (truncated):` — copy this, it's the diagnostic needed to extend the fix further
4. Wait for the "select files to include" screen
5. **Verify**: the Office doc now appears in the list (previously it never showed up at all)
6. **Verify**: its checkbox is enabled (not greyed out) and checked by default
7. **Verify**: the reason column does NOT say "Couldn't extract this file automatically"

## T2 — Ported file actually attaches at the destination

1. Continuing from T1, leave the file checked, click confirm/port
2. **Verify**: the destination chat tab opens and the conversation text auto-pastes
3. **Verify**: the file itself appears attached in the destination's message input box (drag-drop/file-input paste — existing `pasteImages()` logic, unchanged)
4. If the file didn't attach but text did: check console for `[Portility][Popup] Storing for paste:` log — confirm `hasDataUrl: true` for that file entry

## T3 — Unresolvable file is visible, not silently dropped (safety net)

Hard to force deterministically, but exercise the fallback path directly:

1. Find or create a Claude conversation with an attached file type Claude can't preview at all (e.g. an unusual/binary extension, or a very large PDF that fails to render)
2. Run **Port My Chat Pro** → any destination → reach the file-selection screen
3. **Verify**: the file still appears in the list (does NOT silently vanish)
4. **Verify**: its checkbox is disabled/greyed out
5. **Verify**: reason column reads *"Couldn't extract this file automatically — open the original conversation to download it manually"*
6. Click confirm/port
7. **Verify**: this file is NOT sent to the destination (only text + any other selected files port) — confirms disabled rows are excluded from the payload

## T4 — Document version dedup (only latest version pre-checked)

1. Find/create a conversation (Claude or ChatGPT) where the assistant produced two versions of the same document — e.g. filenames like `Report.pptx` + `Report_v2.pptx`, or `Report (1).pptx` + `Report (2).pptx`
   - If you don't have a real example, the screenshot case from this session works: ChatGPT conversation with `Behavioral_Signals_Along_the_Advisor_Journey.pptx` + `..._v2.pptx`
2. Run **Port My Chat Pro** → any destination → reach the file-selection screen
3. **Verify**: BOTH versions appear in the list (neither is hidden)
4. **Verify**: only the `_v2` (or higher-numbered) version is checked by default
5. **Verify**: the earlier version's checkbox is unchecked (but still enabled/clickable — user can still manually select it)
6. **Verify**: earlier version's reason column reads *"Earlier version of this document — a newer version was detected and pre-selected instead"*
7. Manually check the earlier version too, then port
8. **Verify**: both files are sent when manually selected (confirms the pre-check logic doesn't block manual override)

## T5 — Regression: plain image porting unaffected

1. Navigate to a Claude/ChatGPT/Gemini conversation with 1–2 uploaded/generated images (no files)
2. Run **Port My Chat Pro** → any destination
3. **Verify**: file-selection screen behaves exactly as before — images show with thumbnails, checked by default, "Detected in conversation" reason
4. Port and confirm images attach at the destination as usual

## T6 — Regression: ChatGPT/Gemini file porting unaffected

1. Repeat T1/T2 equivalent on a ChatGPT conversation with a real file attachment (code-interpreter output or upload) — this path uses `detectChatGPTFileAttachments()`, untouched by these fixes
2. **Verify**: still works as before (file detected via API, appears in picker, checked, ports successfully)
3. Repeat briefly on Gemini if a file-attachment conversation is available

## T7 — Second Opinion brief no longer contains "Port My Chat" header noise

1. Open a Claude/ChatGPT/Gemini conversation with a few back-and-forth messages
2. Open the Portility popup → **Second Opinion** → run it against another AI
3. When results appear, open **"View full brief"** / expand the underlying conversation text sent for scoring (or check the Network tab request body to `/second-opinion` if you want to confirm directly)
4. **Verify**: the brief does NOT start with the "Here is a previous conversation from another AI assistant... propose the next step..." header — it should start directly with the actual conversation content
5. **Verify**: Second Opinion scoring/comparison output still reads coherently (no missing context, no truncation)

## T8 — Second Opinion evaluator doesn't inject "next step" framing

1. Run **Second Opinion** on a conversation where the user's original question was a direct factual/analytical question (NOT one that asked "what should I do next" or "what should I explore next")
2. Review the comparison result's **"Key question"** / interpretation line and the **agreements/divergences** lists
3. **Verify**: the restated key question matches the user's actual original question — it does NOT get replaced with generic meta-commentary like "what should be explored/done next"
4. **Verify**: agreements/divergences focus on the actual answer content — no injected "next steps" or "what to explore next" bullets that weren't actually asked for
5. As a contrast check, repeat with a conversation where the user DID ask "what should I do next?" — **verify**: next-step framing IS allowed to appear in that case (confirms the fix is conditional, not an outright removal)

---

## Results Tracker

| Test | Status | Notes |
|------|--------|-------|
| T1 | | |
| T2 | | |
| T3 | | |
| T4 | | |
| T5 | | |
| T6 | | |
| T7 | | |
| T8 | | |
