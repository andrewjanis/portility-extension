# Chrome Web Store Listing Update — Portility v1.0.0

This replaces the stale v1.5.0 guide in `release/`. It reflects what the code in `src/`
actually does today, verified by reading `manifest.json` and grepping for real usage of
each permission — not copied forward from an older draft.

---

## ⚠️ Blocking issues to resolve before/at submission

1. **`http://portility.ai/help` returns 404.** The Help icon added to all 6 extension
   pages (popup, Settings, Manage Port Me, Second Opinion result, Rating, SO History)
   links here. Needs a real page before upload, or ship with the icon hidden/removed.
2. **Screenshots are stale.** `store/screenshots/screenshot1.png` and `screenshot2.png`
   are dated mid-April — before profiles, Second Opinion, the tier system, and the new
   Help icon existed. See "Screenshots" section below for a fresh shot list.

✅ **Done:** `<all_urls>`, `copilot.microsoft.com`, and `login.microsoftonline.com` have
been removed from `manifest.json` (they were unused — no Copilot content script,
destination, or Microsoft OAuth code anywhere in `src/`). The description field and
`store/listing.md` no longer mention Copilot. `releases/portility-1.0.0.zip` has been
rebuilt with these changes — that's the file to upload.

---

## Store Listing tab

### Extension Name
```
Portility
```

### Summary (132 characters max)
```
Move AI conversations between Claude, ChatGPT, and Gemini, get a second opinion, and carry your custom instructions everywhere.
```

### Description
See `store/listing.md` for the full copy (also pasted below for convenience).

```
Portility makes it easy to move your AI conversations between platforms and get a second opinion — all in one click.

SUPPORTED PLATFORMS
• Claude (claude.ai)
• ChatGPT (chatgpt.com)
• Gemini (gemini.google.com)

KEY FEATURES

Port My Chat
Export any conversation from one AI platform and continue it seamlessly on another. Copy the full conversation, get an AI-generated summary, or save it as a .txt file — then pick up right where you left off with full context intact.

Second Opinion
Get an instant second take on any AI response. With one click, Portility sends the conversation to another AI model and shows a side-by-side comparison with an agreement score, shared themes, and key differences.

Port My Profile
Create custom instruction profiles — for work, home, hobbies, and more — and carry them across platforms. Define how you like to work once, and every AI you use will know it.

HOW IT WORKS
1. Visit any supported AI platform
2. Click the Portility icon in your toolbar
3. Choose "Port My Chat" to export, "Second Opinion" to compare, or manage your profiles from Settings
4. Portility handles the formatting and transfer automatically

PRIVACY & SECURITY
• Conversation content is processed to power features like Second Opinion and AI summaries, but is not retained by Portility after processing
• Second Opinion results are cached locally in your browser for a short time so you can review them
• Google Sign-In is used for authentication; saved profile data is encrypted
• No conversation data is sold or shared with third parties

Portility is currently free to use during our beta — every feature, including Second Opinion and custom Profiles, is unlocked for signed-in users. Visit https://portility.ai for more information.
```

### Category
Productivity

### Language
English

### Icon
128×128 icon is bundled in the ZIP at `icons/icon128.png` — Chrome picks it up automatically.

---

## Screenshots

Current `store/screenshots/` (2 images, 1280×800) predate profiles, Second Opinion, and
the tier system. Recommend retaking a 4–5 image set covering current functionality:

1. **Popup — main view** — shows Port My Chat / Port My Profile / Second Opinion buttons
   and the new Help icon in the header next to the gear.
2. **Second Opinion — results page** (`comparison.html`) — score, theme table, Help icon
   top-right.
3. **Port My Profile — Manage page** (`portme-manage.html`) — profiles list (up to 5),
   Help icon top-right.
4. **Settings page** (`options.html`) — toggles + Help icon next to "Settings" heading.
5. *(Optional)* **Rating page** or **SO History** — shows the feedback loop.

I can't capture these myself (no browser automation available in this environment) —
you'll need to load the unpacked extension, walk through each flow, and screenshot at
1280×800. Once captured, drop them in `store/screenshots/` and re-upload via the
Developer Dashboard (listing image changes go live immediately, no review needed).

Promo images (`store/small_promo.png` 440×280, `store/marquee_promo.png` 1400×560) are
logo/branding based and don't show in-product UI — these can likely stay as-is unless
you want to refresh the branding.

---

## Privacy tab

