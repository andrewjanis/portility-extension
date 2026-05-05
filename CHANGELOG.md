# Changelog

## [1.1.0] — In Development
### Added
- ChatGPT conversation extraction: capture conversations from chatgpt.com
- Gemini conversation extraction: capture conversations from gemini.google.com
- Shared content-script utilities (content-shared.js) to avoid duplication across platforms
- Operating instructions checkbox on destination picker (checked by default) replaces the separate confirm dialog
- Auto-paste and auto-submit: ported text is automatically inserted and sent on Claude and Gemini destination tabs
### Changed
- Popup status message updated to reference Claude, ChatGPT, and Gemini
- Icon tooltip text made platform-agnostic
- Removed passphrase requirement: encryption now uses Google identity seamlessly

## [1.0.0] — 2026-04-17
### Initial Release
- Copy Conversation: extract full conversation text from Claude.ai
- Summarize: AI-generated summary via Claude API (Anthropic)
- Destination picker: open in Claude, ChatGPT, Gemini, or save as .txt
- Content moderation via OpenAI Moderation API (proxied through Cloudflare Worker)
- Anonymous usage analytics via PostHog
- Green checkmark icon on successful copy
- Gray/active icon states based on conversation detection
