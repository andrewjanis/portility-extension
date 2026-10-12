# Portility Supplemental Test Run (ChatGPT cases) — 2026-10-12T13:51:24Z

> **Update (same session, post-run): fixed.** `src/content-chatgpt.js`'s `findHumanTurns()`
> now filters matches to outermost elements only (BUG-010), mirroring the existing
> `aiTurnSelector()` outermost-only treatment in `content.js` (BUG-005). Re-verified against
> both conversations in the Failures section below via the same production-code-replay
> method used to find the bug: "Funny Volleyball Names" now extracts each human turn exactly
> once (confirmed in the final formatted output, no duplicate line); "Financial Accounts"
> now reports `humanCount: 5` matching `aiCount: 5` (was `10` vs `5`). See **Fix
> Verification** at the bottom.

Follow-up to `2026-10-11T21-52-30Z.md`, which marked A2/B2/B3/C3 **BLOCKED** because the
CDP-attached `chrome-devtools-mcp` automation profile was hit with a Cloudflare Turnstile
challenge on every `chatgpt.com` navigation. This run retried those same cases through the
`claude-in-chrome` browser extension instead, driving the user's own logged-in Chrome
profile rather than a fresh automation-flagged CDP connection.

Extension: Portility (version as currently loaded in the user's regular Chrome profile,
not the isolated `.claude/qa/chrome-profile/` used by the other harness) | Platform: chatgpt.com

## Headline result

**The Cloudflare block is specific to the CDP/automation-profile connection path.**
`claude-in-chrome` reached chatgpt.com with zero Turnstile challenges, fully logged in,
across every navigation in this run. That unblocks A2/B2/B3/C3 as an automatable surface
going forward, with the caveat below about one interaction limitation in this tool.

**A new, real, high-severity bug was found and confirmed while running A2: every ChatGPT
conversation extracted by Portility right now has every human turn duplicated in the
output.** See "Failures" below. This is the ChatGPT-side counterpart to the Claude
`AI_CLASS_FRAGMENT` bug fixed yesterday (same category: a DOM shape change outran the
selector logic) — except here both the old and new selector generations are unioned
together deliberately (per the comment at `content-chatgpt.js:22-26`), and the *new*
generation's own nesting is what causes the duplication, not a missing selector.

## Summary

| Case | Platform | Result | Notes |
|------|----------|--------|-------|
| A2 | chatgpt | ~~FAIL~~ → **FIXED** | Human-turn selector matched two nested elements per real turn; AI-turn selector was unaffected; fixed and re-verified this session |
| B2 | chatgpt | **FIXED (inferred)** | Shares `extractMessages()`/`findHumanTurns()` with A2/B3/C3 — same fix applies to the saved `.txt` path |
| B3 | gemini→chatgpt | **BLOCKED (destination)** | Source extraction (Gemini) unaffected; pasting *into* ChatGPT wasn't exercised this run, see Methodology note |
| C3 | chatgpt leg | **FIXED (inferred)** | Same shared extraction path as A2; image handling itself wasn't separately exercised this run |

## Methodology note (read before the findings)

I was not able to reliably drive Portility's in-page floating widget (the teal/green "P"
circle) through `claude-in-chrome`'s synthetic click events — it opened its flyout menu
once, then stopped responding to further clicks/hovers across multiple attempts and a page
reload, likely a shadow-DOM or debounced-listener quirk in how the widget mounts, not
something I could fully diagnose without more intrusive DOM poking. Rather than report a
false "clicked the button, saw X" result, I instead:

1. Confirmed the real bug via direct DOM inspection against the live chatgpt.com page
   (outerHTML of the actual nested elements — see Evidence).
2. Replayed `content-chatgpt.js`'s actual `HUMAN_SELECTOR`/`AI_SELECTOR` constants and
   `content-shared.js`'s actual `extractElementText()` walker — copied verbatim from the
   current `src/` — against the live DOM via `evaluate_script`, reproducing exactly what
   `extractMessages()` would return, and confirmed the duplicate line appears in the final
   formatted output string.

