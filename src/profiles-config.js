/**
 * profiles-config.js
 * Portility — Profile questionnaire config, colours, icons, and constants.
 *
 * Each profile type (work/home/hobby/other) has its own 2-page questionnaire.
 * Page 1: multi-select + single-select-chips questions
 * Page 2: textarea questions
 */

'use strict';

var MAX_PROFILES = 5; // Pro default
var MAX_PROFILES_PREMIUM = Infinity;
var MAX_PROFILE_NAME_LENGTH = 30;

function getMaxProfiles(tier) {
  if (tier === 'paid2' || tier === 'paid3') return MAX_PROFILES_PREMIUM;
  return MAX_PROFILES; // Pro (paid) and fallback
}

// ─── Colour swatches ─────────────────────────────────────────────────────────
// Each swatch: { swatch (border/accent), bg (badge background), icon (icon colour) }
var PROFILE_COLOURS = [
  { swatch: '#14B8A6', bg: '#F0FDFA', icon: '#0D9488' },   // Teal (brand)
  { swatch: '#3B82F6', bg: '#EFF6FF', icon: '#2563EB' },   // Blue
  { swatch: '#8B5CF6', bg: '#F5F3FF', icon: '#7C3AED' },   // Purple
  { swatch: '#EC4899', bg: '#FDF2F8', icon: '#DB2777' },   // Pink
  { swatch: '#F97316', bg: '#FFF7ED', icon: '#EA580C' },   // Orange
  { swatch: '#EAB308', bg: '#FEFCE8', icon: '#CA8A04' },   // Amber
  { swatch: '#22C55E', bg: '#F0FDF4', icon: '#16A34A' },   // Green
  { swatch: '#64748B', bg: '#F8FAFC', icon: '#475569' },   // Slate
];

// ─── Icon set ────────────────────────────────────────────────────────────────
// 16 Tabler icon class names + 'portility' for the brand logo
var PROFILE_ICONS = [
  'ti-briefcase',
  'ti-home',
  'ti-palette',
  'ti-code',
  'ti-book',
  'ti-music',
  'ti-camera',
  'ti-coffee',
  'ti-rocket',
  'ti-bulb',
  'ti-heart',
  'ti-star',
  'ti-plant-2',
  'ti-chart-bar',
  'ti-message',
  'ti-world',
  'portility',
];

// ─── Default icon + colour per profile type ──────────────────────────────────
var PROFILE_TYPE_DEFAULTS = {
  work:  { icon: 'ti-briefcase', colourIndex: 0 },
  home:  { icon: 'ti-home',      colourIndex: 6 },
  hobby: { icon: 'ti-palette',   colourIndex: 2 },
  other: { icon: 'ti-star',      colourIndex: 4 },
};

// ─── Profile questionnaire config ────────────────────────────────────────────
// Keyed by profile type. Each type has 2 pages.
// Uses the same section types as QUESTIONNAIRE_CONFIG: multi-select,
// single-select-chips, textarea.

