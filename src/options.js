'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var driveBackupToggle = document.getElementById('driveBackupToggle');
  var driveStatus = document.getElementById('driveStatus');
  var driveDisconnectBtn = document.getElementById('driveDisconnectBtn');
  var compressToggle = document.getElementById('compressToggle');
  var editInstructionsBtn = document.getElementById('editInstructionsBtn');
  var editInstructionsNote = document.getElementById('editInstructionsNote');
  var signOutBtn = document.getElementById('signOutBtn');
  var signInBtn = document.getElementById('signInBtn');
  var accountSignedIn = document.getElementById('accountSignedIn');
  var accountSignedOut = document.getElementById('accountSignedOut');
  var accountEmail = document.getElementById('accountEmail');

  // ─── Tier gating ─────────────────────────────────────────────────────────
  var backupSection = document.getElementById('backupSection');
  var imageQualitySection = document.getElementById('imageQualitySection');

  chrome.storage.local.get('userTier', function (result) {
    var tier = (result.userTier && result.userTier.tier) || 'free';
    if (tier !== 'paid') {
      [backupSection, imageQualitySection].forEach(function (section) {
        section.classList.add('locked');
        var label = document.createElement('span');
        label.className = 'paid-label';
        label.textContent = 'Paid feature';
        section.querySelector('.section-title').appendChild(label);
      });
    }
  });

  // ─── Load saved settings ──────────────────────────────────────────────────
  chrome.storage.local.get(
    ['portility_drive_backup_enabled', 'portility_compress_images'],
    function (result) {
      driveBackupToggle.checked = result.portility_drive_backup_enabled === true;
      compressToggle.checked = result.portility_compress_images !== false;

      if (driveBackupToggle.checked) {
        checkDriveStatus();
      }
    }
  );

  // Check account status on load
  checkAccountStatus();

  // ─── Drive backup toggle ─────────────────────────────────────────────────
  driveBackupToggle.addEventListener('change', function () {
    if (driveBackupToggle.checked) {
      chrome.storage.local.set({ portility_drive_backup_enabled: true });

      chrome.identity.getAuthToken({ interactive: false }, function (token) {
        if (chrome.runtime.lastError) {
          console.log('[Options] Non-interactive auth failed:', chrome.runtime.lastError.message);
        }
        if (token) {
          console.log('[Options] Already authenticated');
          showDriveConnected();
          return;
        }
        console.log('[Options] Starting interactive auth...');
        chrome.identity.getAuthToken({ interactive: true }, function (token2) {
          if (chrome.runtime.lastError) {
            console.log('[Options] Interactive auth failed:', chrome.runtime.lastError.message);
            driveBackupToggle.checked = false;
            chrome.storage.local.set({ portility_drive_backup_enabled: false });
            hideDriveStatus();
            return;
          }
          if (token2) {
            console.log('[Options] Auth successful');
            showDriveConnected();
            checkAccountStatus();
          } else {
            driveBackupToggle.checked = false;
            chrome.storage.local.set({ portility_drive_backup_enabled: false });
            hideDriveStatus();
          }
        });
      });
    } else {
      chrome.storage.local.set({ portility_drive_backup_enabled: false });
      hideDriveStatus();
    }
  });

  // ─── Drive disconnect ─────────────────────────────────────────────────────
  driveDisconnectBtn.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'DISCONNECT_GDRIVE' }, function () {
      driveBackupToggle.checked = false;
      chrome.storage.local.set({ portility_drive_backup_enabled: false });
      hideDriveStatus();
    });
  });

  // ─── Image compression toggle ─────────────────────────────────────────────
  compressToggle.addEventListener('change', function () {
    chrome.storage.local.set({ portility_compress_images: compressToggle.checked });
  });

  // ─── Edit Instructions ───────────────────────────────────────────────────
  editInstructionsBtn.addEventListener('click', function () {
    chrome.storage.local.set({ edit_instructions_pending: true }, function () {
      editInstructionsNote.style.display = 'block';
    });
  });

  // ─── Sign in ──────────────────────────────────────────────────────────────
  signInBtn.addEventListener('click', function () {
    chrome.identity.getAuthToken({ interactive: true }, function (token) {
      if (chrome.runtime.lastError) {
        console.log('[Options] Sign in failed:', chrome.runtime.lastError.message);
        return;
      }
      if (token) {
        checkAccountStatus();
      }
    });
  });

  // ─── Sign out ─────────────────────────────────────────────────────────────
  signOutBtn.addEventListener('click', function () {
    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (token) {
        // Revoke the token with Google so next sign-in requires re-consent
        fetch('https://accounts.google.com/o/oauth2/revoke?token=' + token)
          .then(function () { console.log('[Options] Token revoked with Google'); })
          .catch(function () { console.log('[Options] Token revoke failed (may already be invalid)'); });
        chrome.identity.removeCachedAuthToken({ token: token }, function () {
          console.log('[Options] Token removed from cache');
        });
      }
      chrome.identity.clearAllCachedAuthTokens(function () {
        console.log('[Options] All cached tokens cleared');
        driveBackupToggle.checked = false;
        chrome.storage.local.set({ portility_drive_backup_enabled: false });
        hideDriveStatus();
        showSignedOut();
      });
    });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function checkAccountStatus() {
    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (chrome.runtime.lastError || !token) {
        showSignedOut();
        return;
      }
      // Fetch user profile to get email
      fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + token }
      })
        .then(function (r) { return r.json(); })
        .then(function (info) {
          if (info.email) {
            showSignedIn(info.email);
          } else {
            showSignedIn('Signed in');
          }
        })
        .catch(function () {
          showSignedIn('Signed in');
        });
    });
  }

  function showSignedIn(email) {
    accountEmail.textContent = email;
    accountSignedIn.style.display = 'block';
    accountSignedOut.style.display = 'none';
  }

  function showSignedOut() {
    accountSignedIn.style.display = 'none';
    accountSignedOut.style.display = 'block';
  }

  function checkDriveStatus() {
    chrome.identity.getAuthToken({ interactive: false }, function (token) {
      if (chrome.runtime.lastError || !token) {
        hideDriveStatus();
      } else {
        showDriveConnected();
      }
    });
  }

  function showDriveConnected() {
    driveStatus.classList.add('visible');
  }

  function hideDriveStatus() {
    driveStatus.classList.remove('visible');
  }

  // ─── Second Opinion History ──────────────────────────────────────────────
  loadSOHistory();

  function loadSOHistory() {
    var listEl = document.getElementById('soHistoryList');
    if (!listEl) return;

    listSOComparisons().then(function (comparisons) {
      if (!comparisons || comparisons.length === 0) {
        listEl.innerHTML = '<div class="so-history-empty">No comparisons yet.</div>';
        return;
      }

      listEl.innerHTML = comparisons.map(function (item) {
        var date = formatSODate(item.createdAt);
        var score = Math.round((item.comparison && item.comparison.agreement_score) || 0);
        var questionType = (item.comparison && item.comparison.question_type) || 'analytical';
        var platform = item.platform || 'claude';
        var scoreClass = score < 34 ? 'so-score-conflict' : score < 67 ? 'so-score-mixed' : 'so-score-agrees';
        var typeClass = 'so-type-' + questionType;

        return '<div class="so-history-row">' +
          '<span class="so-history-date">' + escOptHtml(date) + '</span>' +
          '<span class="so-history-platform">' + soPlatformIcon(platform) + '</span>' +
          '<span class="so-history-score ' + scoreClass + '">' + score + '</span>' +
          '<span class="so-history-type ' + typeClass + '">' +
            escOptHtml(questionType.charAt(0).toUpperCase() + questionType.slice(1)) +
          '</span>' +
        '</div>';
      }).join('');
    }).catch(function (err) {
      console.log('[Options] Failed to load SO history:', err);
      listEl.innerHTML = '<div class="so-history-empty">Could not load history.</div>';
    });
  }

  function formatSODate(isoString) {
    if (!isoString) return '\u2014';
    var d = new Date(isoString);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function soPlatformIcon(platform) {
    var icons = {
      claude: '<svg width="14" height="14" viewBox="0 0 1200 1200" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M233.96 800.21L468.64 668.54l3.95-11.44-3.95-6.36h-11.44l-39.22-2.42-134.09-3.62-116.3-4.83-112.67-6.04L26.58 627.79 0 592.75l2.74-17.48 23.84-16.03 34.15 2.98 75.46 5.15 113.23 7.81 82.15 4.83 121.69 12.65h19.33l2.74-7.81-6.6-4.83-5.16-4.83L346.39 495.79 219.54 411.87l-66.44-48.32-35.92-24.48-18.12-22.95-7.81-50.1 32.62-35.92 43.81 2.98 11.19 2.98 44.38 34.15 94.79 73.37 123.79 91.17 18.12 15.06 7.25-5.15.89-3.63-8.14-13.61-67.33-121.69L320.78 181.93l-31.97-51.3-8.46-30.77c-2.98-12.64-5.15-23.27-5.15-36.24L312.32 13.21l20.54-6.6 49.53 6.6 20.86 18.12 30.77 70.39 49.85 110.82 77.32 150.68 22.63 44.7 12.08 41.4 4.51 12.64h7.81v-7.25l6.36-84.89 11.76-104.21 11.44-134.09 3.95-37.77 18.68-45.26 37.13-24.48 28.83 13.85 23.84 34.15-3.3 22.07-14.17 92.13-27.79 144.32-18.12 96.64 10.55 0 12.08-12.08 48.89-64.91 82.15-102.68 36.24-40.75 42.28-45.02 27.14-21.42 51.3 0 37.77 56.13-16.91 58-52.83 67.01-43.81 56.78-62.82 84.56-39.22 67.65 3.62 5.4 9.34-.89 141.91-30.2 76.67-13.85 91.49-15.7 41.4 19.33 4.51 19.65-16.27 40.19-97.85 24.16-114.77 22.95-170.9 40.43-2.09 1.53 2.42 2.98 76.99 7.25 32.94 1.77 80.62 0 150.12 11.19 39.22 25.93 23.52 31.73-3.95 24.16-60.4 30.77-81.5-19.33-190.23-45.26-65.46-16.27-8.47 0v5.4l54.36 53.15 99.62 89.96 124.75 115.97 6.36 28.67-16.03 22.63-16.91-2.42-109.61-82.47-42.28-37.13-95.76-80.62-6.36 0v8.46l22.07 32.3 116.54 175.17 6.04 53.72-8.46 17.48-30.2 10.55-33.18-6.04-68.21-95.76-70.39-107.84-56.78-96.64-6.93 3.95-33.5 360.89-16.27 18.44-36.24 13.85-30.2-22.95-16.03-37.13 16.03-73.37 19.33-95.76 15.7-76.31 14.17-94.55 8.46-31.41-.56-2.09-6.93.89-71.23 97.85-108.4 146.5-85.77 91.81-20.54 8.14-35.6-18.44 3.3-32.94 19.89-29.35 118.71-150.12 71.6-93.58 46.23-47.74-.32-7.81-2.74 0L205.29 929.4l-56.13 7.25-24.16-22.63 2.98-37.13 11.44-12.08 94.79-65.23-.32.32z" fill="#d97757"/></svg>',
      gemini: '<svg width="14" height="14" viewBox="0 0 65 65" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.9 38.9 0 002 5.905c2.15 5 5.1 9.376 8.853 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 2c.66.165 1.124.757 1.124 1.437 0 .68-.464 1.273-1.125 1.44a38.9 38.9 0 00-5.905 1.998c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.97 38.97 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.9 38.9 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.97 38.97 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.9 38.9 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.97 38.97 0 002-5.905A1.485 1.485 0 0132.447 0z" fill="url(#gemiGradOpt)"/><defs><linearGradient id="gemiGradOpt" x1="18" y1="43" x2="52" y2="15" gradientUnits="userSpaceOnUse"><stop stop-color="#4285f4"/><stop offset="1" stop-color="#a374db"/></linearGradient></defs></svg>',
      chatgpt: '<svg width="14" height="14" viewBox="0 0 2406 2406" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 578.4C1 259.5 259.5 1 578.4 1h1249.1c319 0 577.5 258.5 577.5 577.4V2406H578.4C259.5 2406 1 2147.5 1 1828.6V578.4z" fill="#74aa9c"/><path d="M1107.3 299.1c-198 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.5V833.3h.1v-27.9L1372.7 604c33.7-19.5 70.4-32.9 108.5-39.8L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.7 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.1 151.6-338.9 339-339.2z" fill="#fff"/></svg>',
    };
    return icons[platform] || icons.claude;
  }

  function escOptHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
