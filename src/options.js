// options.js — Portility Settings page logic

'use strict';

var DOCS_URL = 'https://portility.ai/docs';

// ─── Toast notification ──────────────────────────────────────────────────────

function showToast(message, duration) {
  duration = duration || 2500;
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(function () { toast.style.display = 'none'; }, duration);
}

// ─── Google Drive status ─────────────────────────────────────────────────────

async function updateDriveStatus() {
  var dot = document.getElementById('driveStatusDot');
  var text = document.getElementById('driveStatusText');
  var btn = document.getElementById('driveAuthBtn');

  var stored = await chrome.storage.local.get(['gdrive_refresh_token']);
  var isConnected = !!stored.gdrive_refresh_token;

  if (isConnected) {
    dot.className = 'status-dot status-connected';
    text.textContent = 'Connected';
    btn.textContent = 'Disconnect';
    btn.className = 'btn-danger';
    btn.onclick = disconnectDrive;
  } else {
    dot.className = 'status-dot status-disconnected';
    text.textContent = 'Not Connected';
    btn.textContent = 'Connect';
    btn.className = 'btn-primary';
    btn.onclick = connectDrive;
  }
}

function connectDrive() {
  chrome.runtime.sendMessage({ type: 'START_GDRIVE_AUTH' }, function (response) {
    if (response && response.success) {
      showToast('Google Drive connected.');
      updateDriveStatus();
    } else {
      showToast('Connection failed: ' + ((response && response.error) || 'Unknown error'));
    }
  });
}

function disconnectDrive() {
  chrome.storage.local.remove([
    'gdrive_access_token',
    'gdrive_refresh_token',
    'gdrive_token_expiry',
    'gdrive_folder_id'
  ], function () {
    showToast('Google Drive disconnected.');
    updateDriveStatus();
  });
}

// ─── Selector refresh ────────────────────────────────────────────────────────

async function updateSelectorCacheInfo() {
  var stored = await chrome.storage.local.get(['portility_selectors_fetched_at']);
  var info = document.getElementById('selectorCacheInfo');
  if (stored.portility_selectors_fetched_at) {
    var date = new Date(stored.portility_selectors_fetched_at);
    info.textContent = 'Last updated: ' + date.toLocaleString();
  } else {
    info.textContent = 'Not yet fetched.';
  }
}

document.getElementById('refreshSelectorsBtn').addEventListener('click', function () {
  var btn = document.getElementById('refreshSelectorsBtn');
  btn.textContent = 'Refreshing...';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'FORCE_REFRESH_SELECTORS' }, function (response) {
    btn.textContent = 'Refresh';
    btn.disabled = false;
    if (response && response.success) {
      showToast('Selectors updated.');
      updateSelectorCacheInfo();
    } else {
      showToast('Update failed: ' + ((response && response.error) || 'Unknown error'));
    }
  });
});

// ─── Docs link ───────────────────────────────────────────────────────────────

document.getElementById('docsLink').addEventListener('click', function () {
  chrome.tabs.create({ url: DOCS_URL });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

document.getElementById('logoutBtn').addEventListener('click', function () {
  chrome.storage.local.remove([
    'firebase_id_token',
    'firebase_uid',
    'firebase_token_expiry',
    'google_access_token',
    'google_user_id',
    'gdrive_access_token',
    'gdrive_refresh_token',
    'gdrive_token_expiry',
    'gdrive_folder_id'
  ], function () {
    showToast('Logged out.');
    setTimeout(function () { window.close(); }, 1500);
  });
});

// ─── Init ────────────────────────────────────────────────────────────────────

updateDriveStatus();
updateSelectorCacheInfo();
