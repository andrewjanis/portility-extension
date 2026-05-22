import globals from "globals";

/*
 * Cross-file globals used by the Chrome extension src/ scripts.
 * These are top-level declarations in one file that are consumed by
 * another file loaded on the same page (via <script> tags or importScripts).
 *
 * Marked "writable" because the defining file assigns them at the top level.
 */
const extensionGlobals = {
  // config.js
  PROXY_URL: "writable",
  GOOGLE_SHEET_WEBHOOK: "writable",

  // posthog.js
  POSTHOG_API_KEY: "writable",
  dreweryTrack: "writable",

  // port-my-chat-prompts.js
  PORT_MY_CHAT_PROMPTS: "writable",

  // remote-config.js
  PortilityConfig: "writable",
  fetchRemoteConfig: "writable",
  isConfigStale: "writable",

  // content-shared.js
  PortilityShared: "writable",

  // encryption.js
  deriveKey: "writable",
  encryptInstructions: "writable",
  decryptInstructions: "writable",

  // oauth.js
  generateNonce: "writable",
  buildAuthUrl: "writable",
  runAuthFlow: "writable",
  launchGoogleAuthFlow: "writable",
  exchangeForFirebaseToken: "writable",
  getGoogleUserInfo: "writable",
  ensureAuthenticated: "writable",

  // firestore.js
  saveInstructionsToFirestore: "writable",
  getInstructionsFromFirestore: "writable",
  getUserTier: "writable",
  checkQuestionnaireCompletedRemote: "writable",

  // indexeddb.js
  openPortilityDB: "writable",
  generateBriefId: "writable",
  saveProjectBrief: "writable",
  getProjectBrief: "writable",
  listProjectBriefs: "writable",
  generateSOComparisonId: "writable",
  saveSOComparison: "writable",
  listSOComparisons: "writable",
  pruneSOComparisons: "writable",

  // usage.js
  USAGE_TIERS: "writable",
  UPGRADE_URLS: "writable",
  USAGE_PROJECT_ID: "writable",
  useFeature: "writable",
  getCurrentUsageSummary: "writable",
  getCurrentWindowKeyLegacy: "writable",
  getUsageHistory: "writable",

  // questionnaire.js
  deconjugateVerb: "writable",
  buildInstructionMap: "writable",
  generateInstructions: "writable",
  buildConfirmationPrompt: "writable",
  buildInstructionPacket: "writable",

  // questions-config.js
  QUESTIONNAIRE_CONFIG: "writable",

  // profiles-config.js
  MAX_PROFILES: "writable",
  MAX_PROFILE_NAME_LENGTH: "writable",
  PROFILE_COLOURS: "writable",
  PROFILE_ICONS: "writable",
  PROFILE_TYPE_DEFAULTS: "writable",
  PROFILE_QUESTIONNAIRE_CONFIG: "writable",

  // profiles-prompts.js
  PROFILE_PROMPTS: "writable",

  // profiles-firestore.js
  generateProfileId: "writable",
  saveProfileToFirestore: "writable",
  listProfilesFromFirestore: "writable",
  getProfileFromFirestore: "writable",
  deleteProfileFromFirestore: "writable",
  updateProfileLastUsed: "writable",
  setDefaultProfile: "writable",
  migrateLegacyProfile: "writable",

  // port-me-prompts.js
  PORT_ME_PROMPTS: "writable",

  // utils.js
  compressImage: "writable",
};

/* Shared rule set — eslint:recommended with project tweaks */
const recommendedRules = {
  "constructor-super": "error",
  "for-direction": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-case-declarations": "error",
  "no-class-assign": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": "error",
  "no-const-assign": "error",
  "no-constant-condition": "error",
  "no-control-regex": "error",
  "no-debugger": "error",
  "no-delete-var": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty": "error",
  "no-empty-character-class": "error",
  "no-empty-pattern": "error",
  "no-ex-assign": "error",
  "no-extra-boolean-cast": "error",
  "no-fallthrough": "error",
  "no-func-assign": "error",
  "no-global-assign": "error",
  "no-import-assign": "error",
  "no-inner-declarations": "error",
  "no-invalid-regexp": "error",
  "no-irregular-whitespace": "error",
  "no-loss-of-precision": "error",
  "no-misleading-character-class": "error",
  "no-new-symbol": "error",
  "no-nonoctal-decimal-escape": "error",
  "no-obj-calls": "error",
  "no-octal": "error",
  "no-prototype-builtins": "error",
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-regex-spaces": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-shadow-restricted-names": "error",
  "no-sparse-arrays": "error",
  "no-this-before-super": "error",
  "no-undef": "error",
  "no-unexpected-multiline": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-unused-labels": "error",
  "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none" }],
  "no-useless-backreference": "error",
  "no-useless-catch": "error",
  "no-useless-escape": "error",
  "no-with": "error",
  "require-yield": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

export default [
  // ── Ignore build artifacts and dependencies ──────────────────────────
  {
    ignores: [
      "node_modules/**",
      "worker/node_modules/**",
      "release/**",
    ],
  },

  // ── Chrome extension source files ────────────────────────────────────
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        importScripts: "readonly",
        ...extensionGlobals,
      },
    },
    rules: recommendedRules,
  },

  // ── Shared / library files that only define globals for other files ──
  // Disable no-unused-vars since their exports are consumed elsewhere.
  {
    files: [
      "src/config.js",
      "src/encryption.js",
      "src/oauth.js",
      "src/firestore.js",
      "src/indexeddb.js",
      "src/usage.js",
      "src/questionnaire.js",
      "src/questions-config.js",
      "src/profiles-config.js",
      "src/profiles-prompts.js",
      "src/profiles-firestore.js",
      "src/port-me-prompts.js",
      "src/port-my-chat-prompts.js",
      "src/utils.js",
      "src/posthog.js",
      "src/remote-config.js",
      "src/content-shared.js",
    ],
    rules: {
      "no-unused-vars": "off",
    },
  },

  // ── Cloudflare Worker (ES modules) ───────────────────────────────────
  {
    files: ["worker/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
        Response: "readonly",
        Request: "readonly",
        URL: "readonly",
        Headers: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        atob: "readonly",
        btoa: "readonly",
        console: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: recommendedRules,
  },
];
