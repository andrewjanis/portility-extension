# Portility — Automated Browser Test Plan

Automation-scoped test plan, executed by Claude Code via the `portility-qa-browser`
MCP server (`chrome-devtools-mcp` with `--categoryExtensions`, see `.mcp.json`).

This does **not** replace `test-protocol.md` / `test-protocol-v1.7.1-file-fixes.md` —
those remain the full manual regression protocols. Case IDs below that mirror a
manual case are cross-referenced (e.g. "mirrors T1.2").

Run via the `/run-portility-tests` skill (`.claude/skills/run-portility-tests/SKILL.md`).

## Prerequisites (one-time, manual)
- `portility-qa-browser` MCP server connected (restart Claude Code's MCP connections
  after `.mcp.json` is added/changed).
- Logged into chatgpt.com, claude.ai, and gemini.google.com inside the persistent
  profile at `.claude/qa/chrome-profile/` (open that profile once, sign in manually).
- Each platform has at least one existing conversation with a mix of text, 1–2
  images, and 1 uploaded file (see `test-protocol.md`'s "Test Conversation Setup").
- For Pro-tier cases (section 3 below): the signed-in test account already has an
  active trial or subscription. No Firestore scripting is done by this harness.

## Out of scope for v1 (stays manual)
Anything requiring hand-edited Firestore state: trial expiry, usage-limit exhaustion,
subscriber-tier downgrades — all of `test-protocol.md` Phase 3/4. Flagged as a
possible v2 (Firebase Admin SDK scripting) if wanted later.

---

## 1. Selector health (fast canary)

Purpose: catch DOM-shape regressions (like the 2026-10-09 ChatGPT breakage) in
seconds, without running a full extraction. Checks the content script's
**hardcoded fallback selectors** directly via `evaluate_script` against a real
conversation page — these are the selectors actually used unless a remote-config
override is cached (checked first, since that's what the live script would use).

> Keep the selector strings below in sync with the `HUMAN_SELECTOR(S)` /
> `AI_SELECTOR(S)` / `AI_CLASS_FRAGMENT` fallback constants in
> `src/content.js` (Claude), `src/content-chatgpt.js`, `src/content-gemini.js`
> if those are ever edited. This is intentional duplication — the content
> scripts don't expose their internal selector variables on `window`.

### A1 — Claude selector health
Platform: claude | Automatable: yes
1. `navigate_page` to an existing Claude conversation with ≥5 turns.
2. `evaluate_script`:
   - Check `await window.PortilityConfig.getRemoteSelectors('claude')` for an
     override; if null, use fallback `HUMAN_SELECTORS` = `['[data-testid="user-message"]', '[data-testid="human-turn"]', '[class*="human-turn"]', '[class*="HumanTurn"]']` (first selector with any matches wins) and the AI-turn selector = `[data-testid="assistant-message"], [class*="font-claude-response"]` (via `document.querySelectorAll(...)` — `data-testid` is the primary/stable match as of 2026-10-11; the class fragment is kept as a remote-overridable fallback).
   - Count matches for each side.
3. **Expected**: human-turn count > 0, AI-turn count > 0, and both roughly equal
   to the number of visible turns in the conversation.
4. **On failure**: capture `outerHTML` (truncated) of the nearest message
   container found by walking the DOM from any visible text turn, plus a
   `take_screenshot`.

### A2 — ChatGPT selector health (covers the 2026-10-09 regression class)
Platform: chatgpt | Automatable: yes
1. `navigate_page` to an existing ChatGPT conversation with ≥5 turns.
2. `evaluate_script`:
   - Check remote override via `window.PortilityConfig.getRemoteSelectors('chatgpt')`.
   - Else use fallback `HUMAN_SELECTOR` = `'[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]'`
     and `AI_SELECTOR` = `'[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]'`.
   - `document.querySelectorAll(HUMAN_SELECTOR)` / `AI_SELECTOR`, count matches.
3. **Expected**: both counts > 0 and roughly equal to visible turn count.
4. **On failure**: capture `outerHTML` of one message container + a screenshot —
   this is exactly the signal that would have caught today's bug immediately.

### A3 — Gemini selector health
Platform: gemini | Automatable: yes
1. `navigate_page` to an existing Gemini conversation with ≥5 turns.
2. `evaluate_script`:
   - Check remote override via `window.PortilityConfig.getRemoteSelectors('gemini')`.
   - Else use fallback `HUMAN_SELECTORS` = `['.user-query-text', '[data-turn-role="user"]', '.query-text', 'user-query']`
     and `AI_SELECTORS` = `['.model-response-text', '[data-turn-role="model"]', '.response-text', 'model-response']`
     (first selector in each list with any matches wins, mirrors the content script's own fallback order).
3. **Expected**: both counts > 0 and roughly equal to visible turn count.
4. **On failure**: capture `outerHTML` of one message container + a screenshot.

---

## 2. Core extraction (free tier)

### B1 — Port My Chat (free) → Gemini (mirrors T1.2)
Platform: claude | Automatable: yes
1. Navigate to a Claude conversation with text + images.
2. `trigger_extension_action` to open the popup, click **Port My Chat**.
3. Select **Gemini** as destination.
4. **Expected**: status progresses Extracting → Checking → Opening destination;
   a new Gemini tab opens with conversation text auto-pasted; no images (free tier).
5. **On failure**: capture popup `take_snapshot`, destination-tab screenshot,
   and `list_console_messages` from both tabs.

### B2 — Port My Chat (free) → Save as file (mirrors T1.3)
Platform: chatgpt | Automatable: yes
1. Navigate to a ChatGPT conversation.
2. Open popup, click **Port My Chat**, select **Save**.
3. **Expected**: `.txt` downloads with conversation content, filename derived
   from chat title.
4. **On failure**: capture popup snapshot + console messages.

### B3 — Port My Chat (free) → ChatGPT from Gemini (mirrors T1.4)
Platform: gemini | Automatable: yes
1. Navigate to a Gemini conversation.
2. Open popup, click **Port My Chat**, select **ChatGPT**.
3. **Expected**: new ChatGPT tab opens, text auto-pastes.
4. **On failure**: capture popup snapshot, destination-tab screenshot, console
   messages from both tabs.

---

## 3. Pro tier basics (requires active trial/subscription — skip if unavailable)

### C1 — Port My Chat Pro — text + images (mirrors T2.2)
Platform: claude → chatgpt | Automatable: yes (if trial/sub active)
1. Navigate to a Claude conversation with images.
2. Open popup, click **Port My Chat Pro**, select **ChatGPT** as destination.
3. Select 1–2 images on the image-selection screen.
4. **Expected**: ChatGPT tab opens, text auto-pastes, images upload.
5. **On failure**: capture image-selection screen snapshot, destination-tab
   screenshot, console messages.

### C2 — Port My Chat Pro — files (mirrors T2.3)
Platform: gemini → claude | Automatable: yes (if trial/sub active)
1. Navigate to a Gemini conversation with uploaded files.
2. Open popup, click **Port My Chat Pro**, select **Claude** as destination.
3. Select files on the file-selection screen.
4. **Expected**: Claude tab opens, project brief pastes, files upload.
5. **On failure**: capture file-selection snapshot, destination-tab screenshot,
   console messages.

### C3 — Port My Chat Pro — cross-platform image port (mirrors T2.6)
Platform: all pairs | Automatable: yes (if trial/sub active)
1. Claude → Gemini with images; then Gemini → ChatGPT; then ChatGPT → Claude.
2. **Expected**: images transfer via auto-paste in every direction.
3. **On failure**: capture destination-tab screenshot + console messages for
   the failing pair.

---

## 4. Edge cases

### D1 — Empty conversation (mirrors T5.6)
Platform: any | Automatable: yes
1. Navigate to a brand-new, empty conversation (no messages sent yet).
2. Open popup, click **Port My Chat**.
3. **Expected**: graceful error/empty-state message, no crash, no silent hang.
4. **On failure**: capture popup snapshot + console messages.

### D2 — Unsupported page (mirrors T5.7)
Platform: n/a | Automatable: yes
1. Navigate to a non-platform page (e.g. `https://example.com`).
2. `trigger_extension_action`.
3. **Expected**: popup shows an "unsupported page" state, not a blank/broken popup.
4. **On failure**: capture popup snapshot + console messages.

---

## Results tracking

Each run produces a dated report at `test-results/<ISO-timestamp>.md` with a
pass/fail table (same shape as `test-protocol.md`'s Results Tracker) and a
detailed section per failure. See `.claude/skills/run-portility-tests/SKILL.md`.
