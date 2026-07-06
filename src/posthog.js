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
  function getAnonDistinctId() {
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

  // If the user is signed in, identify events by Firebase UID (stable across
  // sessions/devices/domains) instead of this page's anonymous distinct_id.
  // chrome.storage.local is shared extension-wide, so content scripts can see
  // the uid that popup.js writes on sign-in.
  function getDistinctId() {
    var anonId = getAnonDistinctId();
    try {
      return new Promise(function (resolve) {
        chrome.storage.local.get('firebase_uid', function (data) {
          resolve((data && data.firebase_uid) || anonId);
        });
      });
    } catch (e) {
      return Promise.resolve(anonId);
    }
  }

  // Sends a one-time $identify event linking the anonymous distinct_id to the
  // Firebase UID (with email as a person property). Guarded by a stored flag
  // so it only fires once per signed-in user, not on every event.
  function maybeIdentifyUser(anonId) {
    try {
      chrome.storage.local.get(
        ['firebase_uid', 'google_login_hint', 'posthog_identified_uid'],
        function (data) {
          if (!data.firebase_uid || data.posthog_identified_uid === data.firebase_uid) return;
          fetch(POSTHOG_HOST + '/capture/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: POSTHOG_API_KEY,
              event: '$identify',
              distinct_id: data.firebase_uid,
              properties: {
                $set: { email: data.google_login_hint || undefined },
                $anon_distinct_id: anonId,
              },
              timestamp: new Date().toISOString(),
            }),
            keepalive: true,
          }).catch(function () {});
          chrome.storage.local.set({ posthog_identified_uid: data.firebase_uid });
        }
      );
    } catch (e) { /* non-critical */ }
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

    var anonId = getAnonDistinctId();
    maybeIdentifyUser(anonId); // fire-and-forget, no-ops after the first call per user

    getDistinctId().then(function (distinctId) {
      const payload = {
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: distinctId,
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
