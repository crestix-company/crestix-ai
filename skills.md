# CRESTIX AI OS | Skills Registry

## 1. Purpose

This file is the project-level registry for Skills used by `crestix-ai`.
The source of truth for FS E1 sales logic is the individual `SKILL.md` file below.

```text
skills/
└─ fs/
   └─ medical-fs-e1-complete/
      └─ SKILL.md
```

Do not duplicate the full sales logic into application code or this registry.

---

## 2. Active Skills

### medical-fs-e1-complete

```yaml
id: medical-fs-e1-complete
name: Medical FS E1 Complete
version: 1.0.0
status: active
language: ja
category:
  - sales
  - medical
  - fs
  - e1
source: skills/fs/medical-fs-e1-complete/SKILL.md
```

Purpose:
- FS E1 preparation
- article-present / article-absent classification
- OUT / objection classification
- clinic-specific E1 script generation
- E1 branching
- E2 preparation

The master Skill follows the principle:

> 事前準備は細かく。商談はシンプルに。

---

## 3. Runtime Modes

The application must use the same master Skill through three execution modes.
The master `SKILL.md` remains the single source of truth.

### PREPARATION

Trigger:
- A qualifying FS meeting is detected from Google Calendar.

Uses:
- input information rules
- preparation rules
- preparation FMT
- article classification
- OUT_HEAVY classification
- proposed product logic
- facts / hypotheses / needs-confirmation rules

Expected output:

```text
facts
hypotheses
needsConfirmation
clinicSummary
currentMeasures
medicalServices
doctor
area
competitors
seo
meo
portals
salesHypotheses
proposalCandidates
objections
recommendedResponses
mustAsk
withdrawalConditions
keyPoints
articleType
outHeavy
firstProposal
fallbackProposal
screensToOpen
```

### PRE_MEETING_SCRIPT

Trigger:
- PREPARATION has completed successfully.

Uses:
- ARTICLE_A / ARTICLE_B flows
- screen-sharing rules
- E1 fixed flow
- OUT responses
- switching rules
- E2 transition conditions

Expected output:

```text
articleType
meetingConclusion
screensToOpen
e1Script
anticipatedOuts
switchingRules
e2Conditions
e2Preparation
```

### LIVE_COPILOT

Trigger:
- FS user explicitly presses `商談を開始する`.

Do not send the whole Skill on every utterance.
At session start, load and cache the runtime rules required for live assistance.

Runtime rules to extract from the master Skill:
- E1 fixed flow
- OUT handling
- product switching rules
- prohibited behaviors
- E1 completion / internal judgment rules

Per-turn context should contain only what is required:

```text
preparationResult
runtimeRules
currentMeetingState
conversationSummary
recentFinalTranscriptSegments
```

Expected output:

```text
customerUnderstanding
nextQuestion
recommendedReply
proposalCandidates
currentPhase
objection
missingInformation
```

---

## 4. Skill Versioning

Every Skill load must:

1. Read the source file.
2. Calculate a SHA-256 content hash.
3. Check `skills` / `skill_versions` in Supabase.
4. Create a new immutable `skill_versions` row when the content hash changes.
5. Store the exact `skill_version_id` on every preparation / agent run / meeting session that uses it.

Never overwrite old Skill versions.

Required DB linkage:

```text
meeting_preparations.skill_version_id
agent_runs.skill_version_id
meeting_sessions.skill_version_id (add if not yet present)
```

---

## 5. Source-of-Truth Rules

The following are mandatory:

- `skills/fs/medical-fs-e1-complete/SKILL.md` is the source of truth for current FS E1 sales logic.
- Do not copy the full Skill into prompts scattered across source files.
- Do not silently summarize, rewrite, optimize or correct sales logic.
- Do not create separate competing preparation and talk Skills by copying sections of the master Skill.
- Application code may parse, select and execute only the relevant sections for each runtime mode.
- Any intentional Skill change must update the Skill file itself and create a new Skill version.

---

## 6. Safety / Factuality Rules Inherited from the Skill

The application must preserve the Skill's distinction between:

```text
FACT
HYPOTHESIS
NEEDS_CONFIRMATION
CONFIRMED_IN_MEETING
```

Do not assert unverified items as facts, including but not limited to:
- SEO ranking
- MEO ranking
- PV
- paid/free status
- contract status
- historical visit status
- article existence
- available listing slots
- historical listing circumstances

Unknown values must be shown as `要確認` or `要実測` where applicable.

---

## 7. Application Integration

Recommended repository structure:

```text
crestix-ai/
├─ skills.md
├─ skills/
│  └─ fs/
│     └─ medical-fs-e1-complete/
│        └─ SKILL.md
├─ lib/
│  └─ skills/
│     ├─ loader.ts
│     ├─ registry.ts
│     ├─ versioning.ts
│     ├─ parser.ts
│     └─ runtime.ts
└─ ...
```

Recommended TypeScript interface:

```ts
export type SkillExecutionMode =
  | 'PREPARATION'
  | 'PRE_MEETING_SCRIPT'
  | 'LIVE_COPILOT'

export interface LoadedSkill {
  id: string
  name: string
  version: string
  status: 'active' | 'inactive'
  sourcePath: string
  content: string
  contentHash: string
}
```

---

## 8. Claude Code Rules

Claude Code must read this file and the individual `SKILL.md` before implementing FS AI behavior.

It must not:
- invent missing sales rules
- edit Skill content without explicit instruction
- hard-code Skill content into UI components
- expose the full Skill to the browser if it contains internal-only guidance
- store API keys or Google refresh tokens in Skill files

It must:
- preserve Skill version traceability
- test parsing and runtime-mode extraction
- make the UI reflect the Skill's intended flow
- keep the master Skill independently editable from application code

---

## 9. Current Registry

```yaml
skills:
  - id: medical-fs-e1-complete
    source: skills/fs/medical-fs-e1-complete/SKILL.md
    version: 1.0.0
    status: active
    modes:
      - PREPARATION
      - PRE_MEETING_SCRIPT
      - LIVE_COPILOT
```
