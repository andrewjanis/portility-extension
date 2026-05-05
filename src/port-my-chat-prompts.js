/**
 * port-my-chat-prompts.js
 * Portility — Editable prompt text for the "Port My Chat" button.
 *
 * This text is prepended to the extracted conversation when it is
 * ported to another AI platform.
 *
 * Edit freely — no other files need to change.
 */

'use strict';

var PORT_MY_CHAT_PROMPTS = {
  // Prepended before the conversation messages.
  // Tells the destination AI how to treat the incoming conversation.
  header: "The following is a previous conversation from another AI assistant. Treat it as shared context. In your first response, briefly confirm what you understand the conversation to be about, then propose the most logical next step and ask the user if they'd like to proceed with that or go in a different direction.\n\n---\n\n",
};
