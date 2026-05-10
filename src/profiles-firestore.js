/**
 * profiles-firestore.js
 * Portility — Firestore CRUD for portme_profiles subcollection.
 *
 * Collection path: users/{firebaseUid}/portme_profiles/{profileId}
 * Answers are encrypted client-side using the same AES-256-GCM scheme as
 * the legacy operating instructions.
 */

'use strict';

var PROFILES_PROJECT_ID = 'portility';

/**
 * Generate a unique profile ID: timestamp + random hex.
 * @returns {string}
 */
function generateProfileId() {
  var ts = Date.now().toString(36);
  var rand = Math.random().toString(36).substring(2, 8);
  return ts + '_' + rand;
}

/**
 * Build the Firestore base URL for the profiles subcollection.
 * @param {string} firebaseUid
 * @returns {string}
 */
function _profilesBaseUrl(firebaseUid) {
  return 'https://firestore.googleapis.com/v1/projects/' + PROFILES_PROJECT_ID +
    '/databases/(default)/documents/users/' + firebaseUid + '/portme_profiles';
}

/**
 * Save (create or update) a profile to Firestore.
 * Encrypts the answers JSON before storing.
 *
 * @param {Object} profile - { id, name, type, icon, colourIndex, answers, isDefault, lastUsed }
 * @param {string} passphrase - encryption key (auth.userId)
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid - Firebase UID
 * @returns {Promise<void>}
 */
async function saveProfileToFirestore(profile, passphrase, idToken, firebaseUid) {
  var encryptedResult = await encryptInstructions(JSON.stringify(profile.answers), passphrase);
  var now = new Date().toISOString();

  var url = _profilesBaseUrl(firebaseUid) + '/' + profile.id;

  var fields = {
    profileId:    { stringValue: profile.id },
    name:         { stringValue: profile.name },
    type:         { stringValue: profile.type },
    icon:         { stringValue: profile.icon },
    colourIndex:  { integerValue: String(profile.colourIndex) },
    encryptedAnswers: { stringValue: encryptedResult.encrypted },
    salt:         { stringValue: encryptedResult.salt },
    iv:           { stringValue: encryptedResult.iv },
    isDefault:    { booleanValue: !!profile.isDefault },
    lastUsed:     { timestampValue: profile.lastUsed || now },
    createdAt:    { timestampValue: profile.createdAt || now },
    lastUpdated:  { timestampValue: now },
  };

  // Store document if present
  if (profile.document && profile.document.name) {
    fields.documentName = { stringValue: profile.document.name };
    fields.documentContent = { stringValue: profile.document.content || '' };
  }

  var response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + idToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: fields }),
  });

  if (!response.ok) {
    var err = await response.json().catch(function () { return {}; });
    throw new Error(err.error?.message || 'Failed to save profile to Firestore');
  }
}

/**
 * List all profiles from Firestore, decrypting each profile's answers.
 *
 * @param {string} passphrase
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<Array<Object>>} Array of profile objects
 */
async function listProfilesFromFirestore(passphrase, idToken, firebaseUid) {
  var url = _profilesBaseUrl(firebaseUid);

  var response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (response.status === 404) return [];

  if (!response.ok) {
    throw new Error('Failed to list profiles from Firestore');
  }

  var data = await response.json();
  if (!data.documents || data.documents.length === 0) return [];

  var profiles = [];
  for (var i = 0; i < data.documents.length; i++) {
    var doc = data.documents[i];
    var f = doc.fields;
    if (!f) continue;

    var profile = {
      id:           f.profileId?.stringValue || '',
      name:         f.name?.stringValue || '',
      type:         f.type?.stringValue || 'other',
      icon:         f.icon?.stringValue || 'ti-star',
      colourIndex:  parseInt(f.colourIndex?.integerValue || '0', 10),
      isDefault:    f.isDefault?.booleanValue || false,
      lastUsed:     f.lastUsed?.timestampValue || null,
      createdAt:    f.createdAt?.timestampValue || null,
      lastUpdated:  f.lastUpdated?.timestampValue || null,
      answers:      null,
      document:     null,
    };

    // Read attached document
    if (f.documentName?.stringValue) {
      profile.document = {
        name: f.documentName.stringValue,
        content: f.documentContent?.stringValue || '',
      };
    }

    // Decrypt answers
    if (f.encryptedAnswers?.stringValue && f.salt?.stringValue && f.iv?.stringValue) {
      try {
        var decrypted = await decryptInstructions(
          { encrypted: f.encryptedAnswers.stringValue, salt: f.salt.stringValue, iv: f.iv.stringValue },
          passphrase
        );
        profile.answers = JSON.parse(decrypted);
      } catch (e) {
        console.log('[Profiles] Failed to decrypt profile:', profile.id, e.message);
        profile.answers = null;
      }
    }

    profiles.push(profile);
  }

  // Sort by lastUsed descending (most recently used first)
  profiles.sort(function (a, b) {
    var aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    var bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return bTime - aTime;
  });

  // Ensure only one profile is marked as default (first default found wins)
  var foundDefault = false;
  for (var k = 0; k < profiles.length; k++) {
    if (profiles[k].isDefault) {
      if (foundDefault) {
        profiles[k].isDefault = false;
      } else {
        foundDefault = true;
      }
    }
  }

  return profiles;
}

