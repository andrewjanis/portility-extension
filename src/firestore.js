/**
 * firestore.js
 * Portility — Firestore REST API operations for operating instructions.
 *
 * Stores encrypted instruction blobs in Firestore, keyed by Firebase UID.
 * All encryption/decryption happens client-side before data touches the network.
 */

'use strict';

var FIRESTORE_PROJECT_ID = 'portility';

/**
 * Save encrypted instructions to Firestore.
 * @param {string} instructionsText - Plain text instructions (will be encrypted)
 * @param {string} passphrase
 * @param {string} idToken - Firebase ID token (from ensureAuthenticated().idToken)
 * @param {string} firebaseUid - Firebase UID (from ensureAuthenticated().firebaseUid)
 * @param {Object} answers - Raw questionnaire answers (stored encrypted alongside instructions)
 * @returns {Promise<void>}
 */
async function saveInstructionsToFirestore(instructionsText, passphrase, idToken, firebaseUid, answers) {
  var encryptedResult = await encryptInstructions(instructionsText, passphrase);

  var url = 'https://firestore.googleapis.com/v1/projects/' + FIRESTORE_PROJECT_ID +
    '/databases/(default)/documents/user_operating_instructions/' + firebaseUid;

  var now = new Date().toISOString();

  var response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + idToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        firebaseUid: { stringValue: firebaseUid },
        encryptedInstructions: { stringValue: encryptedResult.encrypted },
        salt: { stringValue: encryptedResult.salt },
        iv: { stringValue: encryptedResult.iv },
        answers: { stringValue: JSON.stringify(answers) },
        createdAt: { timestampValue: now },
        lastUpdated: { timestampValue: now },
        questionnaiireCompleted: { booleanValue: true },
      },
    }),
  });

  if (!response.ok) {
    var err = await response.json().catch(function () { return {}; });
    throw new Error(err.error?.message || 'Failed to save to Firestore');
  }
}

/**
 * Retrieve encrypted instructions from Firestore.
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid - Firebase UID
 * @returns {Promise<{encrypted: string, salt: string, iv: string, answers: Object|null, questionnaiireCompleted: boolean}|null>}
 */
async function getInstructionsFromFirestore(idToken, firebaseUid) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + FIRESTORE_PROJECT_ID +
    '/databases/(default)/documents/user_operating_instructions/' + firebaseUid;

  var response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + idToken },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error('Failed to retrieve instructions from Firestore');
  }

  var doc = await response.json();
  if (!doc.fields) return null;

  var result = {
    encrypted: doc.fields.encryptedInstructions?.stringValue || '',
    salt: doc.fields.salt?.stringValue || '',
    iv: doc.fields.iv?.stringValue || '',
    answers: null,
    questionnaiireCompleted: doc.fields.questionnaiireCompleted?.booleanValue || false,
  };

  if (doc.fields.answers?.stringValue) {
    try {
      result.answers = JSON.parse(doc.fields.answers.stringValue);
    } catch (e) {
      result.answers = null;
    }
  }

  return result;
}

/**
 * Check if questionnaire has been completed (via Firestore).
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid - Firebase UID
 * @returns {Promise<boolean>}
 */
/**
 * Read the user's subscription tier from Firestore.
 * @param {string} idToken - Firebase ID token
 * @param {string} firebaseUid - Firebase UID
 * @returns {Promise<string>} 'free' or 'paid'
 */
async function getUserTier(idToken, firebaseUid) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + FIRESTORE_PROJECT_ID +
    '/databases/(default)/documents/users/' + firebaseUid + '?mask.fieldPaths=tier';

  try {
    var response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + idToken },
    });

    // 404 = user document doesn't exist yet (equivalent of !doc.exists())
    if (response.status === 404) {
      console.log('[Firestore] User document not found, defaulting to free');
      return 'free';
    }

    if (!response.ok) {
      console.error('[Firestore] Error fetching user data:', response.status);
      return 'free';
    }

    var doc = await response.json();

    // Check document has fields (equivalent of doc.exists() + doc.data())
    if (!doc.fields) {
      console.log('[Firestore] User document exists but has no fields, defaulting to free');
      return 'free';
    }

    // equivalent of doc.data()?.tier || 'free'
    var tier = (doc.fields.tier && doc.fields.tier.stringValue) || 'free';
    console.log('[Firestore] User tier:', tier);
    return tier;
  } catch (error) {
    console.error('[Firestore] Error fetching user data:', error);
    return 'free';
  }
}

async function checkQuestionnaireCompletedRemote(idToken, firebaseUid) {
  try {
    var data = await getInstructionsFromFirestore(idToken, firebaseUid);
    return data ? data.questionnaiireCompleted : false;
  } catch (e) {
    return false;
  }
}