This is a faithful replay of the production code path, not a guess, but it did not click
through the real popup/widget UI end-to-end. B3's *destination*-side paste and C3's image
upload step specifically still want a real click-through pass once the widget-interaction
issue is understood (flagged as a separate, smaller finding below).

## Failures

### A2 — ChatGPT human-turn selector matches twice per turn (new finding)

**Root cause**: `content-chatgpt.js:27` unions three selector generations:
```js
let HUMAN_SELECTOR = '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]';
```
On ChatGPT's current DOM (`data-message-author-role` no longer present anywhere — confirmed
via full-page scan), every human turn renders as two *nested* elements that both carry a
matching attribute:
```html
<div class="group/user-message flex flex-col items-end gap-2"
     data-chatgpt-search-unit-key="fallback-turn-0:0:user"
     data-chatgpt-search-message-ids="bffe0f31-7052-428b-b020-c6558014bc5b">
  <div class="w-full" data-content-search-unit-key="fallback-turn-0:0:user">
    <div class="group/user-message flex w-full flex-col gap-1 items-end">
      <div data-user-message-bubble="true" ...>...</div>
    </div>
  </div>
</div>
```
The outer `div` matches via `[data-chatgpt-search-unit-key$=":user"]`, the inner `div`
matches via `[data-content-search-unit-key$=":user"]` — both visible, both returned by
`querySelectorAll(HUMAN_SELECTOR)`. Unlike `content.js`'s AI-turn selector (which has an
explicit outermost-only filter, `aiTurnSelector()` / BUG-005), `findHumanTurns()` in
`content-chatgpt.js:61-64` has no such filter:
```js
function findHumanTurns(scope) {
  return Array.from(scope.querySelectorAll(HUMAN_SELECTOR))
    .filter(isElementVisible);
}
```
Both the outer and inner element pass `isElementVisible()`, so both end up in the returned
list. The AI-turn selector does **not** have this problem — in every conversation tested,
`aiCount` matched the real number of assistant replies exactly (no double-nesting on the
assistant side of this DOM shape).

**Expected** (per `tests/automation-test-plan.md` A2, adapted for ChatGPT): human-turn count
roughly equal to AI-turn count and to the visible turn count. **Actual**: human count is
consistently ~2x the real turn count. Tested on 3 separate real conversations in the user's
own ChatGPT history:
- "Growth mindset overview": 1 real human turn → 2 matched elements
- "Financial Accounts": 5 real human turns → 10 matched elements (not ported — financial
  account data, kept local to this inspection, never extracted/pasted)
- "Funny Volleyball Names": 2 real human turns → 4 matched elements

**Downstream impact (confirmed via production-code replay, see Methodology)**: in
`extractMessages()` (`content-chatgpt.js:170-197`), both matched elements for each human
turn get tagged `{ role: 'Human' }` and pushed into the final message list with no
dedup — producing this actual output from the "Funny Volleyball Names" conversation
(replayed with the real `extractElementText()` walker):
```
Human: i'm looking for funny volleyball team names that are a play on words or a pun
involving milk, cheese, butter, cows, seeds, animal food, Purina, Croplan or Land O'Lakes

Human: i'm looking for funny volleyball team names that are a play on words or a pun
involving milk, cheese, butter, cows, seeds, animal food, Purina, Croplan or Land O'Lakes

Assistant: ChatGPT said:
Absolutely. There's a lot of material here...
```
Every human line appears twice, back to back, in every ChatGPT-sourced port, right now, for
every user. This is a live, 100%-reproducible bug of the same class and severity as the
Claude `AI_CLASS_FRAGMENT` bug fixed yesterday — it affects the opposite role (human, not
AI) and the opposite platform (ChatGPT, not Claude), so it's a separate bug, not a
regression of yesterday's fix.

