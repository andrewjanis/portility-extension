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
              { value: 'presentations', label: 'Presentations & decks', instruction: 'Help me create and refine presentations and slide decks.' },
              { value: 'data',       label: 'Data & spreadsheets',   instruction: 'Help me work with data, spreadsheets, and visualisations.' },
              { value: 'client-comms', label: 'Client communications', instruction: 'Help me draft client-facing communications and proposals.' },
              { value: 'other',      label: 'Other (open text)',      customTextPlaceholder: 'Describe your work use case...' },
            ],
          },
          {
            key: 'workMode',
            title: 'How should AI help you at work?',
            type: 'single-select-chips',
            options: [
              { value: 'executor',     label: 'Executor',      instruction: 'Act as an executor — do what I ask efficiently with minimal back-and-forth.' },
              { value: 'collaborator', label: 'Collaborator',  instruction: 'Act as a collaborator — think alongside me and offer suggestions.' },
              { value: 'advisor',      label: 'Advisor',       instruction: 'Act as an advisor — provide guidance and recommendations, let me execute.' },
            ],
          },
          {
            key: 'workAudience',
            title: 'Output goes to',
            type: 'single-select-chips',
            options: [
              { value: 'just-me',  label: 'Just me',   instruction: 'Work output is for my own reference — optimise for speed and clarity.' },
              { value: 'internal', label: 'Internal',   instruction: 'Work output is shared internally — keep it professional but not overly formal.' },
              { value: 'external', label: 'External',   instruction: 'Work output is client/public-facing — ensure it is polished and professional.' },
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
              { value: 'finances',  label: 'Finances & budgeting',   instruction: 'Help me with budgeting, finances, and money management.' },
              { value: 'travel',    label: 'Travel planning',        instruction: 'Help me plan trips and travel logistics.' },
              { value: 'shopping',  label: 'Shopping & research',    instruction: 'Help me research products and make purchase decisions.' },
              { value: 'parenting', label: 'Parenting & kids',       instruction: 'Help me with parenting questions, activities, and kid-related tasks.' },
              { value: 'diy',       label: 'DIY & home projects',    instruction: 'Help me with DIY projects, repairs, and home improvement.' },
              { value: 'other',     label: 'Other (open text)',      customTextPlaceholder: 'Describe your home use case...' },
            ],
          },
          {
            key: 'homeMode',
            title: 'How should AI help you at home?',
            type: 'single-select-chips',
            options: [
              { value: 'just-answer',    label: 'Just answer',     instruction: 'Give me quick, direct answers for home tasks.' },
              { value: 'think-with-me',  label: 'Think with me',   instruction: 'Help me think through home decisions and plans together.' },
              { value: 'casual-chat',    label: 'Casual chat',     instruction: 'Keep home conversations relaxed and conversational.' },
            ],
          },
          {
            key: 'householdContext',
            title: 'Your household',
            type: 'single-select-chips',
            options: [
              { value: 'solo',   label: 'Solo',    instruction: 'I live alone — tailor home advice for one person.' },
              { value: 'couple', label: 'Couple',   instruction: 'I live with a partner — consider two people in home advice.' },
              { value: 'family', label: 'Family',   instruction: 'I have a family — factor in kids and family dynamics.' },
              { value: 'shared', label: 'Shared',   instruction: 'I live with housemates — consider shared living in home advice.' },
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
            placeholder: 'e.g. "We\'re vegetarian" or "Two kids under 10" or "Renovating a 1960s house"',
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
              { value: 'photography',  label: 'Photography',       instruction: 'Help me with photography techniques, editing, and composition.' },
              { value: 'cooking',      label: 'Cooking',           instruction: 'Help me with recipes, cooking techniques, and meal ideas.' },
              { value: 'reading',      label: 'Reading',           instruction: 'Help me find books, discuss what I\'m reading, and explore genres.' },
              { value: 'gardening',    label: 'Gardening',         instruction: 'Help me with gardening plans, plant care, and outdoor projects.' },
              { value: 'travel',       label: 'Travel',            instruction: 'Help me plan trips, discover destinations, and create itineraries.' },
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
          {
            key: 'hobbySkillLevel',
            title: 'Your skill level',
            type: 'single-select-chips',
            options: [
              { value: 'beginner',     label: 'Beginner',      instruction: 'I\'m a beginner — explain things from the ground up.' },
              { value: 'intermediate', label: 'Intermediate',  instruction: 'I have some experience — skip the basics.' },
              { value: 'advanced',     label: 'Advanced',      instruction: 'I\'m advanced — go deep and challenge me.' },
              { value: 'varies',       label: 'Varies',        instruction: 'My skill level varies by hobby — adapt as needed.' },
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
            key: 'customMode',
            title: 'How should AI help with this?',
            type: 'single-select-chips',
            options: [
              { value: 'execute',     label: 'Execute',      instruction: 'Act as an executor — do what I ask efficiently.' },
              { value: 'teach',       label: 'Teach',        instruction: 'Act as a teacher — help me learn and understand.' },
              { value: 'collaborate', label: 'Collaborate',  instruction: 'Act as a collaborator — think alongside me.' },
              { value: 'casual',      label: 'Casual',       instruction: 'Keep it casual and low-pressure.' },
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
            placeholder: 'e.g. "Planning a community garden" or "Learning Japanese" or "Managing a D&D campaign"',
            instructionPrefix: 'Profile context: ',
          },
        ],
      },
    ],
  },
};
