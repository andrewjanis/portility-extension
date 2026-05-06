'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var driveBackupToggle = document.getElementById('driveBackupToggle');
  var driveStatus = document.getElementById('driveStatus');
  var driveDisconnectBtn = document.getElementById('driveDisconnectBtn');
  var compressToggle = document.getElementById('compressToggle');
  var signOutBtn = document.getElementById('signOutBtn');
  var signInBtn = document.getElementById('signInBtn');
  var accountSignedIn = document.getElementById('accountSignedIn');
  var accountSignedOut = document.getElementById('accountSignedOut');
  var accountEmail = document.getElementById('accountEmail');

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
});