/**
 * Get a single profile from Firestore.
 *
 * @param {string} profileId
 * @param {string} passphrase
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<Object|null>}
 */
async function getProfileFromFirestore(profileId, passphrase, idToken, firebaseUid) {
  var url = _profilesBaseUrl(firebaseUid) + '/' + profileId;

  var response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error('Failed to get profile from Firestore');
  }

  var doc = await response.json();
  var f = doc.fields;
  if (!f) return null;

  var profile = {
    id:           f.profileId?.stringValue || profileId,
    name:         f.name?.stringValue || '',
    type:         f.type?.stringValue || 'other',
    icon:         f.icon?.stringValue || 'ti-star',
    colourIndex:  parseInt(f.colourIndex?.integerValue || '0', 10),
    isDefault:    f.isDefault?.booleanValue || false,
    lastUsed:     f.lastUsed?.timestampValue || null,
    createdAt:    f.createdAt?.timestampValue || null,
    lastUpdated:  f.lastUpdated?.timestampValue || null,
    answers:      null,
  };

  if (f.encryptedAnswers?.stringValue && f.salt?.stringValue && f.iv?.stringValue) {
    try {
      var decrypted = await decryptInstructions(
        { encrypted: f.encryptedAnswers.stringValue, salt: f.salt.stringValue, iv: f.iv.stringValue },
        passphrase
      );
      profile.answers = JSON.parse(decrypted);
    } catch (e) {
      console.log('[Profiles] Failed to decrypt profile:', profileId, e.message);
    }
  }

  return profile;
}

/**
 * Delete a profile from Firestore.
 *
 * @param {string} profileId
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<void>}
 */
async function deleteProfileFromFirestore(profileId, idToken, firebaseUid) {
  var url = _profilesBaseUrl(firebaseUid) + '/' + profileId;

  var response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to delete profile from Firestore');
  }
}

/**
 * Update a profile's lastUsed timestamp.
 *
 * @param {string} profileId
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<void>}
 */
async function updateProfileLastUsed(profileId, idToken, firebaseUid) {
  var url = _profilesBaseUrl(firebaseUid) + '/' + profileId +
    '?updateMask.fieldPaths=lastUsed';

  var response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + idToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        lastUsed: { timestampValue: new Date().toISOString() },
      },
    }),
  });

  if (!response.ok) {
    console.log('[Profiles] Failed to update lastUsed for:', profileId);
  }
}

/**
 * Set a profile as the default. Clears isDefault on all other profiles.
 *
 * @param {string} profileId - the profile to set as default
 * @param {string} passphrase
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<void>}
 */
async function setDefaultProfile(profileId, passphrase, idToken, firebaseUid) {
  // List all profiles to find which ones to update
  var profiles = await listProfilesFromFirestore(passphrase, idToken, firebaseUid);

  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    var shouldBeDefault = p.id === profileId;

    if (p.isDefault !== shouldBeDefault) {
      var url = _profilesBaseUrl(firebaseUid) + '/' + p.id +
        '?updateMask.fieldPaths=isDefault';

      await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + idToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            isDefault: { booleanValue: shouldBeDefault },
          },
        }),
      });
    }
  }
}

/**
 * One-time migration: copies legacy user_operating_instructions/{uid}
 * to the portme_profiles subcollection as the user's first profile.
 * Sets a chrome.storage.local flag to prevent repeat migration.
 *
 * @param {string} passphrase - encryption key (auth.userId)
 * @param {string} idToken
 * @param {string} firebaseUid
 * @returns {Promise<boolean>} true if migration happened, false if skipped
 */
async function migrateLegacyProfile(passphrase, idToken, firebaseUid) {
  // Check if already migrated
  var migrated = await new Promise(function (resolve) {
    chrome.storage.local.get('portme_profiles_migrated', function (data) {
      resolve(!!data.portme_profiles_migrated);
    });
  });
  if (migrated) return false;

  // Check if there are already profiles in the subcollection
  var existing = await listProfilesFromFirestore(passphrase, idToken, firebaseUid);
  if (existing.length > 0) {
    await new Promise(function (resolve) {
      chrome.storage.local.set({ portme_profiles_migrated: true }, resolve);
    });
    return false;
  }

  // Get legacy instructions
  var legacyData = await getInstructionsFromFirestore(idToken, firebaseUid);
  if (!legacyData || !legacyData.answers) {
    // No legacy data to migrate — still mark as done
    await new Promise(function (resolve) {
      chrome.storage.local.set({ portme_profiles_migrated: true }, resolve);
    });
    return false;
  }

  // Create a profile from the legacy data
  var profileId = generateProfileId();
  var defaults = PROFILE_TYPE_DEFAULTS.work;
  var now = new Date().toISOString();

  var profile = {
    id: profileId,
    name: 'My Profile',
    type: 'work',
    icon: defaults.icon,
    colourIndex: defaults.colourIndex,
    answers: legacyData.answers,
    isDefault: true,
    lastUsed: now,
    createdAt: now,
  };

  await saveProfileToFirestore(profile, passphrase, idToken, firebaseUid);

  await new Promise(function (resolve) {
    chrome.storage.local.set({ portme_profiles_migrated: true }, resolve);
  });

  return true;
}
