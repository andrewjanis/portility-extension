/**
 * oauth-popup-bridge.js
 * Portility — popup-only replacement for oauth.js's ensureAuthenticated().
 *
 * The toolbar popup auto-closes the instant the Google login window (opened
 * by chrome.identity.launchWebAuthFlow) steals focus, killing popup.js's
 * execution before it can store tokens or continue the pending action — the
 * user logs in successfully but the popup never finds out, and the next
 * click relaunches OAuth from scratch since nothing was ever cached.
 *
 * background.js runs the real flow instead (a service worker isn't tied to
 * popup focus/lifecycle), so it persists tokens to chrome.storage.local even
 * if the popup that requested it has already closed. This file just proxies
 * ensureAuthenticated() to that background flow via messaging, keeping the
 * same name/shape so popup.js's call sites don't need to change.
 *
 * Loaded in popup.html ONLY, in place of oauth.js. options.html and
 * portme-manage.html still load the real oauth.js directly — they open as
 * full browser tabs (not a transient action popup), so they aren't affected
 * by this bug.
 */

'use strict';

/**
 * @returns {Promise<{token: string, userId: string, firebaseUid: string, idToken: string}>}
 */
function ensureAuthenticated() {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ type: 'ENSURE_AUTHENTICATED' }, function (response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.error) {
        reject(new Error((response && response.error) || 'Authentication failed'));
        return;
      }
      resolve(response.auth);
    });
  });
}
