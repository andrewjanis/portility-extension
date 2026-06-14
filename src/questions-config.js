/**
 * questions-config.js
 * Portility — Single source of truth for questionnaire questions,
 * options, and answer-to-instruction mappings.
 *
 * Edit this file to add, remove, or change questions.
 * No other files need to be touched.
 */

'use strict';

var QUESTIONNAIRE_CONFIG = {
  pages: [
    {
      id: 'q-page1',
      sections: [
        {
          key: 'communicationStyle',
          title: 'How should your AI communicate?',
          type: 'multi-select',
          options: [
            { value: 'direct', label: 'Direct and concise', instruction: 'Keep responses concise and to the point.' },
            { value: 'detailed', label: 'Detailed and thorough', instruction: 'Provide thorough, detailed explanations.' },
            { value: 'conversational', label: 'Conversational and friendly', instruction: 'Use a warm, conversational tone.' },
            { value: 'no-elaborate', label: "Don't elaborate without asking", instruction: "Don't elaborate on my ideas without being asked." },
            { value: 'no-assumptions', label: "Don't make assumptions", instruction: "Don't make assumptions about what I mean." },
            { value: 'no-clarifying', label: "Don't ask clarifying questions", instruction: "Don't ask clarifying questions before answering \u2014 just answer." },
            { value: 'no-formal', label: "Don't be overly formal", instruction: "Don't be overly formal or robotic." },
            { value: 'no-interrupts', label: "Don't interrupt my thinking", instruction: "Don't interrupt my train of thought." },
            { value: 'other', label: 'Other (open text)', customTextPlaceholder: 'Describe your preference...' },
          ],
          // Legacy value mappings (kept for backward compat with old saved answers)
          legacyInstructions: {
            'short-direct': 'Deliver information concisely. Provide detail only when explicitly requested.',
            'bullets': 'Organize information with bullet points and clear sections.',
            'full': 'Provide comprehensive explanations with full context.',
            'mix': 'Adapt communication style to the context. Default to concise, expand when needed.',
          },
        },
        {
          key: 'primaryUseCase',
          title: 'What do you mainly use AI for?',
          type: 'multi-select',
          options: [
            { value: 'writing', label: 'Writing & editing', instruction: 'Help me write, edit, and refine text.' },
            { value: 'coding', label: 'Coding & development', instruction: 'Help me write, review, and debug code.' },
            { value: 'research', label: 'Research & analysis', instruction: 'Help me research topics and analyse information.' },
            { value: 'brainstorming', label: 'Brainstorming & ideation', instruction: 'Help me brainstorm ideas and think creatively.' },
            { value: 'decisions', label: 'Decision-making', instruction: 'Help me weigh options and make better decisions.' },
            { value: 'planning', label: 'Planning & organising', instruction: 'Help me plan projects and organise tasks.' },
            { value: 'other', label: 'Other (open text)', customTextPlaceholder: 'Describe your use case...' },
          ],
        },
        {
          key: 'expertiseLevel',
          title: 'Your general expertise level',
          type: 'single-select-chips',
          options: [
            { value: 'novice', label: 'Novice', instruction: 'Explain things simply and avoid jargon. I\'m still learning.' },
            { value: 'intermediate', label: 'Intermediate', instruction: 'I have a working knowledge — skip the basics but explain advanced concepts.' },
            { value: 'expert', label: 'Expert', instruction: 'I\'m experienced — be technical and skip introductory explanations.' },
            { value: 'depends', label: 'It depends', instruction: 'My expertise varies by topic. Ask or adapt based on context.' },
          ],
        },
        {
          key: 'convStyle',
          title: 'Conv Style',
          type: 'single-select-chips',
          options: [
            { value: 'casual', label: 'Casual', instruction: 'Keep the conversation casual and relaxed.' },
            { value: 'formal', label: 'Formal', instruction: 'Maintain a professional and formal tone.' },
            { value: 'robotic', label: 'Robotic', instruction: 'Be precise and systematic. Skip pleasantries and emotional language.' },
          ],
        },
        {
          key: 'taskInitiation',
          title: 'When you give AI a task, it should...',
          type: 'single-select-chips',
          options: [
            { value: 'dive-in', label: 'Dive right in', instruction: 'Start working on the task immediately without asking preliminary questions.' },
            { value: 'one-question', label: 'Ask one key question', instruction: 'Ask at most one clarifying question before starting, then get to work.' },
            { value: 'confirm', label: 'Confirm the plan first', instruction: 'Outline your approach and confirm it with me before starting.' },
          ],
        },
        {
          key: 'outputFormat',
          title: 'Preferred output formats',
          type: 'multi-select',
          options: [
            { value: 'prose', label: 'Prose / paragraphs', instruction: 'Default to writing in flowing prose and paragraphs.' },
            { value: 'bullets', label: 'Bullet points', instruction: 'Use bullet points to organise information clearly.' },
            { value: 'numbered', label: 'Numbered lists', instruction: 'Use numbered lists for sequential or ranked information.' },
            { value: 'tables', label: 'Tables', instruction: 'Use tables when comparing options or presenting structured data.' },
            { value: 'code', label: 'Code blocks', instruction: 'Use code blocks and technical formatting when relevant.' },
            { value: 'mixed', label: 'Mix it up', instruction: 'Vary the format based on what fits the content best.' },
          ],
        },
        {
          key: 'sycophancy',
          title: 'Sycophancy Level',
          subtitle: 'How do you want your AI to respond to your ideas?',
          type: 'range',
          min: 1,
          max: 5,
          default: 3,
          labels: ['Brutal Critique', 'Tough Love', 'Neutral', 'Cheerleader', 'Hardcore Glazing'],
          instructionMap: {
            1: 'Be brutally honest. Challenge my ideas and point out flaws without softening the message.',
            2: 'Be direct and honest. Push back when you disagree but keep it constructive.',
            3: "Be balanced. Acknowledge good ideas but don't hesitate to point out issues.",
            4: "Be encouraging. Lead with what's working before suggesting improvements.",
            5: 'Be enthusiastically supportive. Hype up my ideas and focus on the positive.',
          },
          confirmationExamples: {
            1: 'For example, you might open with something like: "Ready to be unimpressed. Let\'s go."',
            2: 'For example, you might open with something like: "No sugarcoating. Hit me with what you\'ve got."',
            3: 'For example, you might open with something like: "Got it. Let\'s get to work."',
            4: 'For example, you might open with something like: "Love the energy. Let\'s build something great."',
            5: 'For example, you might open with something like: "Ready to absorb your brilliance. Let\'s go."',
          },
        },
      ],
    },
    {
      id: 'q-page2',
      sections: [
        {
          key: 'otherPreferences',
          title: 'Anything else?',
          type: 'textarea',
          placeholder: "e.g. 'Always use metric units' / 'I'm not a native English speaker, keep language simple' / 'I'm colourblind — avoid red/green comparisons'",
          instructionPrefix: 'Additional instruction: ',
        },
      ],
    },
  ],

  // Hidden fields — not rendered in the UI, but kept in answers for
  // backward compat and potential future use.
  hiddenFields: {
    confidentiality: {
      instructionMap: {
        'private': "I'm working on confidential projects. Never reference my work, ideas, or concepts in other conversations or contexts. Keep all confidential material isolated and private.",
        'contexts': 'Some of my work is confidential. Ask me to clarify which topics are private before discussing them in other contexts.',
      },
    },
    multimodal: {
      instructionMap: {
        'text': 'Expect text-based input. Respond in clear, written text format.',
        'voice': 'I often dictate. Be prepared for voice input and respond in a format suitable for reading aloud or transcription.',
        'documents': 'I frequently upload files, documents, and images. Be prepared to analyze and respond to visual and document-based input.',
        'all': 'I work multimodally \u2014 I may dictate, paste text, upload documents, or send images. Be prepared to handle any input format. Also be ready to output in any format I request: text, voice transcripts, structured documents, images, or visual presentations.',
      },
    },
  },
};