var PROFILE_QUESTIONNAIRE_CONFIG = {
  work: {
    pages: [
      {
        id: 'pq-page1',
        sections: [
          {
            key: 'workUseCase',
            title: 'What do you use AI for at work?',
            type: 'multi-select',
            options: [
              { value: 'coding',     label: 'Code & development',     instruction: 'Help me write, review, and debug code.' },
              { value: 'writing',    label: 'Writing & emails',       instruction: 'Help me draft professional emails, documents, and communications.' },
              { value: 'research',   label: 'Research & analysis',    instruction: 'Help me research topics and analyse data for work.' },
              { value: 'meetings',   label: 'Meeting prep & notes',   instruction: 'Help me prepare for meetings and summarise key points.' },
              { value: 'strategy',   label: 'Strategy & planning',    instruction: 'Help me think through strategy, plans, and decision-making.' },
              { value: 'other',      label: 'Other (open text)',      customTextPlaceholder: 'Describe your work use case...' },
            ],
          },
          {
            key: 'workTone',
            title: 'Your work tone',
            type: 'single-select-chips',
            options: [
              { value: 'professional', label: 'Professional',  instruction: 'Maintain a professional and polished tone for work contexts.' },
              { value: 'casual',       label: 'Casual',        instruction: 'Keep a casual, approachable tone even in work contexts.' },
              { value: 'technical',    label: 'Technical',     instruction: 'Use precise technical language and skip unnecessary pleasantries.' },
            ],
          },
        ],
      },
      {
        id: 'pq-page2',
        sections: [
          {
            key: 'workRole',
            title: 'Describe your role or industry',
            type: 'textarea',
            placeholder: 'e.g. "Software engineer at a fintech startup" or "Marketing manager in healthcare"',
            instructionPrefix: 'My role/industry: ',
          },
          {
            key: 'workTools',
            title: 'Any specific tools or frameworks?',
            type: 'textarea',
            placeholder: 'e.g. "React, TypeScript, AWS" or "Salesforce, HubSpot"',
            instructionPrefix: 'I primarily work with: ',
          },
        ],
      },
    ],
  },

  home: {
    pages: [
      {
        id: 'pq-page1',
        sections: [
          {
            key: 'homeUseCase',
            title: 'What do you use AI for at home?',
            type: 'multi-select',
            options: [
              { value: 'cooking',   label: 'Cooking & recipes',      instruction: 'Help me with meal planning, recipes, and cooking tips.' },
              { value: 'planning',  label: 'Planning & organising',  instruction: 'Help me organise my schedule, to-dos, and household tasks.' },
              { value: 'learning',  label: 'Learning new things',    instruction: 'Help me learn and explore new topics for personal growth.' },
              { value: 'health',    label: 'Health & wellness',      instruction: 'Help me with health, fitness, and wellness guidance.' },
              { value: 'creative',  label: 'Creative projects',      instruction: 'Help me with creative projects and personal hobbies.' },
              { value: 'other',     label: 'Other (open text)',      customTextPlaceholder: 'Describe your home use case...' },
            ],
          },
          {
            key: 'homeTone',
            title: 'Home conversation style',
            type: 'single-select-chips',
            options: [
              { value: 'relaxed',      label: 'Relaxed',      instruction: 'Keep things relaxed and laid-back for home conversations.' },
              { value: 'encouraging',  label: 'Encouraging',  instruction: 'Be encouraging and supportive in home-related conversations.' },
              { value: 'efficient',    label: 'Efficient',    instruction: 'Keep home conversations efficient and to the point.' },
            ],
          },
        ],
      },
      {
        id: 'pq-page2',
        sections: [
          {
            key: 'homeContext',
            title: 'Anything specific about your home life?',
            type: 'textarea',
            placeholder: 'e.g. "Family of four, vegetarian household" or "Living alone, trying to eat healthier"',
            instructionPrefix: 'Home context: ',
          },
        ],
      },
    ],
  },

  hobby: {
    pages: [
      {
        id: 'pq-page1',
        sections: [
          {
            key: 'hobbyUseCase',
            title: 'What hobbies do you use AI for?',
            type: 'multi-select',
            options: [
              { value: 'gaming',       label: 'Gaming',            instruction: 'Help me with gaming strategies, tips, and discussions.' },
              { value: 'music',        label: 'Music',             instruction: 'Help me with music creation, theory, and discovery.' },
              { value: 'art',          label: 'Art & design',      instruction: 'Help me with art, design, and visual creativity.' },
              { value: 'writing',      label: 'Creative writing',  instruction: 'Help me with creative writing, stories, and worldbuilding.' },
              { value: 'fitness',      label: 'Fitness & sports',  instruction: 'Help me with workout plans, sports techniques, and fitness goals.' },
              { value: 'other',        label: 'Other (open text)', customTextPlaceholder: 'Describe your hobby...' },
            ],
          },
          {
            key: 'hobbyStyle',
            title: 'How should AI help with hobbies?',
            type: 'single-select-chips',
            options: [
              { value: 'teach',       label: 'Teach me',     instruction: 'Act as a patient teacher helping me learn and improve.' },
              { value: 'collaborate', label: 'Collaborate',   instruction: 'Collaborate with me as a creative partner.' },
              { value: 'chat',        label: 'Just chat',     instruction: 'Keep it conversational and fun — no pressure.' },
            ],
          },
        ],
      },
      {
        id: 'pq-page2',
        sections: [
          {
            key: 'hobbyDetails',
            title: 'Tell us about your hobbies',
            type: 'textarea',
            placeholder: 'e.g. "I play guitar and want help with chord progressions" or "I\'m training for a half marathon"',
            instructionPrefix: 'My hobbies: ',
          },
        ],
      },
    ],
  },

  other: {
    pages: [
      {
        id: 'pq-page1',
        sections: [
          {
            key: 'otherUseCase',
            title: 'What will you use this profile for?',
            type: 'multi-select',
            options: [
              { value: 'sideproject', label: 'Side project',       instruction: 'Help me with my side project — flexible and creative.' },
              { value: 'volunteer',   label: 'Volunteering',       instruction: 'Help me with volunteer work and community projects.' },
              { value: 'learning',    label: 'Learning',           instruction: 'Help me learn new skills and explore subjects.' },
              { value: 'travel',      label: 'Travel',             instruction: 'Help me plan trips, find destinations, and navigate travel logistics.' },
              { value: 'social',      label: 'Social & events',    instruction: 'Help me plan social events, gifts, and gatherings.' },
              { value: 'other',       label: 'Other (open text)',  customTextPlaceholder: 'Describe your use case...' },
            ],
          },
          {
            key: 'otherTone',
            title: 'Tone for this profile',
            type: 'single-select-chips',
            options: [
              { value: 'casual',   label: 'Casual',    instruction: 'Keep the tone casual and easy-going.' },
              { value: 'formal',   label: 'Formal',    instruction: 'Maintain a more formal, structured tone.' },
              { value: 'creative', label: 'Creative',  instruction: 'Be creative, playful, and open to experimentation.' },
            ],
          },
        ],
      },
      {
        id: 'pq-page2',
        sections: [
          {
            key: 'otherContext',
            title: 'Describe what this profile is for',
            type: 'textarea',
            placeholder: 'e.g. "Planning a community garden" or "Learning Japanese for a trip next year"',
            instructionPrefix: 'Profile context: ',
          },
        ],
      },
    ],
  },
};
