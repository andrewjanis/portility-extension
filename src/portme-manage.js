'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var editInstructionsBtn = document.getElementById('editInstructionsBtn');
  var editNote = document.getElementById('editNote');
  var profilesSection = document.getElementById('profilesSection');
  var profilesList = document.getElementById('profilesList');
  var profilesStatus = document.getElementById('profilesStatus');

  // ─── Edit Instructions ───────────────────────────────────────────────────
  editInstructionsBtn.addEventListener('click', function () {
    chrome.storage.local.set({ edit_instructions_pending: true }, function () {
      editNote.style.display = 'block';
    });
  });

  // ─── Tier check ──────────────────────────────────────────────────────────
  chrome.storage.local.get('userTier', function (result) {
    var tier = (result.userTier && result.userTier.tier) || 'free';
    if (tier !== 'paid') {
      profilesSection.classList.add('locked-overlay');
      profilesList.innerHTML = '<div class="locked-label">Upgrade to Pro to create multiple profiles.</div>';
    } else {
      loadProfiles();
    }
  });

  // ─── Load and render profiles ────────────────────────────────────────────
  function loadProfiles() {
    profilesList.innerHTML = '<div class="empty">Loading profiles...</div>';

    ensureAuthenticated().then(function (auth) {
      return listProfilesFromFirestore(auth.userId, auth.idToken, auth.firebaseUid).then(function (profiles) {
        renderProfiles(profiles, auth);
      });
    }).catch(function (err) {
      console.log('[PortMe Manage] Failed to load profiles:', err);
      profilesList.innerHTML = '<div class="empty">Sign in to manage profiles.</div>';
    });
  }

  function renderProfiles(profiles, auth) {
    if (!profiles || profiles.length === 0) {
      profilesList.innerHTML = '<div class="empty">No profiles yet. Create one from the Portility popup.</div>';
      return;
    }

    profilesList.innerHTML = '';

    for (var i = 0; i < profiles.length; i++) {
      (function (profile) {
        var row = document.createElement('div');
        row.className = 'profile-row';

        // Badge
        var colour = PROFILE_COLOURS[profile.colourIndex] || PROFILE_COLOURS[0];
        var badge = document.createElement('div');
        badge.className = 'profile-badge';
        badge.style.background = colour.bg;
        badge.style.border = '1.5px solid ' + colour.swatch;

        if (profile.icon === 'portility') {
          var img = document.createElement('img');
          img.src = 'icons/logo-circle.png';
          img.alt = 'Portility';
          badge.appendChild(img);
        } else {
          var icon = document.createElement('i');
          icon.className = 'ti ' + profile.icon;
          icon.style.color = colour.icon;
          badge.appendChild(icon);
        }
        row.appendChild(badge);

        // Info
        var info = document.createElement('div');
        info.className = 'profile-info';

        var nameInput = document.createElement('input');
        nameInput.className = 'profile-name-input';
        nameInput.type = 'text';
        nameInput.value = profile.name;
        nameInput.maxLength = 30;
        nameInput.title = 'Click to rename';
        info.appendChild(nameInput);

        var typeLabel = document.createElement('div');
        typeLabel.className = 'profile-type-label';
        typeLabel.textContent = profile.type;
        info.appendChild(typeLabel);

        row.appendChild(info);

        // Actions
        var actions = document.createElement('div');
        actions.className = 'profile-actions';

        // Default indicator / radio
        if (profile.isDefault) {
          var pill = document.createElement('span');
          pill.className = 'default-pill';
          pill.textContent = 'Default';
          actions.appendChild(pill);
        }

        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'defaultProfile';
        radio.className = 'default-radio';
        radio.checked = !!profile.isDefault;
        radio.title = 'Set as default';

        radio.addEventListener('change', function () {
          if (!this.checked) return;
          profilesStatus.textContent = 'Updating...';
          profilesStatus.className = 'status-msg';
          setDefaultProfile(profile.id, auth.userId, auth.idToken, auth.firebaseUid).then(function () {
            profilesStatus.textContent = '';
            loadProfiles();
          }).catch(function (err) {
            profilesStatus.textContent = 'Failed to set default.';
            profilesStatus.className = 'status-msg error';
            console.log('[PortMe Manage] Failed to set default:', err);
          });
        });
        actions.appendChild(radio);

        // Delete button
        var delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Delete profile';
        delBtn.disabled = profiles.length <= 1;

        delBtn.addEventListener('click', function () {
          if (profiles.length <= 1) return;
          if (!confirm('Delete "' + profile.name + '"?')) return;

          profilesStatus.textContent = 'Deleting...';
          profilesStatus.className = 'status-msg';
          deleteProfileFromFirestore(profile.id, auth.idToken, auth.firebaseUid).then(function () {
            profilesStatus.textContent = '';
            loadProfiles();
          }).catch(function (err) {
            profilesStatus.textContent = 'Failed to delete profile.';
            profilesStatus.className = 'status-msg error';
            console.log('[PortMe Manage] Failed to delete:', err);
          });
        });
        actions.appendChild(delBtn);

        row.appendChild(actions);

        // Inline rename
        nameInput.addEventListener('blur', function () {
          var newName = this.value.trim();
          if (!newName || newName === profile.name) {
            this.value = profile.name;
            return;
          }
          profile.name = newName;
          saveProfileToFirestore(profile, auth.userId, auth.idToken, auth.firebaseUid).catch(function (err) {
            console.log('[PortMe Manage] Failed to rename:', err);
          });
        });

        nameInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.blur();
          }
        });

        profilesList.appendChild(row);
      })(profiles[i]);
    }
  }
});
