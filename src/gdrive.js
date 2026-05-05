// gdrive.js
// Google Drive OAuth (auth code flow via Cloudflare Worker) and file operations.
// Loaded in the service worker (background.js) via importScripts.

'use strict';

var GDRIVE_OAUTH_CLIENT_ID = '542250387353-k1uu29l3844ct0404i83nboe011btbvc.apps.googleusercontent.com';
var GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
var GDRIVE_FOLDER_NAME = 'PortMyChat-Temp';

// Token exchange handled server-side by Cloudflare Worker
var GDRIVE_TOKEN_ENDPOINT = PROXY_URL + '/gdrive/token';
var GDRIVE_REFRESH_ENDPOINT = PROXY_URL + '/gdrive/refresh';

// ─── OAuth Flow ──────────────────────────────────────────────────────────────

/**
 * Launch Google Drive OAuth flow (auth code grant).
 * Returns access_token and refresh_token via worker exchange.
 */
async function launchDriveAuthFlow() {
  var redirectUrl = chrome.identity.getRedirectURL();

  var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(GDRIVE_OAUTH_CLIENT_ID) +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUrl) +
    '&scope=' + encodeURIComponent(GDRIVE_SCOPE) +
    '&access_type=offline' +
    '&prompt=consent';

  return new Promise(function (resolve, reject) {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      function (responseUrl) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!responseUrl) {
          reject(new Error('No response from Drive auth flow'));
          return;
        }

        // Extract the authorization code from the redirect URL
        var codeMatch = responseUrl.match(/[?&]code=([^&]*)/);
        if (!codeMatch) {
          reject(new Error('No authorization code in response'));
          return;
        }

        resolve(codeMatch[1]);
      }
    );
  });
}

/**
 * Exchange auth code for tokens via Cloudflare Worker.
 */
async function exchangeDriveCode(code) {
  var redirectUrl = chrome.identity.getRedirectURL();

  var response = await fetch(GDRIVE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, redirect_uri: redirectUrl, client_id: GDRIVE_OAUTH_CLIENT_ID })
  });

  if (!response.ok) {
    var errBody = await response.text().catch(function () { return 'Unknown error'; });
    throw new Error('Token exchange failed: ' + errBody);
  }

  return response.json(); // { access_token, refresh_token, expires_in }
}

/**
 * Full Drive auth flow: launch OAuth, exchange code, cache tokens.
 */
async function startDriveAuth() {
  var code = await launchDriveAuthFlow();
  var tokens = await exchangeDriveCode(code);

  await chrome.storage.local.set({
    gdrive_access_token: tokens.access_token,
    gdrive_refresh_token: tokens.refresh_token,
    gdrive_token_expiry: Date.now() + (tokens.expires_in * 1000)
  });

  return { success: true };
}

/**
 * Check if user has a stored Drive refresh token.
 */
async function isDriveAuthenticated() {
  var stored = await chrome.storage.local.get(['gdrive_refresh_token']);
  return !!stored.gdrive_refresh_token;
}

/**
 * Get a valid Drive access token. Refreshes via worker if expired.
 */
async function getDriveAccessToken() {
  var stored = await chrome.storage.local.get([
    'gdrive_access_token',
    'gdrive_refresh_token',
    'gdrive_token_expiry'
  ]);

  if (!stored.gdrive_refresh_token) {
    throw new Error('Not authenticated with Google Drive');
  }

  // Check if token is still valid (with 5 min buffer)
  var isExpired = !stored.gdrive_token_expiry || Date.now() >= (stored.gdrive_token_expiry - 300000);

  if (!isExpired && stored.gdrive_access_token) {
    return stored.gdrive_access_token;
  }

  // Refresh via worker
  var response = await fetch(GDRIVE_REFRESH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: stored.gdrive_refresh_token, client_id: GDRIVE_OAUTH_CLIENT_ID })
  });

  if (!response.ok) {
    throw new Error('Token refresh failed. Please reconnect Google Drive.');
  }

  var data = await response.json();

  await chrome.storage.local.set({
    gdrive_access_token: data.access_token,
    gdrive_token_expiry: Date.now() + (data.expires_in * 1000)
  });

  return data.access_token;
}

/**
 * Disconnect Google Drive — clear stored tokens.
 */
async function disconnectDrive() {
  await chrome.storage.local.remove([
    'gdrive_access_token',
    'gdrive_refresh_token',
    'gdrive_token_expiry',
    'gdrive_folder_id'
  ]);
}

// ─── Drive File Operations ───────────────────────────────────────────────────

/**
 * Get or create the PortMyChat-Temp folder in Drive.
 */
async function getOrCreateDriveFolder() {
  var stored = await chrome.storage.local.get(['gdrive_folder_id']);
  if (stored.gdrive_folder_id) return stored.gdrive_folder_id;

  var token = await getDriveAccessToken();

  // Search for existing folder
  var searchUrl = 'https://www.googleapis.com/drive/v3/files' +
    '?q=name%3D%27' + encodeURIComponent(GDRIVE_FOLDER_NAME) +
    '%27%20and%20mimeType%3D%27application%2Fvnd.google-apps.folder%27%20and%20trashed%3Dfalse';

  var searchResp = await fetch(searchUrl, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  var searchData = await searchResp.json();

  if (searchData.files && searchData.files.length > 0) {
    var folderId = searchData.files[0].id;
    await chrome.storage.local.set({ gdrive_folder_id: folderId });
    return folderId;
  }

  // Create folder
  var createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: GDRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });

  var folder = await createResp.json();
  await chrome.storage.local.set({ gdrive_folder_id: folder.id });
  return folder.id;
}

/**
 * Upload a file to the PortMyChat-Temp folder.
 * @param {string} filename
 * @param {Blob} fileBlob
 * @returns {Promise<{driveId: string, driveLink: string}>}
 */
async function uploadFileToDrive(filename, fileBlob) {
  var token = await getDriveAccessToken();
  var folderId = await getOrCreateDriveFolder();

  var metadata = {
    name: filename,
    parents: [folderId]
  };

  var form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileBlob);

  var response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: form
    }
  );

  var data = await response.json();
  if (!data.id) throw new Error('Drive upload failed for ' + filename);

  // Make file shareable (anyone with link can view)
  await fetch('https://www.googleapis.com/drive/v3/files/' + data.id + '/permissions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });

  return {
    driveId: data.id,
    driveLink: data.webViewLink
  };
}

/**
 * Delete a file from Google Drive by file ID.
 */
async function deleteDriveFile(driveId) {
  if (!driveId) return;
  try {
    var token = await getDriveAccessToken();
    await fetch('https://www.googleapis.com/drive/v3/files/' + driveId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
  } catch (err) {
    console.warn('[Portility] Drive delete failed for ' + driveId + ':', err.message);
  }
}
