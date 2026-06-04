'use strict';

document.addEventListener('DOMContentLoaded', function () {
  var editInstructionsBtn = document.getElementById('editInstructionsBtn');
  var editStatus = document.getElementById('editStatus');
  var instructionsSection = document.getElementById('instructionsSection');
  var questionnaireContainer = document.getElementById('questionnaire-container');
  var profilesSection = document.getElementById('profilesSection');
  var profilesList = document.getElementById('profilesList');
  var profilesStatus = document.getElementById('profilesStatus');
  var newProfileBtn = document.getElementById('newProfileBtn');
  var newProfileFlow = document.getElementById('newProfileFlow');
  var backToSettingsBtn = document.getElementById('backToSettingsBtn');
  var _userTier = 'paid'; // default to Pro; updated from storage below

  // Questionnaire elements
  var mqPage1Content = document.getElementById('mq-page1-content');
  var mqPage2Content = document.getElementById('mq-page2-content');
  var mqPage1NextBtn = document.getElementById('mqPage1NextBtn');
  var mqSaveBtn = document.getElementById('mqSaveBtn');
  var mqBackBtn = document.getElementById('mqBackBtn');
  var mqCancelBtn1 = document.getElementById('mqCancelBtn1');
  var mqCancelBtn2 = document.getElementById('mqCancelBtn2');
  var mqSaveError = document.getElementById('mqSaveError');

  // New profile elements
  var npTypeCancelBtn = document.getElementById('npTypeCancelBtn');
  var npQContent = document.getElementById('np-q-content');
  var npQNextBtn = document.getElementById('npQNextBtn');
  var npQCancelBtn = document.getElementById('npQCancelBtn');
  var npSaveBtn = document.getElementById('npSaveBtn');
  var npSaveCancelBtn = document.getElementById('npSaveCancelBtn');
  var npCustomizeBackBtn = document.getElementById('npCustomizeBackBtn');
  var npSaveStatus = document.getElementById('npSaveStatus');
  var npPreviewBadge = document.getElementById('npPreviewBadge');
  var npNameInput = document.getElementById('npNameInput');
  var npIconGrid = document.getElementById('npIconGrid');
  var npColorRow = document.getElementById('npColorRow');

  // Document upload elements
  var npDocUploadBtn = document.getElementById('npDocUploadBtn');
  var npDocFileInput = document.getElementById('npDocFileInput');
  var npDocFileName = document.getElementById('npDocFileName');
  var npDocRemoveBtn = document.getElementById('npDocRemoveBtn');

  var mqAnswers = {};

  // New profile state
  var _npType = null;
  var _npAnswers = {};
  var _npIcon = null;
  var _npColorIndex = 0;
  var _npDocument = null; // { name, content }
  var _editingProfile = null;
  var _cachedAuth = null;
  var _cachedProfiles = [];

  // ─── Back to Settings ────────────────────────────────────────────────────
  backToSettingsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDIT INSTRUCTIONS (all users)
  // ═══════════════════════════════════════════════════════════════════════════

  editInstructionsBtn.addEventListener('click', function () {
    editInstructionsBtn.disabled = true;
    editStatus.textContent = 'Loading your answers...';
    editStatus.className = 'status-msg';

    chrome.storage.local.get('questionnaire_answers', function (data) {
      if (data.questionnaire_answers) {
        startQuestionnaire(data.questionnaire_answers);
      } else {
        ensureAuthenticated().then(function (auth) {
          return getInstructionsFromFirestore(auth.idToken, auth.firebaseUid);
        }).then(function (fsData) {
          startQuestionnaire(fsData && fsData.answers ? fsData.answers : null);
        }).catch(function () {
          startQuestionnaire(null);
        });
      }
    });
  });

  function startQuestionnaire(savedAnswers) {
    editStatus.textContent = '';
    editInstructionsBtn.disabled = false;
    initMqAnswers();
    if (savedAnswers) mqAnswers = Object.assign({}, mqAnswers, savedAnswers);
    renderMqQuestionnaire();
    prefillAnswersIn(questionnaireContainer, mqAnswers, 'mq');
    wireOptionHandlersIn(questionnaireContainer, mqAnswers, 'mq');
    wireRangeHandlersFor(QUESTIONNAIRE_CONFIG.pages, mqAnswers, 'mq');
    instructionsSection.style.display = 'none';
    questionnaireContainer.classList.add('active');
    showMqPage('mq-page1');
  }

  function initMqAnswers() {
    mqAnswers = {};
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        if (sec.type === 'multi-select') {
          mqAnswers[sec.key] = [];
          mqAnswers[sec.key + '_customText'] = '';
        } else if (sec.type === 'range') {
          mqAnswers[sec.key] = sec.default || 3;
        } else if (sec.type === 'textarea') {
          mqAnswers[sec.key] = '';
        } else {
          mqAnswers[sec.key] = null;
        }
      }
    }
    if (QUESTIONNAIRE_CONFIG.hiddenFields) {
      var hKeys = Object.keys(QUESTIONNAIRE_CONFIG.hiddenFields);
      for (var h = 0; h < hKeys.length; h++) mqAnswers[hKeys[h]] = null;
    }
  }

  function renderMqQuestionnaire() {
    var pages = QUESTIONNAIRE_CONFIG.pages;
    for (var p = 0; p < pages.length; p++) {
      var container = (p === 0) ? mqPage1Content : mqPage2Content;
      if (!container) continue;
      container.innerHTML = '';
      renderSectionsInto(container, pages[p].sections, 'mq');
    }
  }

  function showMqPage(pageId) {
    var screens = questionnaireContainer.querySelectorAll('.q-screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    var target = document.getElementById(pageId);
    if (target) target.classList.add('active');
  }

  mqPage1NextBtn.addEventListener('click', function () {
    var page1 = QUESTIONNAIRE_CONFIG.pages[0];
    if (!page1) return;
    if (!validatePage(page1, mqAnswers, 'mq')) return;
    showMqPage('mq-page2');
  });

  mqBackBtn.addEventListener('click', function () { showMqPage('mq-page1'); });

  function cancelQuestionnaire() {
    questionnaireContainer.classList.remove('active');
    instructionsSection.style.display = '';
  }
  mqCancelBtn1.addEventListener('click', cancelQuestionnaire);
  mqCancelBtn2.addEventListener('click', cancelQuestionnaire);

  mqSaveBtn.addEventListener('click', async function () {
    mqSaveBtn.disabled = true;
    mqSaveBtn.textContent = 'Saving\u2026';
    mqSaveError.textContent = '';
    try {
      captureTextareas(QUESTIONNAIRE_CONFIG.pages[1], mqAnswers, 'mq');
      var instructions = buildInstructionPacket(mqAnswers);
      var auth = await ensureAuthenticated();
      await saveInstructionsToFirestore(instructions, auth.userId, auth.idToken, auth.firebaseUid, mqAnswers);
      await new Promise(function (resolve) {
        chrome.storage.local.set({ questionnaire_completed: true, questionnaire_answers: mqAnswers }, resolve);
      });
      mqSaveBtn.textContent = 'Saved!';
      setTimeout(function () {
        questionnaireContainer.classList.remove('active');
        instructionsSection.style.display = '';
        editStatus.textContent = 'Instructions updated successfully.';
        editStatus.className = 'status-msg success';
        mqSaveBtn.textContent = 'Save Instructions';
        mqSaveBtn.disabled = false;
      }, 1200);
    } catch (err) {
      mqSaveError.textContent = err.message || 'Failed to save. Try again.';
      mqSaveBtn.textContent = 'Save Instructions';
      mqSaveBtn.disabled = false;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROFILES (paid only)
  // ═══════════════════════════════════════════════════════════════════════════

  chrome.storage.local.get(['devTierOverride', 'userTier'], function (result) {
    var tier = result.devTierOverride || (result.userTier && result.userTier.tier) || 'free';
    _userTier = tier;
    if (tier === 'free') {
      profilesSection.classList.add('locked-overlay');
      profilesList.innerHTML = '<div class="locked-label">Upgrade to Pro to create multiple profiles.</div>';
      newProfileBtn.style.display = 'none';
    } else {
      loadProfiles();
    }
  });

  function loadProfiles() {
    profilesList.innerHTML = '<div class="empty">Loading profiles...</div>';
    getCachedAuth(function (auth) {
      if (!auth) {
        profilesList.innerHTML = '<div class="empty">Sign in to manage profiles.</div>';
        return;
      }
      _cachedAuth = auth;
      var timeoutId = setTimeout(function () {
        profilesList.innerHTML = '<div class="empty">No profiles yet. Click "+ New Profile" to create one.</div>';
      }, 10000);

      listProfilesFromFirestore(auth.userId, auth.idToken, auth.firebaseUid).then(function (profiles) {
        clearTimeout(timeoutId);
        _cachedProfiles = profiles || [];
        renderProfiles(profiles, auth);
        updateNewProfileBtn();
      }).catch(function (err) {
        clearTimeout(timeoutId);
        console.log('[PortMe Manage] Failed to load profiles:', err);
        _cachedProfiles = [];
        profilesList.innerHTML = '<div class="empty">No profiles yet. Click "+ New Profile" to create one.</div>';
        updateNewProfileBtn();
      });
    });
  }

  function getCachedAuth(callback) {
    chrome.storage.local.get([
      'firebase_id_token', 'firebase_uid', 'firebase_token_expiry',
      'google_access_token', 'google_user_id'
    ], function (cached) {
      var now = Date.now();
      if (cached.firebase_id_token && cached.firebase_token_expiry &&
        now < cached.firebase_token_expiry && cached.google_access_token && cached.google_user_id) {
        callback({
          token: cached.google_access_token,
          userId: cached.google_user_id,
          firebaseUid: cached.firebase_uid,
          idToken: cached.firebase_id_token,
        });
      } else {
        callback(null);
      }
    });
  }

  function updateNewProfileBtn() {
    var maxProfiles = getMaxProfiles(_userTier);
    if (_cachedProfiles.length >= maxProfiles) {
      newProfileBtn.disabled = true;
      newProfileBtn.textContent = maxProfiles === Infinity ? 'Max profiles reached' : 'Max profiles reached (' + maxProfiles + ')';
    } else {
      newProfileBtn.disabled = false;
      newProfileBtn.textContent = '+ New Profile';
    }
  }

  function renderProfiles(profiles, auth) {
    if (!profiles || profiles.length === 0) {
      profilesList.innerHTML = '<div class="empty">No profiles yet. Click "+ New Profile" to create one.</div>';
      return;
    }

    profilesList.innerHTML = '';

    for (var i = 0; i < profiles.length; i++) {
      (function (profile) {
        var row = document.createElement('div');
        row.className = 'profile-row';

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

        var info = document.createElement('div');
        info.className = 'profile-info';
        var nameInput = document.createElement('input');
        nameInput.className = 'profile-name-edit';
        nameInput.type = 'text';
        nameInput.value = profile.name;
        nameInput.maxLength = 30;
        nameInput.title = 'Click to rename';
        info.appendChild(nameInput);
        var typeLabel = document.createElement('div');
        typeLabel.className = 'profile-type-label';
        typeLabel.textContent = profile.type;
        if (profile.document && profile.document.name) {
          var docLabel = document.createElement('div');
          docLabel.className = 'profile-type-label';
          docLabel.textContent = '\uD83D\uDCC4 ' + profile.document.name;
          info.appendChild(docLabel);
        }
        info.appendChild(typeLabel);
        row.appendChild(info);

        var actions = document.createElement('div');
        actions.className = 'profile-actions';

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
          }).catch(function () {
            profilesStatus.textContent = 'Failed to set default.';
            profilesStatus.className = 'status-msg error';
          });
        });
        actions.appendChild(radio);

        var editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.title = 'Edit profile';
        editBtn.addEventListener('click', function () {
          startEditProfile(profile);
        });
        actions.appendChild(editBtn);

        var delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.textContent = 'Delete';
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
          }).catch(function () {
            profilesStatus.textContent = 'Failed to delete profile.';
            profilesStatus.className = 'status-msg error';
          });
        });
        actions.appendChild(delBtn);
        row.appendChild(actions);

        nameInput.addEventListener('blur', function () {
          var newName = this.value.trim();
          if (!newName || newName === profile.name) { this.value = profile.name; return; }
          profile.name = newName;
          saveProfileToFirestore(profile, auth.userId, auth.idToken, auth.firebaseUid).catch(function (err) {
            console.log('[PortMe Manage] Failed to rename:', err);
          });
        });
        nameInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
        });

        profilesList.appendChild(row);
      })(profiles[i]);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW PROFILE FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  newProfileBtn.addEventListener('click', function () {
    if (_cachedProfiles.length >= getMaxProfiles(_userTier)) return;
    _editingProfile = null;
    _npDocument = null;
    npDocFileName.textContent = '';
    npDocRemoveBtn.style.display = 'none';
    npSaveBtn.textContent = 'Save Profile';
    profilesSection.style.display = 'none';
    newProfileFlow.classList.add('active');
    showNpScreen('np-type');
  });

  function cancelNewProfile() {
    _editingProfile = null;
    npSaveBtn.textContent = 'Save Profile';
    newProfileFlow.classList.remove('active');
    profilesSection.style.display = '';
  }

  function startEditProfile(profile) {
    _editingProfile = profile;
    _npType = profile.type;
    _npIcon = profile.icon;
    _npColorIndex = profile.colourIndex;
    _npAnswers = initNpAnswers(profile.type);
    Object.assign(_npAnswers, profile.answers);
    _npDocument = profile.document || null;
    if (_npDocument) {
      npDocFileName.textContent = _npDocument.name;
      npDocRemoveBtn.style.display = '';
    } else {
      npDocFileName.textContent = '';
      npDocRemoveBtn.style.display = 'none';
    }
    renderNpQuestionnaire(profile.type);
    prefillAnswersIn(newProfileFlow, _npAnswers, 'np');
    // Pre-fill textareas and ranges
    var config = PROFILE_QUESTIONNAIRE_CONFIG[profile.type];
    if (config) {
      for (var p = 0; p < config.pages.length; p++) {
        var sections = config.pages[p].sections;
        for (var s = 0; s < sections.length; s++) {
          var sec = sections[s];
          if (sec.type === 'textarea') {
            var ta = document.getElementById('np-textarea-' + sec.key);
            if (ta) ta.value = _npAnswers[sec.key] || '';
          } else if (sec.type === 'range') {
            var rangeEl = document.getElementById('np-range-' + sec.key);
            if (rangeEl) rangeEl.value = _npAnswers[sec.key] || sec.default;
          }
          if (sec.type === 'multi-select') {
            var otherArea = document.getElementById('np-other-area-' + sec.key);
            var otherText = document.getElementById('np-other-text-' + sec.key);
            if (otherArea && Array.isArray(_npAnswers[sec.key]) && _npAnswers[sec.key].indexOf('other') >= 0) {
              otherArea.classList.add('visible');
              if (otherText) otherText.value = _npAnswers[sec.key + '_customText'] || '';
            }
          }
        }
      }
    }
    npSaveBtn.textContent = 'Update Profile';
    profilesSection.style.display = 'none';
    newProfileFlow.classList.add('active');
    showNpScreen('np-questionnaire');
  }

  function showNpScreen(id) {
    var screens = newProfileFlow.querySelectorAll('.np-screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    var target = document.getElementById(id);
    if (target) target.classList.add('active');
  }

  // Step 1: Type selection
  var typeCards = newProfileFlow.querySelectorAll('.profile-type-card');
  for (var tc = 0; tc < typeCards.length; tc++) {
    typeCards[tc].addEventListener('click', function () {
      _npType = this.getAttribute('data-profile-type');
      var defaults = PROFILE_TYPE_DEFAULTS[_npType] || PROFILE_TYPE_DEFAULTS.other;
      _npIcon = defaults.icon;
      _npColorIndex = defaults.colourIndex;
      _npAnswers = initNpAnswers(_npType);
      renderNpQuestionnaire(_npType);
      showNpScreen('np-questionnaire');
    });
  }

  npTypeCancelBtn.addEventListener('click', cancelNewProfile);

  function initNpAnswers(profileType) {
    var answers = {};
    var config = PROFILE_QUESTIONNAIRE_CONFIG[profileType];
    if (!config) return answers;
    var pages = config.pages;
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        if (sec.type === 'multi-select') {
          answers[sec.key] = [];
          answers[sec.key + '_customText'] = '';
        } else if (sec.type === 'textarea') {
          answers[sec.key] = '';
        } else {
          answers[sec.key] = null;
        }
      }
    }
    return answers;
  }

  function renderNpQuestionnaire(profileType) {
    var config = PROFILE_QUESTIONNAIRE_CONFIG[profileType];
    if (!config) return;
    // Render ALL pages into a single container
    npQContent.innerHTML = '';
    var pages = config.pages;
    for (var p = 0; p < pages.length; p++) {
      renderSectionsInto(npQContent, pages[p].sections, 'np');
    }
    wireOptionHandlersIn(newProfileFlow, _npAnswers, 'np');
  }

  // Step 2: Questionnaire → Customize
  npQNextBtn.addEventListener('click', function () {
    var config = PROFILE_QUESTIONNAIRE_CONFIG[_npType];
    if (!config) return;
    // Validate first page sections (multi-select must have selection)
    if (!validatePage(config.pages[0], _npAnswers, 'np')) return;
    // Capture textareas from all pages
    for (var p = 0; p < config.pages.length; p++) {
      captureTextareas(config.pages[p], _npAnswers, 'np');
    }
    renderNpCustomize();
    showNpScreen('np-customize');
  });

  npQCancelBtn.addEventListener('click', cancelNewProfile);

  // Step 3: Customize
  function renderNpCustomize() {
    // Icon grid
    npIconGrid.innerHTML = '';
    for (var i = 0; i < PROFILE_ICONS.length; i++) {
      var iconId = PROFILE_ICONS[i];
      var cell = document.createElement('div');
      cell.className = 'profile-icon-cell' + (iconId === _npIcon ? ' selected' : '');
      cell.setAttribute('data-icon', iconId);

      if (iconId === 'portility') {
        var img = document.createElement('img');
        img.src = 'icons/logo-circle.png';
        img.alt = 'Portility';
        cell.appendChild(img);
      } else {
        var icon = document.createElement('i');
        icon.className = 'ti ' + iconId;
        cell.appendChild(icon);
      }

      (function (id) {
        cell.addEventListener('click', function () {
          var cells = npIconGrid.querySelectorAll('.profile-icon-cell');
          for (var j = 0; j < cells.length; j++) cells[j].classList.remove('selected');
          this.classList.add('selected');
          _npIcon = id;
          // Portility icon defaults to teal (index 0)
          if (id === 'portility') {
            _npColorIndex = 0;
            var swatches = npColorRow.querySelectorAll('.profile-colour-swatch');
            for (var k = 0; k < swatches.length; k++) swatches[k].classList.remove('selected');
            if (swatches[0]) swatches[0].classList.add('selected');
          }
          updateNpPreview();
        });
      })(iconId);

      npIconGrid.appendChild(cell);
    }

    // Color swatches
    npColorRow.innerHTML = '';
    for (var c = 0; c < PROFILE_COLOURS.length; c++) {
      var colour = PROFILE_COLOURS[c];
      var swatch = document.createElement('div');
      swatch.className = 'profile-colour-swatch' + (c === _npColorIndex ? ' selected' : '');
      swatch.style.background = colour.swatch;
      swatch.style.color = colour.swatch;

      (function (idx) {
        swatch.addEventListener('click', function () {
          var swatches = npColorRow.querySelectorAll('.profile-colour-swatch');
          for (var j = 0; j < swatches.length; j++) swatches[j].classList.remove('selected');
          this.classList.add('selected');
          _npColorIndex = idx;
          updateNpPreview();
        });
      })(c);

      npColorRow.appendChild(swatch);
    }

    // Name
    if (_editingProfile) {
      npNameInput.value = _editingProfile.name;
    } else {
      var typeName = _npType.charAt(0).toUpperCase() + _npType.slice(1);
      npNameInput.value = typeName + ' Profile';
    }

    updateNpPreview();
  }

  function updateNpPreview() {
    var colour = PROFILE_COLOURS[_npColorIndex] || PROFILE_COLOURS[0];
    npPreviewBadge.innerHTML = '';
    npPreviewBadge.style.background = colour.bg;
    npPreviewBadge.style.border = '1.5px solid ' + colour.swatch;

    if (_npIcon === 'portility') {
      var img = document.createElement('img');
      img.src = 'icons/logo-circle.png';
      img.alt = 'Portility';
      npPreviewBadge.appendChild(img);
    } else {
      var icon = document.createElement('i');
      icon.className = 'ti ' + _npIcon;
      icon.style.color = colour.icon;
      npPreviewBadge.appendChild(icon);
    }
  }

  npCustomizeBackBtn.addEventListener('click', function () {
    showNpScreen('np-questionnaire');
  });
  npSaveCancelBtn.addEventListener('click', cancelNewProfile);

  // ─── Document upload ─────────────────────────────────────────────────────
  npDocUploadBtn.addEventListener('click', function () {
    npDocFileInput.click();
  });

  npDocFileInput.addEventListener('change', function () {
    var file = this.files[0];
    if (!file) return;

    // 500KB limit
    if (file.size > 500 * 1024) {
      npSaveStatus.textContent = 'File too large (max 500KB).';
      npSaveStatus.className = 'status-msg error';
      this.value = '';
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      _npDocument = { name: file.name, content: e.target.result };
      npDocFileName.textContent = file.name;
      npDocRemoveBtn.style.display = '';
      npSaveStatus.textContent = '';
    };
    reader.onerror = function () {
      npSaveStatus.textContent = 'Failed to read file.';
      npSaveStatus.className = 'status-msg error';
    };
    reader.readAsText(file);
  });

  npDocRemoveBtn.addEventListener('click', function () {
    _npDocument = null;
    npDocFileName.textContent = '';
    npDocRemoveBtn.style.display = 'none';
    npDocFileInput.value = '';
  });

  // ─── Save profile ────────────────────────────────────────────────────────
  npSaveBtn.addEventListener('click', async function () {
    var name = npNameInput.value.trim();
    if (!name) {
      npSaveStatus.textContent = 'Please enter a name.';
      npSaveStatus.className = 'status-msg error';
      return;
    }
    if (name.length > MAX_PROFILE_NAME_LENGTH) {
      npSaveStatus.textContent = 'Name too long (max ' + MAX_PROFILE_NAME_LENGTH + ' chars).';
      npSaveStatus.className = 'status-msg error';
      return;
    }

    npSaveBtn.disabled = true;
    npSaveBtn.textContent = 'Saving\u2026';
    npSaveStatus.textContent = '';

    try {
      var auth = _cachedAuth || await ensureAuthenticated();
      var now = new Date().toISOString();
      var isFirst = _cachedProfiles.length === 0;

      var profile = {
        id: _editingProfile ? _editingProfile.id : generateProfileId(),
        name: name,
        type: _npType,
        icon: _npIcon,
        colourIndex: _npColorIndex,
        answers: _npAnswers,
        isDefault: _editingProfile ? _editingProfile.isDefault : isFirst,
        lastUsed: now,
        createdAt: _editingProfile ? _editingProfile.createdAt : now,
      };

      if (_npDocument) {
        profile.document = _npDocument;
      }

      await saveProfileToFirestore(profile, auth.userId, auth.idToken, auth.firebaseUid);

      await new Promise(function (resolve) {
        chrome.storage.local.set({ questionnaire_completed: true }, resolve);
      });

      npSaveBtn.textContent = _editingProfile ? 'Updated!' : 'Saved!';
      setTimeout(function () {
        cancelNewProfile();
        npSaveBtn.disabled = false;
        npSaveStatus.textContent = '';
        loadProfiles();
      }, 800);

    } catch (err) {
      npSaveStatus.textContent = err.message || 'Failed to save. Try again.';
      npSaveStatus.className = 'status-msg error';
      npSaveBtn.textContent = 'Save Profile';
      npSaveBtn.disabled = false;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED RENDERING HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function renderSectionsInto(container, sections, prefix) {
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];

      var titleEl = document.createElement('div');
      titleEl.className = 'q-section-title';
      titleEl.textContent = sec.title;
      container.appendChild(titleEl);

      if (sec.type === 'multi-select') {
        var wrap = document.createElement('div');
        wrap.setAttribute('data-multiselect', 'true');
        for (var o = 0; o < sec.options.length; o++) {
          var opt = sec.options[o];
          var btn = document.createElement('button');
          btn.className = 'q-option';
          btn.setAttribute('data-question', sec.key);
          btn.setAttribute('data-value', opt.value);
          btn.textContent = opt.label;
          wrap.appendChild(btn);
          if (opt.customTextPlaceholder) {
            var otherArea = document.createElement('div');
            otherArea.className = 'q-other-area';
            otherArea.id = prefix + '-other-area-' + sec.key;
            var ta = document.createElement('textarea');
            ta.className = 'q-textarea';
            ta.id = prefix + '-other-text-' + sec.key;
            ta.placeholder = opt.customTextPlaceholder;
            otherArea.appendChild(ta);
            wrap.appendChild(otherArea);
          }
        }
        container.appendChild(wrap);

      } else if (sec.type === 'single-select-chips') {
        var chipRow = document.createElement('div');
        chipRow.className = 'q-chips-row';
        for (var c = 0; c < sec.options.length; c++) {
          var chipOpt = sec.options[c];
          var chipBtn = document.createElement('button');
          chipBtn.className = 'q-option q-chip';
          chipBtn.setAttribute('data-question', sec.key);
          chipBtn.setAttribute('data-value', chipOpt.value);
          chipBtn.textContent = chipOpt.label;
          chipRow.appendChild(chipBtn);
        }
        container.appendChild(chipRow);

      } else if (sec.type === 'range') {
        if (sec.subtitle) {
          var subEl = document.createElement('div');
          subEl.className = 'q-section-subtitle';
          subEl.textContent = sec.subtitle;
          container.appendChild(subEl);
        }
        var rangeWrap = document.createElement('div');
        rangeWrap.className = 'q-range-wrap';
        var rangeInput = document.createElement('input');
        rangeInput.type = 'range';
        rangeInput.id = prefix + '-range-' + sec.key;
        rangeInput.min = sec.min;
        rangeInput.max = sec.max;
        rangeInput.value = sec.default;
        rangeInput.step = 1;
        rangeInput.className = 'q-range';
        rangeWrap.appendChild(rangeInput);
        if (sec.labels) {
          var labelsDiv = document.createElement('div');
          labelsDiv.className = 'q-range-labels';
          for (var l = 0; l < sec.labels.length; l++) {
            var span = document.createElement('span');
            span.textContent = sec.labels[l];
            labelsDiv.appendChild(span);
          }
          rangeWrap.appendChild(labelsDiv);
        }
        container.appendChild(rangeWrap);

      } else if (sec.type === 'textarea') {
        var textarea = document.createElement('textarea');
        textarea.className = 'q-textarea';
        textarea.id = prefix + '-textarea-' + sec.key;
        textarea.placeholder = sec.placeholder || '';
        container.appendChild(textarea);
      }
    }
  }

  function wireOptionHandlersIn(parentEl, answers, prefix) {
    var allOptions = parentEl.querySelectorAll('.q-option[data-question]');
    for (var i = 0; i < allOptions.length; i++) {
      allOptions[i].addEventListener('click', function () {
        var question = this.getAttribute('data-question');
        var value = this.getAttribute('data-value');
        var parentWrap = this.closest('[data-multiselect]');
        var isMultiSelect = !!parentWrap;

        if (isMultiSelect) {
          this.classList.toggle('selected');
          var arr = answers[question];
          if (!Array.isArray(arr)) { arr = []; answers[question] = arr; }
          var idx = arr.indexOf(value);
          if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
          var otherArea = document.getElementById(prefix + '-other-area-' + question);
          if (otherArea) {
            if (arr.indexOf('other') >= 0) {
              otherArea.classList.add('visible');
              var otherTextEl = document.getElementById(prefix + '-other-text-' + question);
              if (otherTextEl) otherTextEl.focus();
            } else {
              otherArea.classList.remove('visible');
              answers[question + '_customText'] = '';
            }
          }
        } else {
          var siblings = this.parentElement.querySelectorAll('.q-option[data-question="' + question + '"]');
          for (var j = 0; j < siblings.length; j++) siblings[j].classList.remove('selected');
          this.classList.add('selected');
          answers[question] = value;
        }
      });
    }
  }

  function wireRangeHandlersFor(pages, answers, prefix) {
    for (var p = 0; p < pages.length; p++) {
      var sections = pages[p].sections;
      for (var s = 0; s < sections.length; s++) {
        if (sections[s].type === 'range') {
          var key = sections[s].key;
          var rangeEl = document.getElementById(prefix + '-range-' + key);
          if (rangeEl) {
            (function (k) {
              rangeEl.addEventListener('input', function () {
                answers[k] = parseInt(this.value, 10);
              });
            })(key);
          }
        }
      }
    }
  }

  function prefillAnswersIn(parentEl, answers, prefix) {
    var allOptions = parentEl.querySelectorAll('.q-option[data-question]');
    for (var i = 0; i < allOptions.length; i++) {
      var opt = allOptions[i];
      var question = opt.getAttribute('data-question');
      var value = opt.getAttribute('data-value');
      var answer = answers[question];
      if (Array.isArray(answer)) {
        opt.classList.toggle('selected', answer.indexOf(value) >= 0);
      } else {
        opt.classList.toggle('selected', answer === value);
      }
    }
  }

  function validatePage(page, answers, prefix) {
    if (!page) return true;
    for (var s = 0; s < page.sections.length; s++) {
      var sec = page.sections[s];
      if (sec.type === 'multi-select') {
        if (s === 0 && (!Array.isArray(answers[sec.key]) || answers[sec.key].length === 0)) return false;
        if (Array.isArray(answers[sec.key]) && answers[sec.key].indexOf('other') >= 0) {
          var otherText = document.getElementById(prefix + '-other-text-' + sec.key);
          if (otherText) {
            var val = otherText.value.trim();
            if (!val) { otherText.focus(); return false; }
            answers[sec.key + '_customText'] = val;
          }
        }
      } else if (sec.type === 'range') {
        var rangeEl = document.getElementById(prefix + '-range-' + sec.key);
        if (rangeEl) answers[sec.key] = parseInt(rangeEl.value, 10);
      }
    }
    return true;
  }

  function captureTextareas(page, answers, prefix) {
    if (!page) return;
    for (var s = 0; s < page.sections.length; s++) {
      var sec = page.sections[s];
      if (sec.type === 'textarea') {
        var ta = document.getElementById(prefix + '-textarea-' + sec.key);
        if (ta) answers[sec.key] = ta.value.trim();
      }
    }
  }
});
