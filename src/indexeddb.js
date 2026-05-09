/**
 * indexeddb.js
 * Portility — IndexedDB storage for Port My Chat Pro project briefs
 * and Second Opinion comparison history.
 *
 * Database: portility_pro (version 2)
 *
 * Object Stores:
 *   - project_briefs  (v1)
 *   - so_comparisons  (v2) — capped at 20, auto-pruned
 */

'use strict';

var PORTILITY_DB_NAME = 'portility_pro';
var PORTILITY_DB_VERSION = 2;
var PORTILITY_STORE_NAME = 'project_briefs';
var SO_STORE_NAME = 'so_comparisons';
var MAX_SO_COMPARISONS = 20;

function openPortilityDB() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(PORTILITY_DB_NAME, PORTILITY_DB_VERSION);

    request.onupgradeneeded = function (event) {
      var db = event.target.result;
      if (!db.objectStoreNames.contains(PORTILITY_STORE_NAME)) {
        var store = db.createObjectStore(PORTILITY_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('sourcePlatform', 'sourcePlatform', { unique: false });
      }
      if (!db.objectStoreNames.contains(SO_STORE_NAME)) {
        var soStore = db.createObjectStore(SO_STORE_NAME, { keyPath: 'id' });
        soStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onblocked = function () {
      console.log('[IndexedDB] Upgrade blocked — close other Portility tabs');
    };

    request.onsuccess = function (event) {
      resolve(event.target.result);
    };

    request.onerror = function (event) {
      reject(new Error('Failed to open IndexedDB: ' + event.target.error));
    };
  });
}

function generateBriefId() {
  return 'brief_' + Date.now().toString(36) + '_' +
    Math.random().toString(36).substring(2, 8);
}

async function saveProjectBrief(briefData) {
  var db = await openPortilityDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(PORTILITY_STORE_NAME, 'readwrite');
    var store = tx.objectStore(PORTILITY_STORE_NAME);

    briefData.id = briefData.id || generateBriefId();
    briefData.createdAt = briefData.createdAt || new Date().toISOString();

    var request = store.put(briefData);
    request.onsuccess = function () { resolve(briefData.id); };
    request.onerror = function (event) {
      reject(new Error('Failed to save brief: ' + event.target.error));
    };
  });
}

async function getProjectBrief(id) {
  var db = await openPortilityDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(PORTILITY_STORE_NAME, 'readonly');
    var store = tx.objectStore(PORTILITY_STORE_NAME);
    var request = store.get(id);
    request.onsuccess = function (event) { resolve(event.target.result || null); };
    request.onerror = function (event) {
      reject(new Error('Failed to get brief: ' + event.target.error));
    };
  });
}

async function listProjectBriefs() {
  var db = await openPortilityDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(PORTILITY_STORE_NAME, 'readonly');
    var store = tx.objectStore(PORTILITY_STORE_NAME);
    var request = store.index('createdAt').openCursor(null, 'prev');
    var results = [];
    request.onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = function (event) {
      reject(new Error('Failed to list briefs: ' + event.target.error));
    };
  });
}

// ─── Second Opinion Comparisons ─────────────────────────────────────────────

function generateSOComparisonId() {
  return 'so_' + Date.now().toString(36) + '_' +
    Math.random().toString(36).substring(2, 8);
}

async function saveSOComparison(data) {
  var db = await openPortilityDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(SO_STORE_NAME, 'readwrite');
    var store = tx.objectStore(SO_STORE_NAME);

    data.id = data.id || generateSOComparisonId();
    data.createdAt = data.createdAt || new Date().toISOString();

    var request = store.put(data);
    request.onsuccess = function () {
      pruneSOComparisons(db).then(function () {
        resolve(data.id);
      });
    };
    request.onerror = function (event) {
      reject(new Error('Failed to save SO comparison: ' + event.target.error));
    };
  });
}

async function listSOComparisons() {
  var db = await openPortilityDB();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(SO_STORE_NAME, 'readonly');
    var store = tx.objectStore(SO_STORE_NAME);
    var request = store.index('createdAt').openCursor(null, 'prev');
    var results = [];
    request.onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = function (event) {
      reject(new Error('Failed to list SO comparisons: ' + event.target.error));
    };
  });
}

function pruneSOComparisons(db) {
  return new Promise(function (resolve) {
    var tx = db.transaction(SO_STORE_NAME, 'readwrite');
    var store = tx.objectStore(SO_STORE_NAME);
    var index = store.index('createdAt');
    var request = index.openCursor(null, 'prev');
    var count = 0;

    request.onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        count++;
        if (count > MAX_SO_COMPARISONS) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = function () { resolve(); };
  });
}
