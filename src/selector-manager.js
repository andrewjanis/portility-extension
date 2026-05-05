// selector-manager.js
// Fetches and caches DOM selectors from GitHub.
// Runs in the service worker (background.js) context.
// Content scripts read cached selectors from chrome.storage.local.

var SELECTORS_URL = 'https://raw.githubusercontent.com/andrewjanis/portility-extension/main/selectors.json';
var SELECTORS_CACHE_KEY = 'portility_selectors';
var SELECTORS_CACHE_TS_KEY = 'portility_selectors_fetched_at';
var SELECTORS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

var DEFAULT_SELECTORS = {
  claude: {
    human: [
      '[data-testid="user-message"]',
      '[data-testid="human-turn"]',
      '[class*="human-turn"]',
      '[class*="HumanTurn"]'
    ],
    ai_class_fragment: 'font-claude-response',
    input: 'div.ProseMirror[contenteditable="true"]',
    send_button: [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'fieldset button[type="button"]:last-child',
      'button[data-testid="send-button"]'
    ],
    uploadInput: "input[type='file']",
    artifactContainer: "[data-testid='artifact'], .artifact-panel",
    artifactTitle: "[data-testid='artifact-title'], .artifact-name",
    artifactContent: "[data-testid='artifact-content'], .artifact-body",
    fileChip: "[data-testid*='file'], [class*='attachment'], [class*='file-chip']"
  },
  chatgpt: {
    human: '[data-message-author-role="user"]',
    ai: '[data-message-author-role="assistant"]',
    input: '#prompt-textarea',
    send_button: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]'
    ],
    uploadInput: "input[type='file']",
    artifactContainer: "[class*='artifact'], .preview-panel",
    artifactTitle: "[class*='artifact-title'], .preview-title",
    artifactContent: "[class*='artifact-content'], .preview-content",
    fileChip: "[data-testid*='file'], [class*='attachment'], [class*='file-chip']"
  },
  gemini: {
    human: ['.user-query-text', '[data-turn-role="user"]', '.query-text', 'user-query'],
    ai: ['.model-response-text', '[data-turn-role="model"]', '.response-text', 'model-response'],
    input: '.ql-editor[contenteditable="true"]',
    send_button: [
      'button.send-button',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      '.input-area button[mat-icon-button]'
    ],
    uploadInput: "input[type='file']",
    artifactContainer: ".artifact, [data-artifact]",
    artifactTitle: ".artifact-title, [data-artifact-name]",
    artifactContent: ".artifact-content, [data-artifact-body]",
    fileChip: "[data-testid*='file'], [class*='attachment'], [class*='file-chip']"
  }
};

/**
 * Fetch selectors from GitHub and cache in chrome.storage.local.
 */
async function fetchAndCacheSelectors() {
  var response = await fetch(SELECTORS_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Selector fetch failed: ' + response.status);
  }
  var data = await response.json();
  await chrome.storage.local.set({
    [SELECTORS_CACHE_KEY]: data,
    [SELECTORS_CACHE_TS_KEY]: Date.now()
  });
  console.log('[Portility] Selectors cached from GitHub');
  return data;
}

/**
 * Check if cached selectors are stale.
 */
async function shouldRefreshSelectors() {
  var stored = await chrome.storage.local.get([SELECTORS_CACHE_TS_KEY]);
  var cachedAt = stored[SELECTORS_CACHE_TS_KEY] || 0;
  return (Date.now() - cachedAt) > SELECTORS_CACHE_TTL_MS;
}

/**
 * Initialize selector manager — refresh if stale or missing.
 * Called on service worker startup.
 */
async function initSelectorManager() {
  try {
    var stale = await shouldRefreshSelectors();
    if (stale) {
      await fetchAndCacheSelectors();
    }
  } catch (err) {
    console.warn('[Portility] Selector init fetch failed, using defaults:', err.message);
    // Ensure defaults are in storage so content scripts have something
    var stored = await chrome.storage.local.get([SELECTORS_CACHE_KEY]);
    if (!stored[SELECTORS_CACHE_KEY]) {
      await chrome.storage.local.set({ [SELECTORS_CACHE_KEY]: DEFAULT_SELECTORS });
    }
  }
}
