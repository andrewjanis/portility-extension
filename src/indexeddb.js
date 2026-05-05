/**
 * indexeddb.js
 * Portility — IndexedDB storage for Port My Chat Pro project briefs.
 *
 * Database: portility_pro
 * Object Store: project_briefs
 *
 * Schema per record:
 * {
 *   id: string (auto-generated),
 *   createdAt: string (ISO timestamp),
 *   sourcePlatform: string ('claude'|'chatgpt'|'gemini'),
 *   sourceUrl: string,
 *   title: string,
 *   brief: string (markdown),
 *   assets: Array,
 *   rawConversation: string
 * }
 */

'use strict';

var PORTILITY_DB_NAME = 'portility_pro';
var PORTILITY_DB_VERSION = 1;
var PORTILITY_STORE_NAME = 'project_briefs';

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