### Single Purpose Description
```
Portility helps users move conversations between AI platforms (Claude, ChatGPT, Gemini) and compare AI responses side-by-side.
```

### Permission Justifications

Matches the actual `permissions` array in `src/manifest.json`:

| Permission | Justification |
|---|---|
| **activeTab** | Grants temporary access to the current tab when the user clicks the toolbar icon, so Portility can detect the AI platform and read the conversation. |
| **alarms** | Schedules an hourly background refresh of remote config (feature flags, destination URLs) so the extension stays up to date without the user reopening it. |
| **clipboardWrite** | Used when the user clicks "Copy Conversation" to copy formatted chat text to the clipboard. |
| **storage** | Stores user preferences, authentication tokens, remote config, and cached tier/profile data locally in the browser. |
| **unlimitedStorage** | Removes the default quota so Second Opinion history and Port My Profile documents (stored locally via IndexedDB) aren't truncated for active users. |
| **tabs** | Reads the URL/title of the active tab to detect which AI platform is open, and opens new tabs when porting a conversation to a destination platform. |
| **downloads** | Lets users save an exported conversation as a .txt file to their device. |
| **scripting** | Injects a script into the active AI platform tab to extract conversation content, and into the destination tab to paste the ported content. |
| **identity** | Used for Google Sign-In (authentication, profile sync) and the optional, currently-locked Google Drive backup feature. |

### Host Permission Justifications

| Host Permission | Justification |
|---|---|
| **claude.ai** | Content script reads/writes conversations on Claude (source + destination). |
| **chatgpt.com** | Content script reads/writes conversations on ChatGPT (source + destination). |
| **gemini.google.com** | Content script reads/writes conversations on Gemini (source + destination). |
| **`*.oaiusercontent.com`, `images.openai.com`, `*.blob.core.windows.net`, `*.googleusercontent.com`** | Used to reference/fetch image attachments found in ChatGPT/Gemini conversations when porting content that includes images. |
| **app.posthog.com** | Sends anonymous usage analytics (feature clicks, error rates) — no conversation content. |
| **`*.workers.dev`** | Connects to Portility's Cloudflare Worker backend for Second Opinion comparisons, content moderation checks, and remote config. |
| **firestore.googleapis.com** | Reads/writes encrypted user profile data, subscription tier, and preferences via Google Firestore. |
| **www.googleapis.com** | Google OAuth token validation and the optional, currently-locked Google Drive backup feature. |

`<all_urls>`, `copilot.microsoft.com`, and `login.microsoftonline.com` have already been removed
from `manifest.json` (unused) — the table above only lists what's actually still declared.

### Data Use Disclosures

Cross-checked against the live privacy policy at portility.ai/privacy — this is more
accurate than the old guide, which incorrectly claimed "Website content: NO":

**Personally identifiable information**: YES
- Google user ID + auth tokens collected for sign-in (email is not retained per the privacy policy)
- Use: "App functionality" — not sold, not used outside the item's single purpose

**Web history**: YES
- Current tab URL/title read to detect which AI platform is open
- Use: "App functionality"

**User activity**: YES
- Anonymous feature-usage analytics via PostHog (no conversation content, no PII)
- Per-account usage counts, used to enforce tier limits
- Use: "Analytics" and "App functionality"

**Website content**: YES
- Conversation content is transmitted to Portility's backend for Second Opinion
  comparisons and Pro/AI summaries. Not retained after processing; Second Opinion
  results are cached client-side for a short window (per privacy policy: ~5 minutes)
- Saved Port My Profile instructions are encrypted and stored in Google Firestore,
  linked to the user's authenticated account
- Use: "App functionality" — not sold, not shared with unrelated third parties

### Privacy Policy URL
```
https://portility.ai/privacy
```
Confirmed live and matches the disclosures above.

---

## Package tab

Upload `releases/portility-1.0.0.zip` (rebuilt via `bash tools/build.sh`, includes the
`name: "Portility"` fix and the Help icon across all pages).

---

## Distribution

No change needed unless you're switching visibility — carry forward whatever the
extension's current setting is (Unlisted/Public).

---

## Rollout order recommendation

1. Fix `portility.ai/help` (or pull the Help icon from this release) — this is live in
   the code the moment the ZIP is approved.
2. Remove the three unused permissions from `manifest.json`, rebuild the ZIP.
3. Retake screenshots against the current build.
4. Update the four Store Listing / Privacy tab fields above in the Developer Dashboard.
5. Upload the new package and submit for review.
