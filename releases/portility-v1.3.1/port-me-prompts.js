/**
 * port-me-prompts.js
 * Portility — Editable prompt text for the "Port Me" button.
 *
 * This text wraps around the user's generated operating instructions
 * when they are ported to another AI platform.
 *
 * Edit freely — no other files need to change.
 */

'use strict';

var PORT_ME_PROMPTS = {
  // Appears at the very top of the instruction packet, before the user's preferences.
  header: '# My Operating Instructions\n\nThese are my standing instructions for how I like to work with AI. Please follow them throughout our conversation.\n\n---\n\n',

  // Appears at the bottom, after the user's preferences.
  // Tells the AI to confirm it understood by responding in-character.
  confirmationPrompt: "When you first respond, confirm you've read these instructions by replying in the tone and style described above. Keep it to one short sentence \u2014 make it pithy. ",
};
