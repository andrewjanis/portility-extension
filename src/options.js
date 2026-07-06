'use strict';

document.addEventListener('DOMContentLoaded', function () {
  // BetaAccess launch mode: mirrors the flag in popup.js/worker.js. All
  // authenticated users get Premium-parity access unless a devTierOverride
  // is explicitly set. Set to false to revert (fall re-enable).
  var BETA_ACCESS_MODE = true;

  // Resolves the effective tier the same way popup.js does: devTierOverride
  // wins, then the BetaAccess forced override for authenticated users, then
  // the last-known Firestore tier cached in storage, then 'free'.
  function resolveEffectiveTier(result) {
    if (result.devTierOverride) return result.devTierOverride;
    if (BETA_ACCESS_MODE && result.firebase_id_token && result.firebase_uid) return 'BetaAccess';
    return (result.userTier && result.userTier.tier) || 'free';
  }

  var driveBackupToggle = document.getElementById('driveBackupToggle');
  var driveStatus = document.getElementById('driveStatus');
  var driveDisconnectBtn = document.getElementById('driveDisconnectBtn');
  var compressToggle = document.getElementById('compressToggle');
  var managePortMeBtn = document.getElementById('managePortMeBtn');
  var signOutBtn = document.getElementById('signOutBtn');
  var accountSection = document.getElementById('accountSection');

  // ─── DEV: Tier radio buttons (HIDDEN by default — keep for testing) ─────
  // To show: run document.getElementById('devTierSection').style.display='' in devtools.
  // Uses a separate storage key (devTierOverride) so it can never be
  // clobbered by the normal tier-refresh flow that writes to userTier.
  var devTierContainer = document.getElementById('devTierRadios');
  var devTierStatus = document.createElement('div');
  devTierStatus.style.cssText = 'font-size:11px;color:#f97316;margin-top:4px;';
  devTierContainer.parentNode.insertBefore(devTierStatus, devTierContainer.nextSibling);

  chrome.storage.local.get(['devTierOverride', 'userTier'], function (result) {
    var tier = result.devTierOverride || null;
    var actual = (result.userTier && result.userTier.tier) || 'free';
    if (tier) {
      var match = devTierContainer.querySelector('input[value="' + tier + '"]');
      if (match) match.checked = true;
      devTierStatus.textContent = 'Active override: ' + tier + ' (actual: ' + actual + ')';
    } else {
      // No override — select "None" and show actual tier
      var noneRadio = devTierContainer.querySelector('input[value="none"]');
      if (noneRadio) noneRadio.checked = true;
      devTierStatus.textContent = 'No override (actual: ' + actual + ')';
    }
  });

  devTierContainer.addEventListener('change', function (e) {
    if (e.target.name !== 'devTier') return;
    var newTier = e.target.value;
    // "None" clears the override — uses real Firestore tier
    if (newTier === 'none') {
      console.log('[Options] Clearing dev tier override');
      chrome.storage.local.remove('devTierOverride', function () {
        console.log('[Options] Dev tier override cleared, reloading');
        location.reload();
      });
      return;
    }
    // Block paid3 override — server-side only assignment
    if (newTier === 'paid3') {
      devTierStatus.textContent = 'paid3 cannot be set via dev override';
      devTierStatus.style.color = '#ef4444';
      // Revert to previous selection
      chrome.storage.local.get('devTierOverride', function (r) {
        var prev = r.devTierOverride || null;
        if (prev && prev !== 'paid3') {
          var match = devTierContainer.querySelector('input[value="' + prev + '"]');
          if (match) match.checked = true;
        } else {
          var noneRadio = devTierContainer.querySelector('input[value="none"]');
          if (noneRadio) noneRadio.checked = true;
        }
      });
      return;
    }
    console.log('[Options] Dev tier override set to:', newTier);
    // Write to separate key so it cannot be overwritten by tier refresh
    chrome.storage.local.set({ devTierOverride: newTier }, function () {
      console.log('[Options] Dev tier override saved, reloading');
      location.reload();
    });
  });

  // ─── Tier gating ─────────────────────────────────────────────────────────
  var imageQualitySection = document.getElementById('imageQualitySection');
  var portTextModeSection = document.getElementById('portTextModeSection');

  chrome.storage.local.get(['devTierOverride', 'userTier', 'firebase_id_token', 'firebase_uid'], function (result) {
    var tier = resolveEffectiveTier(result);
    var isPremium = tier === 'paid2' || tier === 'paid3' || tier === 'BetaAccess';
    // Text mode and image compression are Premium-only features
    if (!isPremium) {
      [imageQualitySection, portTextModeSection].forEach(function (section) {
        if (!section) return;
        section.classList.add('locked');
        var toggle = section.querySelector('input[type="checkbox"]');
        if (toggle) toggle.checked = false;
        var label = document.createElement('span');
        label.className = 'paid-label';
        label.textContent = 'Premium feature';
        var titleEl = section.querySelector('.section-title');
        if (titleEl) titleEl.appendChild(label);
      });
    }
  });

  // ─── Load saved settings ──────────────────────────────────────────────────
  chrome.storage.local.get(
    ['portility_drive_backup_enabled', 'portility_compress_images', 'devTierOverride', 'userTier', 'firebase_id_token', 'firebase_uid'],
    function (result) {
      var tier = resolveEffectiveTier(result);
      var isPremium = tier === 'paid2' || tier === 'paid3' || tier === 'BetaAccess';
      if (tier !== 'free') {
        driveBackupToggle.checked = result.portility_drive_backup_enabled === true;
        // Only load saved compress preference for Premium — Pro is locked to OFF (uncompressed)
        if (isPremium) {
          compressToggle.checked = result.portility_compress_images === true;
        }
      } else {
        driveBackupToggle.checked = false;
        compressToggle.checked = false;
      }

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

  // ─── Port text mode toggle ──────────────────────────────────────────────
  var portTextModeToggle = document.getElementById('portTextModeToggle');

  chrome.storage.local.get(['portility_pmc_text_mode', 'devTierOverride', 'userTier', 'firebase_id_token', 'firebase_uid'], function (result) {
    var tier = resolveEffectiveTier(result);
    var isPremium = tier === 'paid2' || tier === 'paid3' || tier === 'BetaAccess';
    // Only load saved text mode for Premium — Pro is locked to OFF (full text)
    if (isPremium) {
      var mode = result.portility_pmc_text_mode || 'full';
      portTextModeToggle.checked = mode === 'summary';
    }
  });

  portTextModeToggle.addEventListener('change', function () {
    var mode = portTextModeToggle.checked ? 'summary' : 'full';
    chrome.storage.local.set({ portility_pmc_text_mode: mode });
  });

  // ─── Manage Port Me ──────────────────────────────────────────────────────
  if (managePortMeBtn) {
    managePortMeBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('portme-manage.html') });
    });
  }

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
        chrome.storage.local.remove([
          'google_login_hint', 'firebase_id_token', 'firebase_uid',
          'firebase_token_expiry', 'google_access_token', 'google_user_id',
          'devTierOverride',
        ]);
        hideDriveStatus();
        accountSection.style.display = 'none';
      });
    });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  // Note: this checks the Portility sign-in state (firebase_id_token/firebase_uid
  // from oauth.js's launchWebAuthFlow), NOT chrome.identity.getAuthToken — that's
  // a separate OAuth client only used for the (currently locked) Drive backup toggle.
  function checkAccountStatus() {
    chrome.storage.local.get(['firebase_id_token', 'firebase_uid'], function (result) {
      accountSection.style.display = (result.firebase_id_token && result.firebase_uid) ? 'block' : 'none';
    });
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
  var viewSOHistoryBtn = document.getElementById('viewSOHistoryBtn');
  if (viewSOHistoryBtn) {
    viewSOHistoryBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('so-history.html') });
    });
  }

  // ─── See your files (Drive link) ─────────────────────────────────────────
  var driveFilesLink = document.getElementById('driveFilesLink');
  if (driveFilesLink) {
    driveFilesLink.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://drive.google.com/drive/search?q=Portility' });
    });
  }

  // ─── Billing ────────────────────────────────────────────────────────────────
  var manageBillingBtn = document.getElementById('manageBillingBtn');
  if (manageBillingBtn) {
    manageBillingBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: 'https://portility.app/billing' });
    });
  }

  // ─── Usage ────────────────────────────────────────────────────────────────
  var usageSection = document.getElementById('usageSection');
  var usageSummary = document.getElementById('usageSummary');
  var usageHistoryEl = document.getElementById('usageHistory');

  function loadUsageInfo() {
    ensureAuthenticated().then(function (auth) {
      // Check for dev tier override (separate storage key) before hitting Firestore
      return new Promise(function (resolve) {
        chrome.storage.local.get('devTierOverride', function (result) {
          if (result.devTierOverride) {
            console.log('[Options] Using dev tier override:', result.devTierOverride);
            resolve({ auth: auth, tier: result.devTierOverride });
          } else {
            getUserTier(auth.idToken, auth.firebaseUid).then(function (tier) {
              resolve({ auth: auth, tier: tier });
            }).catch(function (e) {
              console.log('[Options] getUserTier failed, defaulting to free:', e.message || e);
              resolve({ auth: auth, tier: 'free' });
            });
          }
        });
      });
    }).then(function (ctx) {
      var auth = ctx.auth;
      var tier = ctx.tier;

      // Fetch summary + history in parallel
      return Promise.all([
        getCurrentUsageSummary(auth.idToken, auth.firebaseUid, tier),
        getUsageHistory(auth.idToken, auth.firebaseUid),
      ]).then(function (results) {
        var summary = results[0];
        var history = results[1];
        renderUsage(summary, history);
      });
    }).catch(function () {
      if (usageSection) usageSection.style.display = 'none';
    });
  }

  function renderUsage(summary, history) {
    if (!usageSummary) return;

    // Summary line
    var tierLabel = summary.tierLabel || summary.tier;
    var summaryText;
    if (summary.limit === Infinity || summary.limit === null) {
      summaryText = 'You are on ' + tierLabel + ' \u2014 ' + summary.used + ' uses (unlimited)';
    } else {
      summaryText = 'You are on ' + tierLabel + ' \u2014 ' + summary.used + ' of ' + summary.limit + ' uses';
      if (summary.isLifetime) {
        summaryText += ' (lifetime)';
      } else {
        summaryText += ' this month';
      }
    }
    // Trial/usage info kept in backend but not surfaced to users
    usageSummary.textContent = 'You are on ' + (summary.tierLabel || summary.tier);

    // History (only for paid users)
    if (!usageHistoryEl) return;
    usageHistoryEl.innerHTML = '';

    if (summary.isLifetime) return; // Free users just see lifetime count

    // Get sorted keys (most recent first), limit to 12
    var keys = Object.keys(history).sort().reverse().slice(0, 12);
    if (keys.length === 0) {
      var note = document.createElement('div');
      note.className = 'usage-history-row';
      note.style.color = '#9ca3af';
      note.textContent = 'Usage resets each billing cycle.';
      usageHistoryEl.appendChild(note);
      return;
    }

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var parts = key.split('-');
      var year = parts[0];
      var monthNum = parseInt(parts[1], 10);
      var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var monthName = monthNames[monthNum - 1] || key;

      var row = document.createElement('div');
      row.className = 'usage-history-row';
      row.textContent = monthName + ' ' + year + ' \u2014 ' + history[key] + ' uses';
      usageHistoryEl.appendChild(row);
    }
  }

  // Load usage for signed-in users
  chrome.identity.getAuthToken({ interactive: false }, function (token) {
    if (chrome.runtime.lastError || !token) {
      if (usageSection) usageSection.style.display = 'none';
      return;
    }
    loadUsageInfo();
  });

  // ─── Version label ─────────────────────────────────────────────────────
  var versionLabel = document.getElementById('versionLabel');
  if (versionLabel) {
    var manifest = chrome.runtime.getManifest();
    versionLabel.textContent = 'Portility v' + manifest.version;
  }

});
