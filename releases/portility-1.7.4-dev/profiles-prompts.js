/**
 * profiles-prompts.js
 * Portility — Profile-type-specific instruction headers and confirmation prompt.
 *
 * Same pattern as port-me-prompts.js. Each profile type gets a contextual header
 * that wraps the user's generated instructions when ported to another AI platform.
 *
 * Edit freely — no other files need to change.
 */

'use strict';

var PROFILE_PROMPTS = {
  // Type-specific headers prepended before the profile instructions
  headers: {
    work: '# My Work Profile — Operating Instructions\n\nThese are my standing instructions for how I want AI to assist me in a work context. Please follow them throughout our conversation.\n\n---\n\n',
    home: '# My Home Profile — Operating Instructions\n\nThese are my standing instructions for how I want AI to assist me at home. Please follow them throughout our conversation.\n\n---\n\n',
    hobby: '# My Hobby Profile — Operating Instructions\n\nThese are my standing instructions for how I want AI to assist me with my hobbies. Please follow them throughout our conversation.\n\n---\n\n',
    other: '# My Custom Profile — Operating Instructions\n\nThese are my standing instructions for how I want AI to assist me. Please follow them throughout our conversation.\n\n---\n\n',
  },

  // Fallback header if type is unknown
  defaultHeader: '# My Profile — Operating Instructions\n\nThese are my standing instructions for how I want AI to assist me. Please follow them throughout our conversation.\n\n---\n\n',

  // Confirmation prompt appended at the bottom (same across all types)
  confirmationPrompt: "When you first respond, confirm you've read these instructions by replying in the tone and style described above. Keep it to one short sentence — make it pithy. ",
};
