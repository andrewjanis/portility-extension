/**
 * posthog.js
 * PostHog analytics integration for The Drewery Chrome Extension.
 * Injected as a content script on claude.ai pages.
 * Exposes window.dreweryTrack() for use by content.js.
 */

(function () {
  // PostHog initialization adapted for Chrome extension content script context

  const POSTHOG_API_KEY = 'phc_Am8QxJfBbaSQVfEbANuaPVWWfeEWoKQEqK7QKo38Y9fD';
  const POSTHOG_HOST = 'https://app.posthog.com';

  // Generate or retrieve a persistent anonymous distinct_id
  function getDistinctId() {
    try {
      let id = localStorage.getItem('drewery_distinct_id');
      if (!id) {
        id = 'drewery-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
        localStorage.setItem('drewery_distinct_id', id);
      }
      return id;
    } catch (e) {
      // localStorage unavailable (e.g., service worker context) — use a session-scoped fallback
      if (!self._dreweryDistinctId) {
        self._dreweryDistinctId = 'drewery-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      }
      return self._dreweryDistinctId;
    }
  }

  /**
   * Send a capture event to PostHog.
   * @param {string} eventName
   * @param {Object} properties
   */
  function trackEvent(eventName, properties) {
    if (!POSTHOG_API_KEY || POSTHOG_API_KEY === 'INSERT_POSTHOG_API_KEY_HERE') {
      // Skip tracking if API key is not configured
      return;
    }

    const payload = {
      api_key: POSTHOG_API_KEY,
      event: eventName,
      distinct_id: getDistinctId(),
      properties: Object.assign(
        {
          $lib: 'drewery-extension',
          $lib_version: '1.0.0',
        },
        properties || {}
      ),
      timestamp: new Date().toISOString(),
    };

    // Use fetch (available in both content scripts and MV3 service workers)
    fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(function () {
      // Silently ignore analytics failures — never break the extension over analytics
    });
  }

  // Export for use in content.js
  // Attaches to the window object for content script context
  try {
    window.dreweryTrack = trackEvent;
  } catch (e) {
    // service worker — no window
  }
  try {
    self.dreweryTrack = trackEvent;
  } catch (e) {
    // ignore
  }
})();