**Likely fix shape** (not applied — reporting only, per normal workflow): mirror
`content.js`'s BUG-005 treatment — either filter `findHumanTurns()`'s result to outermost
matches only (drop any element that is a DOM descendant of another match in the same list),
or narrow `HUMAN_SELECTOR` to prefer the innermost/most specific generation when both
`data-chatgpt-search-unit-key` and `data-content-search-unit-key` are present on nested
elements. Worth checking whether `AI_SELECTOR` has a parallel (just currently un-triggered)
nesting risk, since the comment at `content-chatgpt.js:22-26` suggests both selectors were
written to the same "union all generations" pattern.

**Evidence**:
- outerHTML of the real nested pair (above), captured from the "Financial Accounts"
  conversation, confirming `firstContainsSecond: true` / `secondContainsFirst: false`
  between the two matched elements for the same turn.
- Raw vs. visible-filtered counts across 3 conversations (above).
- Full replayed `extractMessages()` output showing the duplicate line (above), produced by
  running the actual `content-chatgpt.js` selector constants and `content-shared.js`'s
  actual `extractElementText()` function against the live page.
- `window.PortilityConfig` is not reachable from `claude-in-chrome`'s `javascript_tool`
  execution context (it runs in the page's main world; the extension's remote-config check
  lives in the content script's isolated world) — so `remoteOverride` couldn't be checked
  this way. This is a tooling limitation of this verification method, not a product finding;
  the `chrome-devtools-mcp` harness used yesterday *can* reach it (confirmed `null` then).

## Secondary finding — Portility floating widget stopped responding to clicks

Not part of the test plan, noticed incidentally while trying to drive B3/C3 end-to-end. On
the "Funny Volleyball Names" conversation, the floating widget's flyout menu
("Port My Profile" / "Port My Chat") opened successfully exactly once after the page
loaded. Every subsequent click on the widget (including after a full page reload) toggled
some visible state change (the icon repositioned, briefly showed a small "×" badge) but
never reopened the flyout. This may be specific to `claude-in-chrome`'s synthetic
click/hover event dispatch against whatever shadow-DOM or listener pattern the widget uses,
rather than a real product bug — flagging for awareness, not claiming it's reproducible
under normal mouse input. Did not investigate further; out of scope for this run.

## Fix Verification

Applied fix: `src/content-chatgpt.js`'s `findHumanTurns()` now filters its matches to
outermost elements only:
```js
function findHumanTurns(scope) {
  const all = Array.from(scope.querySelectorAll(HUMAN_SELECTOR))
    .filter(isElementVisible);
  return all.filter(function (el) {
    return !el.parentElement || !el.parentElement.closest(HUMAN_SELECTOR);
  });
}
```
This mirrors the existing outermost-only treatment `content.js` already applies to Claude's
AI-turn selector (BUG-005) — labeled BUG-010 here since it's the ChatGPT/human-turn
counterpart. No change was made to `AI_SELECTOR`/`findAiTurns()`, since no duplication was
observed there in any conversation tested.

Re-verified via the same production-code-replay method used to find the bug (the extension
itself was not reloaded/re-clicked through the UI — see Methodology note above for why):

- **"Funny Volleyball Names" re-run**: `findHumanTurns()` now returns 2 elements (was 4) for
  2 real human turns; `findAiTurns()` still returns 2 (unchanged). Full replayed
  `extractMessages()` output now reads:
  ```
  Human: i'm looking for funny volleyball team names that are a play on words or a pun
  involving milk, cheese, butter, cows, seeds, animal food, Purina, Croplan or Land O'Lakes

  Assistant: ChatGPT said:
  Absolutely. There's a lot of material here...
  ```
  — the human turn now appears exactly once, immediately followed by the real assistant
  reply, with no duplicate line.
- **"Financial Accounts" re-run** (counts only — this conversation's content was never
  extracted or pasted anywhere, per the privacy note above): `findHumanTurns()` now returns
  5 (was 10), matching `findAiTurns()`'s 5 exactly.

## Not re-run this session

A1, A3, B1, C1, C2, D1, D2 — already covered in `2026-10-11T21-52-30Z.md` and not affected
by anything in this supplemental run.
