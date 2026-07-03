# Portility Feature Documentation

## Table of Contents
1. [Port My Profile — Questionnaire System](#port-my-profile--questionnaire-system)
2. [Second Opinion — Scoring & Comparison](#second-opinion--scoring--comparison)

---

# Port My Profile — Questionnaire System

## Overview

Two-tiered questionnaire system:
1. **Operating Instructions Questionnaire** (free tier) — Single questionnaire for general AI preferences
2. **Port My Profile Pro** (paid tier) — Multiple profile-based questionnaires (Work, Home, Hobby, Custom)

Users answer questions, which are converted into formatted instruction packets for use with other AI platforms.

## File Structure

| File | Purpose |
|------|---------|
| `questions-config.js` | Question definitions for operating instructions questionnaire |
| `profiles-config.js` | Profile types, icons, colours, profile-specific questionnaire configs |
| `questionnaire.js` | Converting questionnaire answers → instruction text |
| `profiles-prompts.js` | Profile-type-specific instruction headers |
| `port-me-prompts.js` | Instruction packet headers and confirmation prompts |
| `profiles-firestore.js` | Firestore CRUD for profile storage |
| `popup.js` | UI rendering, event handlers, questionnaire flow control |

## Storage

- **Local** (`chrome.storage.local`): `questionnaire_answers`, `questionnaire_completed`, `portility_pending_paste`
- **Firestore** (`users/{uid}/portme_profiles/{profileId}`): Profile metadata + AES-256-GCM encrypted answers

---

## Part 1: Operating Instructions Questionnaire (Free)

### Complete Question List

#### Page 1

**"Things I Like about my AI"** (key: `communicationStyle`, type: `multi-select`)
| Value | Label | Instruction |
|-------|-------|-------------|
| `direct` | Direct and concise | Keep responses concise and to the point. |
| `detailed` | Detailed and thorough | Provide thorough, detailed explanations. |
| `conversational` | Conversational and friendly | Use a warm, conversational tone. |
| `other` | Other (open text) | Custom text input |

Legacy mappings (backward compat):
| Value | Instruction |
|-------|-------------|
| `short-direct` | Deliver information concisely. Provide detail only when explicitly requested. |
| `bullets` | Organize information with bullet points and clear sections. |
| `full` | Provide comprehensive explanations with full context. |
| `mix` | Adapt communication style to the context. Default to concise, expand when needed. |

**"Things I don't like about my AI"** (key: `whatNotToDo`, type: `multi-select`, `negateCustomText: true`)
| Value | Label | Instruction |
|-------|-------|-------------|
| `elaborate` | Elaborates without being asked | Don't elaborate on my ideas without being asked. |
| `assumptions` | Makes assumptions | Don't make assumptions about what I mean. |
| `clarifying` | Asks clarifying questions | Don't ask clarifying questions before answering — just answer. |
| `formal` | Overly formal or robotic | Don't be overly formal or robotic. |
| `interrupts` | Interrupts my thinking | Don't interrupt my train of thought. |
| `other` | Other (open text) | Custom text with auto "Don't" prefix |

**"Conv Style"** (key: `convStyle`, type: `single-select-chips`)
| Value | Label | Instruction |
|-------|-------|-------------|
| `casual` | Casual | Keep the conversation casual and relaxed. |
| `formal` | Formal | Maintain a professional and formal tone. |
| `robotic` | Robotic | Be precise and systematic. Skip pleasantries and emotional language. |

**"Sycophancy Level"** (key: `sycophancy`, type: `range` 1-5, default: 3)
| Value | Label | Instruction | Confirmation Example |
|-------|-------|-------------|---------------------|
| 1 | Brutal Critique | Be brutally honest. Challenge my ideas and point out flaws without softening the message. | "Ready to be unimpressed. Let's go." |
| 2 | Tough Love | Be direct and honest. Push back when you disagree but keep it constructive. | "No sugarcoating. Hit me with what you've got." |
| 3 | Neutral | Be balanced. Acknowledge good ideas but don't hesitate to point out issues. | "Got it. Let's get to work." |
| 4 | Cheerleader | Be encouraging. Lead with what's working before suggesting improvements. | "Love the energy. Let's build something great." |
| 5 | Hardcore Glazing | Be enthusiastically supportive. Hype up my ideas and focus on the positive. | "Ready to absorb your brilliance. Let's go." |

#### Page 2

**"Anything else?"** (key: `otherPreferences`, type: `textarea`)
- Placeholder: "Type here, or leave blank..."
- Instruction prefix: "Additional instruction: "

#### Hidden Fields (not rendered, included in answers)

**"Confidentiality"** (key: `confidentiality`)
| Value | Instruction |
|-------|-------------|
| `private` | I'm working on confidential projects. Never reference my work, ideas, or concepts in other conversations or contexts. Keep all confidential material isolated and private. |
| `contexts` | Some of my work is confidential. Ask me to clarify which topics are private before discussing them in other contexts. |

**"Multimodal"** (key: `multimodal`)
| Value | Instruction |
|-------|-------------|
| `text` | Expect text-based input. Respond in clear, written text format. |
| `voice` | I often dictate. Be prepared for voice input and respond in a format suitable for reading aloud or transcription. |
| `documents` | I frequently upload files, documents, and images. Be prepared to analyze and respond to visual and document-based input. |
| `all` | I work multimodally — I may dictate, paste text, upload documents, or send images. Be prepared to handle any input format. Also be ready to output in any format I request: text, voice transcripts, structured documents, images, or visual presentations. |

---

### Instruction Packet Assembly

**Header** (`PORT_ME_PROMPTS.header`):
```
# My Operating Instructions

These are my standing instructions for how I like to work with AI.
Please follow them throughout our conversation.

---

```

**Body**: Generated from answers — each selected option maps to its instruction text. Multi-selects join with spaces. Range maps to instruction. Textareas get prefix.

**Confirmation Prompt** (`PORT_ME_PROMPTS.confirmationPrompt`):
```
When you first respond, confirm you've read these instructions by replying in the
tone and style described above. Keep it to one short sentence — make it pithy.
```
Plus sycophancy-level example.

**Final format**:
```
{HEADER}
{BODY}

---

{CONFIRMATION_PROMPT} {CONFIRMATION_EXAMPLE}
```

---

## Part 2: Port My Profile Pro (Paid Tier)

### Profile Types
| Type | Icon | Colour |
|------|------|--------|
| work | ti-briefcase | Teal (index 0) |
| home | ti-home | Green (index 6) |
| hobby | ti-palette | Purple (index 2) |
| other | ti-star | Orange (index 4) |

8 colour options, 17 icon options (16 Tabler icons + Portility logo).

### WORK Profile Questions

**Page 1:**

**"What do you use AI for at work?"** (key: `workUseCase`, multi-select)
| Value | Label | Instruction |
|-------|-------|-------------|
| `coding` | Code & development | Help me write, review, and debug code. |
| `writing` | Writing & emails | Help me draft professional emails, documents, and communications. |
| `research` | Research & analysis | Help me research topics and analyse data for work. |
| `meetings` | Meeting prep & notes | Help me prepare for meetings and summarise key points. |
| `strategy` | Strategy & planning | Help me think through strategy, plans, and decision-making. |
| `other` | Other (open text) | Custom |

**"Your work tone"** (key: `workTone`, single-select-chips)
| Value | Label | Instruction |
|-------|-------|-------------|
| `professional` | Professional | Maintain a professional and polished tone for work contexts. |
| `casual` | Casual | Keep a casual, approachable tone even in work contexts. |
| `technical` | Technical | Use precise technical language and skip unnecessary pleasantries. |

**Page 2:**
- **"Describe your role or industry"** (key: `workRole`, textarea, prefix: "My role/industry: ")
- **"Any specific tools or frameworks?"** (key: `workTools`, textarea, prefix: "I primarily work with: ")

### HOME Profile Questions

**Page 1:**

**"What do you use AI for at home?"** (key: `homeUseCase`, multi-select)
| Value | Label | Instruction |
|-------|-------|-------------|
| `cooking` | Cooking & recipes | Help me with meal planning, recipes, and cooking tips. |
| `planning` | Planning & organising | Help me organise my schedule, to-dos, and household tasks. |
| `learning` | Learning new things | Help me learn and explore new topics for personal growth. |
| `health` | Health & wellness | Help me with health, fitness, and wellness guidance. |
| `creative` | Creative projects | Help me with creative projects and personal hobbies. |
| `other` | Other (open text) | Custom |

**"Home conversation style"** (key: `homeTone`, single-select-chips)
| Value | Label | Instruction |
|-------|-------|-------------|
| `relaxed` | Relaxed | Keep things relaxed and laid-back for home conversations. |
| `encouraging` | Encouraging | Be encouraging and supportive in home-related conversations. |
| `efficient` | Efficient | Keep home conversations efficient and to the point. |

**Page 2:**
- **"Anything specific about your home life?"** (key: `homeContext`, textarea, prefix: "Home context: ")

### HOBBY Profile Questions

**Page 1:**

**"What hobbies do you use AI for?"** (key: `hobbyUseCase`, multi-select)
| Value | Label | Instruction |
|-------|-------|-------------|
| `gaming` | Gaming | Help me with gaming strategies, tips, and discussions. |
| `music` | Music | Help me with music creation, theory, and discovery. |
| `art` | Art & design | Help me with art, design, and visual creativity. |
| `writing` | Creative writing | Help me with creative writing, stories, and worldbuilding. |
| `fitness` | Fitness & sports | Help me with workout plans, sports techniques, and fitness goals. |
| `other` | Other (open text) | Custom |

**"How should AI help with hobbies?"** (key: `hobbyStyle`, single-select-chips)
| Value | Label | Instruction |
|-------|-------|-------------|
| `teach` | Teach me | Act as a patient teacher helping me learn and improve. |
| `collaborate` | Collaborate | Collaborate with me as a creative partner. |
| `chat` | Just chat | Keep it conversational and fun — no pressure. |

**Page 2:**
- **"Tell us about your hobbies"** (key: `hobbyDetails`, textarea, prefix: "My hobbies: ")

### OTHER (Custom) Profile Questions

**Page 1:**

**"What will you use this profile for?"** (key: `otherUseCase`, multi-select)
| Value | Label | Instruction |
|-------|-------|-------------|
| `sideproject` | Side project | Help me with my side project — flexible and creative. |
| `volunteer` | Volunteering | Help me with volunteer work and community projects. |
| `learning` | Learning | Help me learn new skills and explore subjects. |
| `travel` | Travel | Help me plan trips, find destinations, and navigate travel logistics. |
| `social` | Social & events | Help me plan social events, gifts, and gatherings. |
| `other` | Other (open text) | Custom |

**"Tone for this profile"** (key: `otherTone`, single-select-chips)
| Value | Label | Instruction |
|-------|-------|-------------|
| `casual` | Casual | Keep the tone casual and easy-going. |
| `formal` | Formal | Maintain a more formal, structured tone. |
| `creative` | Creative | Be creative, playful, and open to experimentation. |

**Page 2:**
- **"Describe what this profile is for"** (key: `otherContext`, textarea, prefix: "Profile context: ")

### Profile Instruction Headers

```
# My Work Profile — Operating Instructions
These are my standing instructions for how I want AI to assist me in a work context.
Please follow them throughout our conversation.
```
(Same pattern for Home, Hobby, Custom with type-specific wording.)

### Profile Flow

1. User clicks "+ New Profile" → profile type selection (Work/Home/Hobby/Other)
2. Page 1: multi-select use cases + tone chips
3. Page 2: textareas for context details
4. Customization: icon grid (17 options), colour swatches (8), profile name (max 30 chars)
5. Save & Port: encrypts answers, saves to Firestore, generates instruction packet, ports to destination

### Firestore Operations
- **Save**: AES-256-GCM encrypt answers (passphrase = Firebase UID), PATCH to Firestore
- **List**: Fetch all profiles, decrypt, sort by lastUsed descending
- **Delete**: DELETE request to Firestore
- **Set Default**: Update isDefault across all profiles
- **Migration**: One-time migration from legacy flat structure to profiles subcollection

---

# Second Opinion — Scoring & Comparison

## Overview

Extracts a conversation from the current AI platform, gets an independent analysis from a *different* AI model, then runs a comparison scoring algorithm to produce an agreement score, agreements list, divergences list, and interpretation.

## Flow

### Step 1: Platform Detection
- Checks active tab URL: `chatgpt.com` → ChatGPT, `gemini.google.com` → Gemini, `claude.ai` → Claude

### Step 2: Extract Conversation
- Sends `{ type: 'EXTRACT_PRO' }` to content script
- Gets full conversation text + any captured images/assets

### Step 3: Smart Summarization Decision
- If text < 12,000 chars: skip summarization, send raw text
- If text >= 12,000 chars: call `/summarize-pro` in **parallel** with second opinion request

### Step 4: Get Second Opinion
**Endpoint**: `POST /second-opinion`

**Platform → Comparison Model Pairing:**
| Source Platform | Second Opinion Model |
|----------------|---------------------|
| ChatGPT | Claude Sonnet 4.6 (Anthropic API) |
| Claude | GPT-4o (OpenAI API) |
| Gemini | GPT-4o (OpenAI API) |

**System Prompt:**
```
You are reviewing a project brief generated from a conversation on a
different AI platform. Analyze independently: soundness of conclusions,
risks/gaps/blind spots, alternative approaches, priority assessment.
```

**Brief Processing:**
- Max 180,000 characters
- If longer: keeps first 40% + last 40%, drops middle with `[... middle of brief truncated for length ...]`

**Images**: Sent as base64 (Anthropic) or URLs (OpenAI) if present.

### Step 5: Compare & Score
**Endpoint**: `POST /compare`

**Input**: `{ original: artifact, secondOpinion: soData.text }`

**Comparison System Prompt:**
```
You are a neutral evaluator comparing two AI responses to the same question.
Judge only on substantive content — accuracy, completeness, and logical consistency.
Do not consider tone, style, or formatting.
Return JSON only — no preamble, no markdown, no explanation outside the JSON object.
```

**Required JSON Output:**
```json
{
  "question_type": "factual" | "subjective" | "analytical",
  "agreement_score": <integer 0-100>,
  "agreements": [
    {"title": "<2-5 word noun phrase>", "text": "<description>"}
  ],
  "divergences": [
    {"title": "<2-5 word noun phrase>", "text": "<description>"}
  ],
  "interpretation": "<one sentence: what the score means given the question type>"
}
```

**Title rules**: Must be specific, descriptive noun phrases (2-5 words). e.g. "Error page design approach", "Budget constraints". NEVER use generic phrases like "Both responses", "Key insight", "Main point".

---

## Scoring Calibration by Question Type

### FACTUAL (e.g., "Age requirements for House vs Senate")
- Score based on whether both responses state the **same facts**
- Core facts match → **90-100**
- Facts contradict → score accordingly

### ANALYTICAL (e.g., "Medical chest pain diagnostic approach")
- **Critical distinction**: TOPIC overlap ≠ POSITION overlap
- Both discussing same topic does NOT = agreement
- Must reach same **conclusion** with compatible reasoning

| Score | Meaning |
|-------|---------|
| 90-100 | Same conclusion with compatible supporting evidence (rare) |
| 70-89 | Similar conclusions, different evidence/frameworks (DEFAULT for competent analysis) |
| 50-69 | Different angles/frameworks, compatible but non-identical conclusions |
| 30-49 | Different conclusions or fundamentally different priorities |
| 0-29 | Direct contradiction |

**Special guidance**: Be skeptical of high-level synthesis — similar-sounding summaries often mask genuinely different analyses. Check whether frameworks lead to same **actionable conclusions**, not just similar sound.

**Calibration example**: "Quantum computing impact on cybersecurity" — AI initially scored 60 but models focused on fundamentally different technical factors. Correct score: **54**.

### SUBJECTIVE (e.g., "Unreliable narration effectiveness")
- Same sentiment using different words → credit as agreement
- Do not penalize stylistic differences on opinion-based content
- Same position with compatible reasoning → **85-100**

---

## Visual Display

### Dial/Gauge
- SVG arc with gradient: Red (#fa000c) → Yellow (#FFD348) → Green (#41f531)
- Needle rotation: `-120°` (0%) to `+120°` (100%), formula: `svgRot = -120 + (score / 100) * 240`
- Animation: `0.9s cubic-bezier(0.34, 1.2, 0.64, 1)`
- Score counter: 900ms ease-out animated count-up

### Score Zones
| Score | Label | Color |
|-------|-------|-------|
| 0-33 | Significant disagreement | #fa000c (Red) |
| 34-66 | Partial overlap | #FFD348 (Yellow) |
| 67-100 | Strong agreement | #41f531 (Green) |

### Question Type Badges
| Type | Background | Text | Border |
|------|-----------|------|--------|
| Factual | #E6F1FB | #185FA5 | #B5D4F4 |
| Subjective | #EEEDFE | #534AB7 | #CECBF6 |
| Analytical | #E1F5EE | #0F6E56 | #9FE1CB |

### Loading State
- Needle sweeps back and forth (10s cycles, triangle wave)
- Score counter follows needle position
- Gauge opacity: 0.15 (grayed out)
- Lists and interpretation hidden

### Results Lists
- **Agreements**: Green border (#C0DD97), title + text + extracted quotes from both briefs
- **Divergences**: Red border (#F7C1C1), title + text + extracted quotes from both briefs

### Quote Extraction Algorithm (`soFindQuotes`)
1. Extract keywords from topic title (words > 3 chars)
2. Split brief into sentences (on `.!?\n`, min 10 chars)
3. Return first sentence with any keyword match
4. Truncate to 120 chars max

---

## Comparison Page (Full View)

Opens in separate tab (`comparison.html` + `comparison.js`).

- Score with colour coding
- Up to 5 theme rows combining agreements + divergences
- Each row: topic title, type badge ("Agree" green / "Differ" red), description, quotes from each AI
- Likert rating (1-5) sent to `POST /feedback`

## Model Labels (Display)
| Internal | Display |
|----------|---------|
| `chatgpt` | GPT-4o |
| `claude` | Claude Sonnet 4.6 |

## Data Persistence
- **In-memory**: `_soResultData`, `_soCurrentScore`, `_soSweepFrame`
- **Chrome storage**: `so_cached_result` (5-min TTL, invalidated on tab navigation)
- **History**: Persisted via `saveSOComparison()` for review
