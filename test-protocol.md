# Portility Extension — Full User Flow Test Protocol

## Prerequisites
- Fresh Chrome profile (no prior Portility data) OR clear extension storage via devtools
- Extension loaded (unpacked or from store)
- Google account ready for sign-in
- Open tabs on each platform: [Claude](https://claude.ai), [ChatGPT](https://chatgpt.com), [Gemini](https://gemini.google.com)
- Each tab should have an existing conversation with a mix of text, images, and uploaded files

### Test Conversation Setup
Before starting, create conversations on each platform that include:
- At least 5 back-and-forth messages
- 1–2 uploaded images (PNG or JPG)
- 1 uploaded file (e.g. a .csv, .json, or .docx)
- 1 code block or artifact in the AI response

---

## Phase 1: First Launch & Free Tools

### T1.1 — First open (no auth)
1. Click the Portility extension icon
2. **Verify**: Popup shows "Port My Chat", "Port Me", and "Try Pro Features Free" buttons
3. **Verify**: No paid buttons visible (Port My Chat Pro, Port My Profile, Second Opinion)
4. **Verify**: Sign-in button visible in footer

### T1.2 — Port My Chat (free) → Claude
1. Navigate to a Claude conversation with text + images
2. Open popup, click **Port My Chat**
3. Sign in when prompted (Google OAuth)
4. **Verify**: Destination picker appears (Claude, Gemini, ChatGPT, Save)
5. Select **Gemini** as destination
6. **Verify**: Status shows "Extracting conversation…" → "Checking content…" → "Opening destination…"
7. **Verify**: New Gemini tab opens, conversation text auto-pastes
8. **Verify**: Only text is ported (no images or files — free tier)

### T1.3 — Port My Chat (free) → Save as file
1. Navigate to a ChatGPT conversation
2. Open popup, click **Port My Chat**
3. Select **Save** as destination
4. **Verify**: .txt file downloads with conversation content
5. **Verify**: Filename derived from chat title

### T1.4 — Port My Chat (free) → ChatGPT from Gemini
1. Navigate to a Gemini conversation
2. Open popup, click **Port My Chat**
3. Select **ChatGPT** as destination
4. **Verify**: New ChatGPT tab opens, text auto-pastes

### T1.5 — Port Me (free) — Onboarding questionnaire
1. Open popup, click **Port Me**
2. Sign in if not already
3. **Verify**: Questionnaire page 1 appears with:
   - "Things I like about my AI" (multi-select)
   - "Things I don't like about my AI" (multi-select)
   - Conversation style chips (Casual / Formal / Robotic)
   - Sycophancy slider (1–5)
4. Fill in selections, click **Next**
5. **Verify**: Page 2 appears with free-text "Anything else?" field
6. Fill in text, select **Claude** as destination
7. Click **Port Me**
8. **Verify**: Instructions generated, copied to clipboard, Claude tab opens with auto-paste

### T1.6 — Port Me (free) → Save as file
1. Repeat T1.5 but select **Save** as destination
2. **Verify**: .txt file downloads with generated operating instructions

### T1.7 — Edit Instructions
1. Open popup, click **Port Me** again
2. **Verify**: Questionnaire pre-fills with previous answers
3. Change one answer, port to **Gemini**
4. **Verify**: Updated instructions paste into Gemini

---

## Phase 2: Trial Activation & Pro Features

### T2.1 — Try Pro Features Free (CTA)
1. Open popup
2. **Verify**: "Try Pro Features Free" button visible
3. Click **Try Pro Features Free**
4. **Verify**: Free buttons hide, paid buttons appear (Port My Chat Pro, Port My Profile, Second Opinion)
5. Close and reopen popup
6. **Verify**: Paid buttons still visible (trialStatus cached)

### T2.2 — Port My Chat Pro (trial) — Full text + images from Claude
1. Navigate to a Claude conversation with images and a code artifact
2. Open popup, click **Port My Chat Pro**
3. **Verify**: Destination picker appears with profile checkbox and text mode options
4. Select **Full Text** mode (if toggle visible in settings)
5. Select **ChatGPT** as destination
6. **Verify**: Extraction runs → image selection screen appears
7. Select 1–2 images to include
8. **Verify**: Status shows "Opening destination…"
9. **Verify**: ChatGPT tab opens, conversation text auto-pastes, images upload
10. **Verify**: Trial welcome banner: "Welcome! Your 7-day free trial has started (50 uses)."

### T2.3 — Port My Chat Pro (trial) — Summary mode + files from Gemini
1. Navigate to a Gemini conversation with uploaded files (CSV, DOCX, etc.)
2. Ensure text mode is set to **Summary** in extension settings (options page)
3. Open popup, click **Port My Chat Pro**
4. Select **Claude** as destination
5. **Verify**: Extraction runs → "Summarizing…" status → file selection screen
6. Select files to include
7. **Verify**: AI-generated project brief (Markdown format) with asset manifest
8. **Verify**: Claude tab opens, brief auto-pastes, files upload

### T2.4 — Port My Chat Pro (trial) — Save as Markdown
1. Navigate to a ChatGPT conversation with images
2. Open popup, click **Port My Chat Pro**
3. Select **Save** as destination
4. **Verify**: .md file downloads with:
   - Project brief title
   - Metadata (date, source platform)
   - Brief body or full text
   - Embedded images (base64) if selected
   - Asset manifest table

### T2.5 — Port My Chat Pro (trial) — With profile included
1. First complete T2.7 (create a profile) if not done
2. Navigate to any conversation
3. Open popup, click **Port My Chat Pro**
4. **Verify**: "Include profile" checkbox is present with profile dropdown
5. Check the box, select a profile
6. Port to **Gemini**
7. **Verify**: Ported content includes profile instructions prepended before conversation

### T2.6 — Port My Chat Pro (trial) — Cross-platform image port
1. Navigate to a Claude conversation with AI-generated images
2. Open popup, click **Port My Chat Pro**
3. Select **Gemini** as destination, include images
4. **Verify**: Images transfer to Gemini via auto-paste
5. Repeat: Gemini → ChatGPT with uploaded images
6. Repeat: ChatGPT → Claude with images

### T2.7 — Port My Profile (trial) — Create profile
1. Open popup, click **Port My Profile**
2. **Verify**: Profile type selection appears (Work, Home, Hobby, Other)
3. Select **Work**
4. Complete 2-page questionnaire
5. Set profile name, icon, colour
6. **Verify**: Profile saves → destination picker appears
7. Port to **Claude**
8. **Verify**: Profile instructions paste into Claude

### T2.8 — Port My Profile (trial) — Multiple profiles
1. Click **Port My Profile** again
2. Create a second profile (e.g. **Hobby**)
3. **Verify**: Profile picker appears showing both profiles
4. Select the new profile, port to **ChatGPT**
5. **Verify**: Correct profile's instructions paste

### T2.9 — Port My Profile (trial) — Save as file
1. Click **Port My Profile**
2. Select a profile from the picker
3. Select **Save** as destination
4. **Verify**: .txt file downloads with profile instructions

### T2.10 — Second Opinion (trial) — From Claude
1. Navigate to a Claude conversation (ideally with a factual or analytical topic)
2. Open popup, click **Second Opinion**
3. **Verify**: Step tracker appears with 3 steps:
   - Step 1: "Detecting platform…" → "Extracting from Claude…" → "Claude conversation read"
   - Step 2: "Summarizing & getting 2nd opinion…" → "Responses received"
   - Step 3: "Scoring agreement…" → "Analysis complete"
4. **Verify**: Results screen shows:
   - SVG gauge dial with agreement score (0–100%)
   - Colour zone (red/yellow/green)
   - "Where they agree" section (expandable)
   - "Where they differ" section (expandable)
   - Likert scale (1–5) for feedback
5. Submit feedback rating
6. **Verify**: Results display correctly, "View Full Comparison" link works

### T2.11 — Second Opinion (trial) — From ChatGPT
1. Navigate to a ChatGPT conversation
2. Run Second Opinion
3. **Verify**: Same flow as T2.10, platform detected as ChatGPT

### T2.12 — Second Opinion (trial) — From Gemini
1. Navigate to a Gemini conversation
2. Run Second Opinion
3. **Verify**: Same flow as T2.10, platform detected as Gemini

### T2.13 — Second Opinion (trial) — Cached result
1. Immediately reopen popup on the same tab as T2.10/11/12
2. **Verify**: Previous Second Opinion result loads from cache (no re-processing)
3. Navigate to a different conversation tab, reopen popup
4. **Verify**: Cache invalidated, home screen shown

---

## Phase 3: Trial Limits & Expiry

### T3.1 — Usage counter increments
1. Open the options page (right-click extension → Options)
2. **Verify**: Usage section shows trial info: "X d / Y uses left"
3. Use a pro feature, then reopen options
4. **Verify**: Uses remaining decremented by 1

### T3.2 — Trial expiry (simulated — use devtools)
To simulate expiry without waiting 7 days:
1. Open devtools on the options page
2. Run: `document.getElementById('devTierSection').style.display = ''`
3. In Firestore (or via the Firebase console), set the test user's:
   - `paid_use_count` to `50` (to trigger use-limit expiry), OR
   - `trial_start_at` to 8 days ago (to trigger time expiry)
4. Open popup, click any pro feature (e.g. **Second Opinion**)
5. **Verify**: Modal appears: "Your free trial has ended. Subscribe to keep using paid tools."
6. **Verify**: Modal shows three buttons:
   - **Upgrade** — links to pricing page
   - **Continue with Free** — reverts to free buttons
   - **Close** — dismisses modal

### T3.3 — Continue with Free (post-trial)
1. From the trial-expired modal (T3.2), click **Continue with Free**
2. **Verify**: Modal dismisses
3. **Verify**: Free buttons visible (Port My Chat, Port Me)
4. **Verify**: "Upgrade to Pro" button (links to pricing, not "Try Pro Features Free")
5. Click **Port My Chat**, port a conversation
6. **Verify**: Free tool works normally, no usage gating

### T3.4 — Upgrade button (post-trial)
1. After T3.3, click **Upgrade to Pro**
2. **Verify**: Opens pricing page (https://www.portility.ai/pricing)

### T3.5 — Popup reopen after trial expiry
1. Close and reopen popup
2. **Verify**: Free buttons shown with "Upgrade to Pro" (not "Try Pro Features Free")
3. Free tools continue to work

---

## Phase 4: Subscriber Flow

### T4.1 — Activate subscription (simulated)
1. In Firestore, set the test user's `tier` to `paid` and `reset_date` to 30 days from now
2. Reopen popup
3. **Verify**: Paid buttons shown immediately (no "Try Pro" CTA)
4. Use all pro features — no trial banner, no trial limits

### T4.2 — Subscriber monthly limit
1. Set `usage_count` close to 50 (e.g. 45) in Firestore
2. Use a pro feature
3. **Verify**: Warning banner at 80%: "You've used X of 50 uses this month."
4. Set `usage_count` to 50
5. Try a pro feature
6. **Verify**: Blocked modal: "You've used all 50 uses this month." with Upgrade link

### T4.3 — Subscription cancellation (simulated)
1. In Firestore, set user back to: `tier: 'free'`, `reset_date: null`, `usage_count: 0`
2. Leave `trial_started: true`, `paid_use_count` at whatever it was
3. Reopen popup
4. **Verify**: Free buttons shown with "Upgrade to Pro" (trial was already used — no new trial)
5. Try clicking a pro feature via devtools
6. **Verify**: `/authorize` returns `trial_expired` (trial already consumed)

---

## Phase 5: Edge Cases & Guards

### T5.1 — paid3 devTierOverride blocked
1. Open options page, unhide dev tier section via devtools
2. Select the **Unlimited** (paid3) radio button
3. **Verify**: Error message: "paid3 cannot be set via dev override"
4. **Verify**: Selection reverts to previous tier

### T5.2 — Free tools while signed out
1. Clear auth tokens from extension storage
2. Open popup, click **Port My Chat**
3. **Verify**: Prompts for sign-in (free tools still require auth)

### T5.3 — Network failure on recordUse
1. Use devtools Network tab to block requests to `/record-use`
2. Use a pro feature
3. **Verify**: Feature completes successfully (recordUse is fire-and-forget)
4. **Verify**: Console shows warning but user is not impacted

### T5.4 — Network failure on authorize
1. Block requests to `/authorize`
2. Try a pro feature
3. **Verify**: Error shown to user, feature does not proceed

### T5.5 — Moderation check
1. Attempt to port a conversation that might trigger moderation
2. **Verify**: Moderation modal appears, port is blocked

### T5.6 — Empty conversation
1. Navigate to a new/empty chat tab
2. Try Port My Chat
3. **Verify**: Appropriate error message (e.g. "No conversation text found")

### T5.7 — Non-supported page
1. Navigate to a non-AI page (e.g. google.com)
2. Try Port My Chat
3. **Verify**: Error: "Could not reach the page — try refreshing."

---

## Results Tracker

| Test | Status | Notes |
|------|--------|-------|
| T1.1 | | |
| T1.2 | | |
| T1.3 | | |
| T1.4 | | |
| T1.5 | | |
| T1.6 | | |
| T1.7 | | |
| T2.1 | | |
| T2.2 | | |
| T2.3 | | |
| T2.4 | | |
| T2.5 | | |
| T2.6 | | |
| T2.7 | | |
| T2.8 | | |
| T2.9 | | |
| T2.10 | | |
| T2.11 | | |
| T2.12 | | |
| T2.13 | | |
| T3.1 | | |
| T3.2 | | |
| T3.3 | | |
| T3.4 | | |
| T3.5 | | |
| T4.1 | | |
| T4.2 | | |
| T4.3 | | |
| T5.1 | | |
| T5.2 | | |
| T5.3 | | |
| T5.4 | | |
| T5.5 | | |
| T5.6 | | |
| T5.7 | | |
