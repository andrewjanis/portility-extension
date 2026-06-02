/**
 * remote-config.js
 * Portility — Remote configuration loader.
 *
 * Fetches config from the worker /config endpoint, caches in chrome.storage.local.
 * Content scripts and popup read from cache; background refreshes periodically.
 * Always falls back to hardcoded defaults if cache is empty or fetch fails.
 */

'use strict';

var REMOTE_CONFIG_KEY = 'portility_remote_config';
var REMOTE_CONFIG_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch config from worker and cache it.
 * @param {string} proxyUrl - The worker base URL
 * @returns {Promise<Object|null>}
 */
async function fetchRemoteConfig(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    var resp = await fetch(proxyUrl + '/config', { method: 'GET' });
    if (!resp.ok) return null;
    var config = await resp.json();
    var cached = { config: config, fetchedAt: Date.now() };
    chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: cached });
    return config;
  } catch (e) {
    return null;
  }
}

/**
 * Get cached remote config from storage.
 * @returns {Promise<Object|null>}
 */
function getCachedConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(REMOTE_CONFIG_KEY, function (data) {
      var cached = data[REMOTE_CONFIG_KEY];
      if (cached && cached.config) {
        resolve(cached.config);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Check if cached config is stale (older than TTL).
 * @returns {Promise<boolean>}
 */
function isConfigStale() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(REMOTE_CONFIG_KEY, function (data) {
      var cached = data[REMOTE_CONFIG_KEY];
      if (!cached || !cached.fetchedAt) {
        resolve(true);
        return;
      }
      resolve(Date.now() - cached.fetchedAt > REMOTE_CONFIG_TTL);
    });
  });
}

/**
 * Get platform selectors from cached config, or return null.
 * @param {string} platform - 'claude', 'chatgpt', or 'gemini'
 * @returns {Promise<Object|null>}
 */
function getRemoteSelectors(platform) {
  return getCachedConfig().then(function (config) {
    if (config && config.selectors && config.selectors[platform]) {
      return config.selectors[platform];
    }
    return null;
  });
}

/**
 * Get remote feature flags, or return null.
 * @returns {Promise<Object|null>}
 */
function getRemoteFeatures() {
  return getCachedConfig().then(function (config) {
    if (config && config.features) {
      return config.features;
    }
    return null;
  });
}

/**
 * Get remote URLs config, or return null.
 * @returns {Promise<Object|null>}
 */
function getRemoteUrls() {
  return getCachedConfig().then(function (config) {
    if (config && config.urls) {
      return config.urls;
    }
    return null;
  });
}

// Expose on window for content scripts
if (typeof window !== 'undefined') {
  window.PortilityConfig = {
    fetchRemoteConfig: fetchRemoteConfig,
    getCachedConfig: getCachedConfig,
    isConfigStale: isConfigStale,
    getRemoteSelectors: getRemoteSelectors,
    getRemoteFeatures: getRemoteFeatures,
    getRemoteUrls: getRemoteUrls,
  };
}
