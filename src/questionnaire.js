/**
 * questionnaire.js
 * Portility — Questionnaire logic and answer-to-instruction mapping.
 *
 * Generates a markdown instruction packet from questionnaire answers.
 * All question definitions and instruction mappings live in questions-config.js.
 */

'use strict';

/**
 * Strip third-person verb suffix so custom text reads as an imperative instruction.
 * "Provides great detail" → "Provide great detail"
 * @param {string} text
 * @returns {string}
 */
function deconjugateVerb(text) {
  var firstSpace = text.indexOf(' ');
  var firstWord = firstSpace > 0 ? text.substring(0, firstSpace) : text;
  var rest = firstSpace > 0 ? text.substring(firstSpace) : '';
  var lower = firstWord.toLowerCase();

  if (lower.endsWith('ies') && lower.length > 4) {
    firstWord = firstWord.substring(0, firstWord.length - 3) + 'y';
  } else if (lower.endsWith('es') && (lower.endsWith('shes') || lower.endsWith('ches') || lower.endsWith('sses') || lower.endsWith('xes') || lower.endsWith('zes'))) {
    firstWord = firstWord.substring(0, firstWord.length - 2);
  } else if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
    firstWord = firstWord.substring(0, firstWord.length - 1);
  }

  return firstWord.charAt(0).toUpperCase() + firstWord.substring(1).toLowerCase() + rest;
}

/**
 * Build instruction map for a config section: value → instruction string.
 * Includes legacy mappings if present.
 */
function buildInstructionMap(section) {
  var map = {};
  if (section.options) {
    for (var i = 0; i < section.options.length; i++) {
      var opt = section.options[i];
      if (opt.instruction) {
        map[opt.value] = opt.instruction;
      }
    }
  }
  if (section.legacyInstructions) {
    var keys = Object.keys(section.legacyInstructions);
    for (var j = 0; j < keys.length; j++) {
      map[keys[j]] = section.legacyInstructions[keys[j]];
    }
  }
  return map;
}

/**
 * Generate operating instructions text from questionnaire answers.
 * Reads all mappings from QUESTIONNAIRE_CONFIG.
 * @param {Object} answers
 * @returns {string}
 */
function generateInstructions(answers) {
  var instructions = [];
  var pages = QUESTIONNAIRE_CONFIG.pages;

  for (var p = 0; p < pages.length; p++) {
    var sections = pages[p].sections;
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      var key = section.key;
      var answer = answers[key];

      if (section.type === 'multi-select') {
        // Normalize legacy string → array
        if (typeof answer === 'string' && answer) { answer = [answer]; }
        if (!Array.isArray(answer) || answer.length === 0) continue;

        var map = buildInstructionMap(section);
        var parts = [];
        for (var i = 0; i < answer.length; i++) {
          if ((answer[i] === 'other' || answer[i] === 'custom_text') && answers[key + '_customText']) {
            var raw = answers[key + '_customText'].trim();
            if (raw) {
              if (section.negateCustomText) {
                var lowerRaw = raw.toLowerCase();
                if (!lowerRaw.startsWith("don't") && !lowerRaw.startsWith('do not') && !lowerRaw.startsWith('never') && !lowerRaw.startsWith('stop')) {
                  var deconj = deconjugateVerb(raw);
                  raw = "Don't " + deconj.charAt(0).toLowerCase() + deconj.substring(1);
                }
              } else {
                raw = deconjugateVerb(raw);
              }
              parts.push(raw);
            }
          } else if (map[answer[i]]) {
            parts.push(map[answer[i]]);
          }
        }
        if (parts.length > 0) {
          instructions.push(parts.join(' '));
        }

      } else if (section.type === 'single-select-chips') {
        if (!answer) continue;
        var chipMap = buildInstructionMap(section);
        if (chipMap[answer]) {
          instructions.push(chipMap[answer]);
        }

      } else if (section.type === 'range') {
        if (answer && section.instructionMap && section.instructionMap[answer]) {
          instructions.push(section.instructionMap[answer]);
        }

      } else if (section.type === 'textarea') {
        if (answer && answer.trim()) {
          var prefix = section.instructionPrefix || '';
          instructions.push(prefix + answer.trim());
        }
      }
    }
  }

  // Hidden fields (confidentiality, multimodal, etc.)
  if (QUESTIONNAIRE_CONFIG.hiddenFields) {
    var hiddenKeys = Object.keys(QUESTIONNAIRE_CONFIG.hiddenFields);
    for (var h = 0; h < hiddenKeys.length; h++) {
      var hKey = hiddenKeys[h];
      var hVal = answers[hKey];
      var hMap = QUESTIONNAIRE_CONFIG.hiddenFields[hKey].instructionMap;
      if (hVal && hMap && hMap[hVal]) {
        instructions.push(hMap[hVal]);
      }
    }
  }

  // Legacy handler: old "whatNotToDo" answers from before consolidation.
  // The section was removed from config, so the normal loop won't process it.
  if (answers.whatNotToDo) {
    var legacyWNTD = answers.whatNotToDo;
    if (typeof legacyWNTD === 'string') { legacyWNTD = [legacyWNTD]; }
    if (Array.isArray(legacyWNTD) && legacyWNTD.length > 0) {
      var wntdMap = {
        'elaborate':   "Don't elaborate on my ideas without being asked.",
        'assumptions': "Don't make assumptions about what I mean.",
        'clarifying':  "Don't ask clarifying questions before answering \u2014 just answer.",
        'formal':      "Don't be overly formal or robotic.",
        'interrupts':  "Don't interrupt my train of thought.",
      };
      var wntdParts = [];
      for (var w = 0; w < legacyWNTD.length; w++) {
        if ((legacyWNTD[w] === 'other' || legacyWNTD[w] === 'custom_text') && answers.whatNotToDo_customText) {
          var wRaw = answers.whatNotToDo_customText.trim();
          if (wRaw) { wntdParts.push(wRaw); }
        } else if (wntdMap[legacyWNTD[w]]) {
          wntdParts.push(wntdMap[legacyWNTD[w]]);
        }
      }
      if (wntdParts.length > 0) {
        instructions.push(wntdParts.join(' '));
      }
    }
  }

  return instructions.join('\n\n');
}

