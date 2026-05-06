/**
 * oauth.js
 * Portility — Google OAuth via chrome.identity.launchWebAuthFlow.
 *
 * Requests a Google ID token directly and exchanges it for a Firebase ID token.
 */

'use strict';

var OAUTH_CLIENT_ID = '542250387353-k1uu29l3844ct0404i83nboe011btbvc.apps.googleusercontent.com';
var FIREBASE_API_KEY = 'AIzaSyDyULt7zllm2OfOJeCGNh92ZitSWJu-ua4';

/**
 * Generate a random nonce string (required for id_token requests).
 */
function generateNonce() {
  var array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/**
 * Launch Google OAuth flow and return both access_token and id_token.
 * @returns {Promise<{accessToken: string, idToken: string}>}
 */
async function launchGoogleAuthFlow() {
  var redirectUrl = chrome.identity.getRedirectURL();
  var nonce = generateNonce();

  var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + encodeURIComponent(OAUTH_CLIENT_ID) +
    '&response_type=token%20id_token' +
    '&redirect_uri=' + encodeURIComponent(redirectUrl) +
    '&scope=' + encodeURIComponent('openid profile email') +
    '&nonce=' + nonce +
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
          reject(new Error('No response from auth flow'));
          return;
        }

        var accessTokenMatch = responseUrl.match(/access_token=([^&]*)/);
        var idTokenMatch = responseUrl.match(/id_token=([^&]*)/);

        if (!accessTokenMatch || !idTokenMatch) {
          reject(new Error('Missing tokens in auth response'));
          return;
        }

        resolve({
          accessToken: accessTokenMatch[1],
          idToken: idTokenMatch[1],
        });
      }
    );
  });
}

/**
 * Exchange a Google ID token for a Firebase ID token.
 * @param {string} googleIdToken
 * @returns {Promise<{firebaseIdToken: string, firebaseUid: string}>}
 */
async function exchangeForFirebaseToken(googleIdToken) {
  var response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=' + FIREBASE_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: 'id_token=' + googleIdToken + '&providerId=google.com',
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true,
      }),
    }
  );

  if (!response.ok) {
    var err = await response.json().catch(function () { return {}; });
    throw new Error('Firebase auth failed: ' + (err.error && err.error.message ? err.error.message : 'Unknown error'));
  }

  var data = await response.json();

  return {
    firebaseIdToken: data.idToken,
    firebaseUid: data.localId,
  };
}

/**
 * Get the Google user's profile info.
 * @param {string} accessToken
 * @returns {Promise<{id: string, email: string, name: string}>}
 */
async function getGoogleUserInfo(accessToken) {
  var response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch user info');
  }

  return response.json();
}

/**
 * Ensure user is authenticated.
 * @returns {Promise<{token: string, userId: string, firebaseUid: string, idToken: string}>}
 */
async function ensureAuthenticated() {
  // Check for valid cached Firebase token first (expires in ~1 hour, we cache 55 min)
  var cached = await new Promise(function (resolve) {
    chrome.storage.local.get([
      'firebase_id_token',
      'firebase_uid',
      'firebase_token_expiry',
      'google_access_token',
      'google_user_id',
    ], function (data) { resolve(data); });
  });

  var now = Date.now();
  if (
    cached.firebase_id_token &&
    cached.firebase_token_expiry &&
    now < cached.firebase_token_expiry &&
    cached.google_access_token &&
    cached.google_user_id
  ) {
    return {
      token: cached.google_access_token,
      userId: cached.google_user_id,
      firebaseUid: cached.firebase_uid,
      idToken: cached.firebase_id_token,
    };
  }

  // Launch fresh Google auth flow
  var googleTokens = await launchGoogleAuthFlow();
  var userInfo = await getGoogleUserInfo(googleTokens.accessToken);
  var firebaseAuth = await exchangeForFirebaseToken(googleTokens.idToken);

  // Cache everything
  var expiry = now + 55 * 60 * 1000;
  await new Promise(function (resolve) {
    chrome.storage.local.set({
      google_access_token: googleTokens.accessToken,
      google_user_id: userInfo.id,
      firebase_id_token: firebaseAuth.firebaseIdToken,
      firebase_uid: firebaseAuth.firebaseUid,
      firebase_token_expiry: expiry,
    }, resolve);
  });

  return {
    token: googleTokens.accessToken,
    userId: userInfo.id,
    firebaseUid: firebaseAuth.firebaseUid,
    idToken: firebaseAuth.firebaseIdToken,
  };
}