/**
 * Build a pithy confirmation prompt based on the sycophancy level.
 * Tells the AI to respond in-character so the user knows it absorbed the instructions.
 * @param {number|null} sycophancy
 * @returns {string}
 */
function buildConfirmationPrompt(sycophancy) {
  var level = parseInt(sycophancy, 10) || 3;

  // Pull examples from config if available
  var examples = {};
  var pages = QUESTIONNAIRE_CONFIG.pages;
  for (var p = 0; p < pages.length; p++) {
    var sections = pages[p].sections;
    for (var s = 0; s < sections.length; s++) {
      if (sections[s].key === 'sycophancy' && sections[s].confirmationExamples) {
        examples = sections[s].confirmationExamples;
        break;
      }
    }
  }

  // Fallback if not in config
  if (!examples[3]) {
    examples = {
      1: 'For example, you might open with something like: "Ready to be unimpressed. Let\'s go."',
      2: 'For example, you might open with something like: "No sugarcoating. Hit me with what you\'ve got."',
      3: 'For example, you might open with something like: "Got it. Let\'s get to work."',
      4: 'For example, you might open with something like: "Love the energy. Let\'s build something great."',
      5: 'For example, you might open with something like: "Ready to absorb your brilliance. Let\'s go."',
    };
  }

  var base = (typeof PORT_ME_PROMPTS !== 'undefined' && PORT_ME_PROMPTS.confirmationPrompt)
    ? PORT_ME_PROMPTS.confirmationPrompt
    : "When you first respond, confirm you've read these instructions by replying in the tone and style described above. Keep it to one short sentence \u2014 make it pithy. ";
  return base + (examples[level] || examples[3]);
}

/**
 * Build the full instruction packet with a header.
 * @param {Object} answers
 * @returns {string}
 */
function buildInstructionPacket(answers) {
  var header = (typeof PORT_ME_PROMPTS !== 'undefined' && PORT_ME_PROMPTS.header)
    ? PORT_ME_PROMPTS.header
    : '# My Operating Instructions\n\nThese are my standing instructions for how I like to work with AI. Please follow them throughout our conversation.\n\n---\n\n';
  var body = generateInstructions(answers);
  var confirmation = '\n\n---\n\n' + buildConfirmationPrompt(answers.sycophancy);
  return header + body + confirmation;
}
