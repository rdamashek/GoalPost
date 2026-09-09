# Data Entities

All entities in GoalPost — their fields, relationships, and storage details. Database is Neo4j (graph).

> **Adding a new node label or relationship type?** Also add it to the AI Cypher
> generator's whitelist in `src/lib/cypher-generator/schema-context.ts`
> (`ALLOWED_LABELS` / `ALLOWED_RELATIONSHIPS` + `SCHEMA_DOC`), or the assistant's
> `query_for_bloom` tool can neither name nor return the new entity and will tell
> users it "couldn't find" something they can plainly see. Full checklist in
> `kb/07-ai-assistant-ux.md` Rule 9.

## Entity Relationship Overview

```
Person ──OWNS──▶ Space (MeSpace / WeSpace)
Space ──HAS_MEMBER──▶ SpaceMembership ──IS_MEMBER──▶ Person
Space ──HAS_CONTEXT──▶ FieldContext
FieldContext ──HAS_SUBCONTEXT──▶ FieldContext   (GOAL-295; nested sub-context — pure hierarchy overlay, the child ALSO keeps its own Space HAS_CONTEXT edge)
FieldContext ──HAS_PULSE──▶ FieldPulse (GoalPulse / ResourcePulse / StoryPulse / CarePulse / CoreValuePulse)
FieldContext ──HAS_RESONANCE──▶ ResonanceLink
ResonanceLink ──SOURCE──▶ FieldPulse
ResonanceLink ──TARGET──▶ FieldPulse
ResonanceLink ──RESONATES_AS──▶ FieldResonance
FieldContext ──HAS_WEAVE──▶ PromiseWeave
PromiseWeave ──WEAVES──▶ FieldPulse
PromiseWeave ──WOVEN_FOR──▶ Person
PromiseWeave ──CREATED_BY──▶ Person
FieldPulse ──INITIATED_BY──▶ Person   (canonical author edge — assistant + doc-ingest paths; CREATED_BY carries the same meaning but is written by the dashboard flow and imports. Read both, preferring INITIATED_BY — see src/lib/pulse-author.ts)
FieldContext ──HAS_ORGANIZATION──▶ Organization   (GOAL-298; parallels HAS_PERSON)
Person/Organization ──MENTIONED_IN──▶ FieldPulse   (GOAL-298; named-in / related-to, NOT authorship)
Organization ──EXTRACTED_FROM──▶ Document
FieldPulse ──HAS_CHUNK──▶ ConversationChunk
Person ──CONNECTED_TO── Person (bidirectional)
Log ──CREATED_BY──▶ Person
Log ──LOGGED_FOR──▶ FieldPulse
FieldContext ──HAS_DOCUMENT──▶ Document
Document ──UPLOADED_BY──▶ Person:User
Person/FieldPulse ──EXTRACTED_FROM──▶ Document
Document ──HAS_INGEST_THREAD──▶ ConversationThread
```

## Core Entities

### Person

**Neo4j Labels:** `["Person"]`, `["Person", "User"]`, or `["Person", "PersonPulse"]`

The `Person` node is the single entity for all humans in the system. Adjacent labels distinguish platform access:

| Label Combination           | Meaning                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `["Person"]`                | Base person — contact or imported record, not yet classified               |
| `["Person", "User"]`        | Registered platform user — can log in, owns MeSpace, creates pulses        |
| `["Person", "PersonPulse"]` | Non-user person — someone in a user's relational world, no platform access |

**`User` is a label, not a separate node.** Signup creates (or matches) a `Person` and runs `SET person:User`; auth queries (login, JWT validation, `resolveAuthenticatedUserId`) match on `:User`. A `Person` without the `:User` label cannot authenticate even if it has an `email` and `password` set. Seeded contacts and imported relational entities therefore stay non-logged-in until they're explicitly promoted by adding the label and the auth/onboarding fields below (or by going through `/api/auth/signup`).

| Field        | Type     | Notes                                  |
| ------------ | -------- | -------------------------------------- |
| id           | string   | Unique                                 |
| firstName    | string   | Required                               |
| lastName     | string   | Required                               |
| name         | string   | Computed: firstName + lastName         |
| email        | string   | Login identifier                       |
| phone        | string   | Optional                               |
| pronouns     | string   | Optional                               |
| location     | string   | Optional                               |
| photo        | string   | Avatar URL, optional                   |
| gender       | string   | Optional                               |
| status       | string   | Optional                               |
| careManual   | string   | How this person wants to be cared for  |
| favorites    | string   | Things they value                      |
| passions     | string[] | Extracted from pulses or self-reported |
| traits       | string[] | Personality traits                     |
| fieldsOfCare | string[] | Areas of care and concern              |
| interests    | string[] | Broader interests                      |
| embedding    | float[]  | 1536-dim vector for semantic search    |
| enrichedAt   | datetime | Last enrichment timestamp              |
| isUser       | boolean  | Computed — has `User` label            |
| signupDate   | datetime | When they registered                   |

**Auth fields (private):** `password`, `refreshToken`, `refreshTokenExp`, `refreshTokenRevoked`, `authId`, `inviteTokenHash`, `inviteTokenExpires`, `resetTokenHash`, `resetTokenExpires` — the two single-use token fields store sha256(rawToken); the raw token only ever lives in the outgoing email URL.

**Reading PII — go through `privateProfile` (GOAL-275).** In GraphQL, the
`Person` type exposes the open directory identity — `id`, `firstName`,
`lastName`, `name`, `photo`, `avatar`, `status` — which any authenticated user
may read so people stay findable by name across Spaces (it also still exposes
onboarding state, timestamps, and the relationship fields, each auth-filtered
by its own target type). Every PII / narrative scalar (`email`, `phone`, `pronouns`, `location`, `gender`, `description`,
`careManual`, `favorites`, `passions`, `traits`, `fieldsOfCare`, `interests`)
plus `connections` / `connectionEdges` is readable **only** through
`Person.privateProfile`, which resolves to a `PersonPrivateProfile` over the
same node behind a single type-level `@authorization` filter:

```graphql
people(where: { id_EQ: $id }) {
  id  name  photo              # always readable
  privateProfile {             # null when the caller is not authorized
    email  description  traits
  }
}
```

A caller is authorized when they are the person, created them (`CREATED_BY`),
share a Space with them, or can view a FieldContext holding them
(`HAS_PERSON`). Otherwise `privateProfile` comes back **null** — the Person row
itself still resolves, so surfaces render the directory identity rather than a
not-found. See `kb/02-user-roles.md` for the branch list.

These scalars are still ordinary node properties: writes (`updatePeople`,
`updatePersonPulse`) are unchanged, and server-side Cypher reads them directly.
Only the GraphQL read path moved. None of them is **filterable**, `email`
included — the login bootstrap that needed `email_EQ` now keys on `id_EQ`,
because the generated `email_STARTS_WITH` sibling was an account-enumeration
oracle (see `kb/02-user-roles.md`). Raw-Cypher readers get no gate at all and
must restate the branch table themselves; `person-search.tool.ts` is the worked
example. Do **not** re-add a field-level `@authorization` to `Person` for a
new sensitive field — add it to `PersonPrivateProfile` instead; the type-level
rule compiles once, while a field-level rule is re-expanded per selected field
and blew the 60 s `/api/graphql` ceiling (guarded by
`person-pii-gate-plan-size.test.ts`).

**Onboarding fields:** `onboardingCurrentStepIndex`, `onboardingCompletedSteps`, `onboardingIsCompleted`, `onboardingSkipped`

**Relationships:**

- `OWNS` → Space
- `IS_MEMBER` → SpaceMembership
- `CONNECTED_TO` ↔ Person (bidirectional, with edge metadata: `why`, `interests`). Written by the person-detail UI, the GraphQL `createPersonConnection` mutation, **and** the AI assistant: `create_connection` (direct/proactive) and `create_person` (which MERGEs a `CONNECTED_TO` from the current user to the new person whenever a `relationshipWhy` is supplied). See `kb/07-ai-assistant-ux.md` Rule 5.
- `CREATED_BY` ← FieldPulse, Log

---

### MeSpace

**Neo4j Labels:** `["Space", "MeSpace"]`

**Cardinality:** Exactly one per Person. Auto-created at signup. A Person may never own more than one MeSpace.

| Field           | Type     | Notes                                     |
| --------------- | -------- | ----------------------------------------- |
| id              | string   | Unique                                    |
| name            | string   | Required                                  |
| visibility      | enum     | PRIVATE / SHARED                          |
| ownerId         | string   | Denormalized Person.id — UNIQUE constraint |
| description     | string   | Optional                                  |
| why             | string   | Optional                                  |
| location        | string   | Optional                                  |
| time            | string   | Optional                                  |
| activities      | string   | Optional                                  |
| resultsAchieved | string   | Optional                                  |
| status          | string   | Optional                                  |
| createdAt       | datetime |                                           |

**Relationships:**

- `OWNS` ← Person (one owner, and that Person owns no other MeSpace)
- `HAS_CONTEXT` → FieldContext

**Authorization:** Only the owner can read/write (GraphQL `@authorization` filter).

**Enforcement of the one-per-Person invariant:**

1. **DB constraint** — `mespace_owner_unique` UNIQUE on `MeSpace.ownerId` (`scripts/init-db.js`).
2. **REST endpoint** — `/api/me-space/create` uses an atomic `MATCH (p) WHERE NOT EXISTS { (p)-[:OWNS]->(:MeSpace) }` Cypher (no TOCTOU).
3. **Signup** — `getOrCreateMeSpace` in `src/lib/validation/space-validation.ts` is idempotent; it returns the existing MeSpace if one is already owned.
4. **GraphQL** — the auto-generated `createMeSpaces` mutation is disabled via `@mutation(operations: [UPDATE, DELETE])`; only `updateMeSpaces` and `deleteMeSpaces` are exposed.
5. **Audit** — `auditMeSpaceConstraint(session)` reports any Persons with >1 MeSpace (use during migrations).

---

### WeSpace

**Neo4j Labels:** `["Space", "WeSpace"]`

Same fields as MeSpace.

**Relationships:**

- `OWNS` ← Person (one owner)
- `HAS_MEMBER` → SpaceMembership
- `HAS_CONTEXT` → FieldContext

**Authorization:** Owner or any member can read. Write depends on membership role.

---

### SpaceMembership

**Neo4j Labels:** `["SpaceMembership"]`

| Field   | Type     | Notes                  |
| ------- | -------- | ---------------------- |
| id      | string   | Unique                 |
| role    | enum     | ADMIN / MEMBER / GUEST |
| addedAt | datetime | When member was added  |

**Relationships:**

- `IS_MEMBER` ← Person
- `HAS_MEMBER` ← Space

---

### FieldContext

**Neo4j Labels:** `["FieldContext"]`

| Field        | Type     | Notes                  |
| ------------ | -------- | ---------------------- |
| id           | string   | Unique                 |
| title        | string   | Required               |
| emergentName | string   | AI-generated, optional |
| createdAt    | datetime |                        |
| deletedAt    | datetime | Soft-delete stamp (GOAL-319). Null while live. Deliberately NOT exposed in the GraphQL schema — the graph property only. Also stamped on the context's pulses at delete time. |

**Relationships:**

- `HAS_CONTEXT` ← Space (MeSpace or WeSpace) — live contexts only. **Every**
  context carries this edge, including nested sub-contexts (GOAL-295): the
  hierarchy is an overlay, never a replacement for the Space anchor that all
  auth / read / soft-delete / discovery surfaces traverse.
- `HAS_SUBCONTEXT` → FieldContext — nested sub-context (GOAL-295). Invariants
  (enforced only by the custom `createSubFieldContext` / `moveFieldContext`
  mutations via `src/lib/field-context/sub-context.ts` — the SDL declares
  `parentContext`/`subContexts` with `nestedOperations: []` so generated
  mutations cannot write the edge): at most ONE parent per context; parent and
  child in the SAME Space; no cycles; depth capped at `MAX_SUBCONTEXT_DEPTH`
  (5, root = depth 0). Resonance discovery treats the ROOT field's subtree as
  one scope — sub-contexts organize, they do not partition resonance
  (ADR-017). Subtree traversals must filter `deletedAt IS NULL` (a child can
  be soft-deleted on its own while the parent lives, and the overlay edge
  survives soft delete).
- `HAS_DELETED_CONTEXT` ← Space — a soft-deleted context (GOAL-319). Replaces
  `HAS_CONTEXT` in the delete transaction. Because every read surface (GraphQL
  `@authorization` filters, `viewablePulsePredicate`, resonance discovery, the
  bloom generator's fail-closed Space anchoring) reaches content via
  `HAS_CONTEXT`, re-pointing the edge hides the context and its whole subtree
  at once. Deliberately NOT whitelisted in the cypher-generator
  (`schema-context.ts`) — the assistant must never surface deleted content.
- `HAS_PULSE` → FieldPulse
- `HAS_PERSON` → Person — people attached to this context. Usually a
  `:Person:PersonPulse` (relational-world contact), but may also be a real
  `:User` (the uploader's self-link, or a consent-gated attach via the
  `addPersonToFieldContext` mutation — never the generated nested CONNECT,
  which is disabled)
- `HAS_RESONANCE` → ResonanceLink
- `CREATED_BY` → Person

**Authorization:** Inherits from parent Space.

**Deletion lifecycle (GOAL-319):** deleting a FieldContext is a cascading
SOFT delete — one transaction (shared orchestrator
`src/lib/field-context/soft-delete-field-context.ts`, used by both the
custom GraphQL `deleteFieldContext` mutation and the assistant's
`delete_field_context` HITL tool) that collects the context's whole
sub-context subtree (`HAS_SUBCONTEXT*`, GOAL-295), stamps `deletedAt` on
every subtree context and their pulses, hard-deletes ResonanceSuggestions
touching them (the suggestion inbox is Space-anchored and regenerable),
re-points each subtree member's `HAS_CONTEXT` → `HAS_DELETED_CONTEXT`, and
writes the activity Log. **Shared pulses are
protected:** a pulse `HAS_PULSE`-attached to another LIVE context is neither
stamped nor purged — it stays fully live there and is hard-deleted only with
its LAST holding context (the same exclusive-holder rule as Organizations). Requires Space owner or
ADMIN (kb/02 DELETE matrix). The generated `deleteFieldContexts` mutation is
disabled (`@mutation(operations: [CREATE, UPDATE])`) — it deleted the bare
node and orphaned nested content. After 90 days the daily
`/api/cron/purge-deleted-contexts` cron hard-deletes the context plus all
nested entities (pulses, chunks, resonance links + suggestions either
anchored on the context or touching its pulses, weaves, documents + blobs,
organizations left with no other context). Persons, Logs, ContextExtractions
and ingest ConversationThreads survive; their edges drop. See
`kb/04-state-machines.md` for the state diagram.

---

### GoalPulse

**Neo4j Labels:** `["FieldPulse", "GoalPulse"]`

| Field           | Type     | Notes                         |
| --------------- | -------- | ----------------------------- |
| id              | string   | Unique                        |
| title           | string   | Required                      |
| content         | string   | Required                      |
| status          | enum     | ACTIVE / PAUSED / COMPLETED   |
| horizon         | enum     | SHORT / MID / LONG (optional) |
| intensity       | float    | 0.0–1.0, optional             |
| successMeasures | string   | Optional                      |
| activities      | string   | Optional                      |
| type            | string   | Optional sub-type             |
| why             | string   | Motivation                    |
| location        | string   | Optional                      |
| time            | string   | Optional                      |
| photo           | string   | Optional                      |
| embedding       | float[]  | 1536-dim vector               |
| createdAt       | datetime |                               |
| modifiedAt      | datetime |                               |

**Relationships:**

- `HAS_PULSE` ← FieldContext
- `CREATED_BY` → Person
- `HAS_CHUNK` → ConversationChunk
- `SOURCE` / `TARGET` ← ResonanceLink

---

### ResourcePulse

**Neo4j Labels:** `["FieldPulse", "ResourcePulse"]`

**GOAL-354 — a document is a ResourcePulse.** `resourceType` is an open string,
not an enum: `document`, `article`, and whatever a future source type needs
(blog post, video, podcast, book) without a further data-model change. A
resource backed by a source file additionally carries the `source*` / `ingest*`
block below, migrated off the retired `:Document` node. The file bytes never
enter Neo4j — they stay in S3 and the graph holds only the key/URL.

Every field in that block is `@settable(onCreate: false, onUpdate: false)`, and
so is the `uploadedBy` **relationship**. That is load-bearing, not tidiness:
`:Document` carried `@mutation(operations: [])` so generated CRUD could not
reach its ingest machinery, but `ResourcePulse` *does* expose generated CRUD, so
the guard has to move down to field level. Without it, any ADMIN/MEMBER of the
Space could re-queue ingestion via `update: { ingestStatus_SET: "PENDING" }`
(unbounded model spend billed to the original uploader), plant member-visible
copy in `ingestStatusMessage`, falsify the entity counts, or re-point
`UPLOADED_BY` — which is the captured authorization decision the cron worker
runs as. The blob pointers additionally carry `@selectable(onRead: false)`,
`@filterable(byValue: false)` **and** `@sortable(byValue: false)`; the last is
not implied by the others, and ordering by a hidden field is a comparison oracle
(the GOAL-275 lesson). **Any field added to that block must repeat all of these.**

| Field        | Type     | Notes                                                                                                                                                                                                                                                                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id           | string   | Unique                                                                                                                                                                                                                                                                                                                       |
| title        | string   | Required                                                                                                                                                                                                                                                                                                                     |
| content      | string   | Required                                                                                                                                                                                                                                                                                                                     |
| resourceType | string   | Required — type of resource. Free text, not an enum: extensible by design (GOAL-354). Stored lower-cased by the bulk article import, which reads it from the sheet's `resource_type` column and falls back to `'article'` (GOAL-355)                                                                                            |
| availability | float    | Optional                                                                                                                                                                                                                                                                                                                     |
| intensity    | float    | 0.0–1.0, optional                                                                                                                                                                                                                                                                                                            |
| status       | string   | Optional                                                                                                                                                                                                                                                                                                                     |
| why          | string   | Optional                                                                                                                                                                                                                                                                                                                     |
| location     | string   | Optional — the resource itself                                                                                                                                                                                                                                                                                               |
| sourceUrl    | string   | Optional — where the resource was *found* (a LinkedIn post, a newsletter), as distinct from `location`. Written by the bulk article import from the sheet's `source_url` column (GOAL-355), and by document ingestion with the link an article's bytes were fetched from (GOAL-344) — where it doubles as that import's idempotency key. Member-correctable, unlike the rest of the source block. Its own property precisely so the doc-ingest summary that may replace a placeholder `content` can never overwrite it. Null elsewhere |
| time         | string   | Optional                                                                                                                                                                                                                                                                                                                     |
| embedding    | float[]  | 1536-dim vector                                                                                                                                                                                                                                                                                                              |
| createdAt    | datetime |                                                                                                                                                                                                                                                                                                                              |
| modifiedAt   | datetime |                                                                                                                                                                                                                                                                                                                              |

**Source-file properties (GOAL-354).** Null on resources with no backing file.

| Field                    | Type     | Notes                                                                                     |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| sourceFilename           | string   | Original filename; seeds `title` at migration                                              |
| sourceMimeType           | string   | v1: `text/plain`, `text/markdown`, `application/pdf`                                       |
| sourceSizeBytes          | int      |                                                                                            |
| sourcePageCount          | int      | `1` for .txt/.md; real page count for .pdf; null until the worker reads the blob            |
| sourceBlobKey            | string   | S3 object key. Not selectable, not filterable, **not sortable**                            |
| sourceBlobUrl            | string   | Provider-issued URL; may expire. Same three gates                                          |
| sourceUrl                | string   | Public link the bytes were fetched from by the bulk article import; null for uploads       |
| sourceUserHint           | string   | Optional one-line "What is this?" hint; reused on re-extract                                |
| sourceSummary            | string   | AI 1-paragraph synopsis, refreshed on re-extract. Kept distinct from `content` so a re-extract never clobbers member-edited copy |
| sourceConcepts           | string[] | Up to 5 concept phrases; empty on failure                                                  |
| ingestStatus             | string   | Ingest lifecycle. **Named `ingestStatus`, not `status`** — `ResourcePulse.status` already exists with the pulse's own unrelated meaning. See `kb/04-state-machines.md` |
| ingestStatusMessage      | string   | Member-safe failure copy; null unless FAILED                                                |
| ingestStatusUpdatedAt    | datetime | *Internal.* Staleness clock for reclaiming dead claims                                      |
| ingestAttempts           | int      | *Internal.* At 3 a stalled claim is abandoned to FAILED                                     |
| ingestClaimedBy          | string   | *Internal.* Worker run id holding the claim                                                 |
| ingestLockToken          | string   | *Internal.* Forces Neo4j's write lock during a claim; never read                            |
| ingestCreatedEntityCount | int      | Tool calls the ingest run landed                                                            |
| ingestFailedEntityCount  | int      | Proposed entities whose write failed                                                        |
| uploadedAt               | datetime | *Internal.* Retained from the Document node; also seeds `createdAt`                         |

**Relationships:** Same as GoalPulse, plus `UPLOADED_BY` → Person (the member who
brought the source file in — retained as its own edge so the audit trail survives
author re-attribution) and, on migrated documents, inbound `EXTRACTED_FROM` from
every Person / Organization / FieldPulse the extractor pulled out of it, and
`HAS_INGEST_THREAD` → ConversationThread.

---

### StoryPulse

**Neo4j Labels:** `["FieldPulse", "StoryPulse"]`

Historical note: StoryPulse originally absorbed the legacy CarePoint and
CoreValue entities, which is why it still declares their optional fields
below. Both have since been carved back out: migrated CarePoints are
`PromiseWeave` connector nodes, and migrated CoreValues are
`CoreValuePulse` (GOAL-287) — see [kb/08-migration.md](08-migration.md).
No StoryPulse carries `:CarePoint` or `:CoreValue` anymore (in envs that
have run `npm run backfill:corevalue-labels`; an un-backfilled env such as
a stale demo box may still hold the old `:StoryPulse:CoreValue` shape).

| Field               | Type     | Notes                        |
| ------------------- | -------- | ---------------------------- |
| id                  | string   | Unique                       |
| title               | string   | Required                     |
| content             | string   | Required                     |
| intensity           | float    | 0.0–1.0, optional            |
| levelFulfilled      | string   | Care-specific, optional      |
| fulfillmentDate     | string   | Care-specific, optional      |
| successMeasures     | string   | Care-specific, optional      |
| issuesIdentified    | string   | Care-specific, optional      |
| issuesResolved      | string   | Care-specific, optional      |
| alignmentChallenges | string   | CoreValue-specific, optional |
| alignmentExamples   | string   | CoreValue-specific, optional |
| whoSupports         | string   | CoreValue-specific, optional |
| embedding           | float[]  | 1536-dim vector              |
| createdAt           | datetime |                              |
| modifiedAt          | datetime |                              |

**Relationships:** Same as GoalPulse.

---

### CarePulse

**Neo4j Labels:** `["FieldPulse", "CarePulse"]`

| Field      | Type     | Notes             |
| ---------- | -------- | ----------------- |
| id         | string   | Unique            |
| title      | string   | Required          |
| content    | string   | Required          |
| sourceType | string   | Optional          |
| intensity  | float    | 0.0–1.0, optional |
| embedding  | float[]  | 1536-dim vector   |
| createdAt  | datetime |                   |

---

### CoreValuePulse

**Neo4j Labels:** `["FieldPulse", "CoreValuePulse"]` (nodes migrated from
production also retain `:CoreValue` for traceability — see
[kb/08-migration.md](08-migration.md) and
`scripts/backfill-corevalue-pulse-labels.ts`).

Minimal additional fields beyond the base FieldPulse interface.

> **Any query that filters for values MUST test BOTH markers** —
> `WHERE p:CoreValuePulse OR p:CoreValue` — and must never match
> `(:CoreValuePulse)` alone. An environment that predates the GOAL-287 relabel
> holds `["FieldPulse", "StoryPulse", "CoreValue"]` with **no**
> `:CoreValuePulse` at all, so a single-label match returns nothing there while
> the member can plainly see their values. Two live implementations to keep in
> step: `typeFilterCypher()` / `pulseProjectionCypher()` in
> `src/modules/agent/tools/pulse/pulse.service.ts` (the `search_pulses` path),
> and `SCHEMA_DOC` + `ALLOWED_LABELS` in
> `src/lib/cypher-generator/schema-context.ts` (the `query_for_bloom` path).
> The two drifting apart — text search finding values the graph canvas swore
> did not exist — was GOAL-333.
>
> Do not *anchor* on `(:CoreValue)`: only `FieldPulse.id` carries a uniqueness
> constraint (`scripts/init-db.js`), so a bare `:CoreValue` pattern is a label
> scan. Match `(:FieldPulse)` and filter with the label predicate.
>
> Because the subtype label present on a legacy value is `:StoryPulse`, any
> code deriving a display type or colour from labels must check the value
> marker **before** `:StoryPulse` (see `styleFor` in
> `src/lib/cypher-generator/node-style.ts`). Neo4j gives no ordering guarantee
> on `labels`, so never rely on `labels[0]`.

---

### ResonanceLink

**Neo4j Labels:** `["ResonanceLink"]`

| Field       | Type     | Notes                                              |
| ----------- | -------- | -------------------------------------------------- |
| id          | string   | Unique                                             |
| label       | string   | Relationship type (e.g., MOTIVATED_BY, ALIGNED_TO) |
| description | string   | Optional                                           |
| confidence  | float    | 0–1, AI-assigned                                   |
| evidence    | string   | Explanation of why the link exists                 |
| mergedFrom  | string   | Legacy relationship tracking                       |
| status      | string   | pending / confirmed / rejected                     |
| reviewedAt  | datetime | When human reviewed                                |
| reviewedBy  | string   | Who reviewed                                       |
| editedBy    | string   | Who edited                                         |
| createdAt   | datetime |                                                    |

**Known label values:** MOTIVATED_BY, APPLIED_TO, ALIGNED_TO, ENABLES, CARES_FOR, DEPENDS_ON, EMBRACES, PROVIDES, HAS_ACCESS_TO, CONNECTED_TO

**Relationships:**

- `SOURCE` → FieldPulse
- `TARGET` → FieldPulse
- `RESONATES_AS` → FieldResonance
- `HAS_RESONANCE` ← FieldContext

---

### PromiseWeave

**Neo4j Labels:** `["PromiseWeave"]`

A connective container that gives a pulse (initially a migrated care point) a
navigable neighbourhood. Modelled as a reified connector node exactly like
ResonanceLink — its own node type, **not** a pulse subtype — and surfaced
within a FieldContext via a `HAS_WEAVE` context edge, directly analogous to how
ResonanceLink is surfaced via `HAS_RESONANCE`. Originates in Steve's relational
"map" (see `docs/promise-weave-design-spike.md`, GOAL-266).

Three things author weaves: the prod→dev migration (which wrapped each migrated
care point — the starting point), a member from the field context's "Promise
weaves" section (GOAL-341), and the assistant's `propose_promise_weave` tool
(GOAL-342), whose proposals land `proposed` and need confirming.

**The AI path does NOT go through `createPromiseWeaves`.** That mutation's
CREATE rule requires a `createdBy` edge pointing at the caller, and an
AI-proposed weave has no member author — so `proposePromiseWeaveAuthorized`
(`src/lib/chat/hitl.ts`) writes the node in raw Cypher, the way the migration
does. It re-derives authorization itself rather than inheriting the SDL's:
`canEditContext` on the anchor field, and then every edge it creates is reached
*through* that already-cleared context (`HAS_PULSE` for the woven pulses,
`HAS_PERSON` for the person). A pulse id from another Space therefore matches
nothing and is silently dropped, which is what makes a cross-Space weave
unreachable rather than merely forbidden.

| Field      | Type     | Notes                                              |
| ---------- | -------- | -------------------------------------------------- |
| id         | string   | Unique, `weave_*` prefix                           |
| title      | string   | Optional — human label (defaults to the woven pulse's title) |
| description| string   | Optional — why these belong together; a member's note, or the evidence AI cited |
| status     | string   | `proposed` / `active` / `fulfilled` / `dissolved` — see `kb/04-state-machines.md`. Migration-built weaves carry the legacy CarePoint value verbatim (dev has `"Active"`, `"Inactive"`, `"active"`); compare case-insensitively, never raw |
| origin     | string   | `user` / `ai`. Null means migration-built           |
| createdAt  | datetime |                                                    |
| modifiedAt | datetime | Optional — stamped on every runtime edit            |

**Relationships:**

- `WEAVES` → FieldPulse (1..n — the care point(s) it connects)
- `WOVEN_FOR` → Person (whose care point / who it concerns)
- `CREATED_BY` → Person (authorship, for attribution) — **absent on an
  AI-proposed weave**, which has no member author. `origin: 'ai'` is what says
  where it came from; the acting member appears on the activity `Log` instead.
  Any query that reads authorship off this edge must tolerate an empty list.
- `HAS_WEAVE` ← FieldContext (scope + visibility anchor)

**Authorization:** Scoped to the parent FieldContext's Space — readable by the
Space owner or any member, writable by OWNER / ADMIN / MEMBER (GUESTs excluded),
mirroring ResonanceLink. Note: a single `HAS_WEAVE` context edge is the
canonical anchor (the design spike's separate `WITHIN` edge was collapsed into
it, since it would be a redundant anti-parallel edge — ResonanceLink likewise
uses only `HAS_RESONANCE`). Because that edge is what the `@authorization`
filter traverses, a weave created without it is not merely invisible — it is
unreachable by the gate. **Never create a weave without connecting `context`.**

**Writing a weave's pulses — interface gotcha.** `WEAVES` targets the
`FieldPulse` *interface*, and `@neo4j/graphql` expands every `connect` entry
across all five implementations. Two or more entries in one `connect` array
make it emit the same Cypher variable twice and Neo4j rejects the whole
mutation with `42N07` (variable shadowing). Connect many pulses with a **single
entry using `id_IN`**, not one entry per id:

```graphql
weaves: { connect: [{ where: { node: { id_IN: $pulseIds } } }] }   # correct
weaves: { connect: [{ where: { node: { id_EQ: $a } } },            # 42N07
                    { where: { node: { id_EQ: $b } } }] }
```

On update, pair `disconnect: [{ where: {} }]` with that connect **inside one
field entry** so pulses the member removed actually leave — otherwise the
woven set only ever grows. See `src/hooks/usePromiseWeaves.ts`.

**Opening `@mutation` also opens a nested-input tree — enumerate
`nestedOperations` in the same change.** `@neo4j/graphql` generates nested
`create` / `connect` / `disconnect` / `delete` inputs from every
`@relationship` on a type, and a nested `delete` cascades a bare DETACH DELETE
into the connected node. On `PromiseWeave` that meant a weave delete could take
its parent FieldContext with it — stranding every pulse in the field with no
`HAS_PULSE` anchor and no `deletedAt`, which is exactly what GOAL-319 removed
`deleteFieldContexts` to prevent.

Two rules fall out of the GOAL-341 review, and they apply to any type that
opens `@mutation`:

- **Enumerate `nestedOperations` per edge.** `weaves` / `wovenFor` take
  `[CONNECT, DISCONNECT]`; `createdBy` / `context` take `[CONNECT]`. The
  reverse edge needs it too — `FieldContext.weaves` is `nestedOperations: []`,
  because it is a second, otherwise ungated door into the same input tree.
- **A type-level `validate` block does NOT cover relationship operations.**
  `operations: [CREATE, UPDATE, DELETE]` never matches `CREATE_RELATIONSHIP` or
  `DELETE_RELATIONSHIP`, so only the READ `filter` applies to a connect or
  disconnect — and a filter that admits any member admits any member to those.
  Before the fix, a MEMBER could disconnect a weave's `context` edge and leave
  it unreadable, unwritable and undeletable by everyone including its author.

Authorship is pinned by a second validate rule,
`{ operations: [CREATE], where: { node: { createdBy_SINGLE: { id_EQ: "$jwt.user.id" } } } }`.
It cannot be a field-level directive — the library rejects `@authorization`
alongside `@relationship` — and it must not use `CREATE_RELATIONSHIP`, which
would also fire when a different member edits the weave and wrongly forbid it.

---

### Organization

**Neo4j Labels:** `["Organization", "LifeSensor", "RelationalEntity"]`

A first-class organization, group, company, cooperative or institution named in
an uploaded document (GOAL-298) — e.g. "Artisan Cooperative". Its own entity, not
a `Person` and not a pulse. Captured at upload time so members can discover it
and connect to the resources/stories it belongs to. The GraphQL `Organization`
type maps the load-bearing `Organization` label; the `LifeSensor` /
`RelationalEntity` ontology labels ride alongside (parity with migrated Persons).

| Field       | Type     | Notes                                     |
| ----------- | -------- | ----------------------------------------- |
| id          | string   | Unique — `organization_<uuid>`            |
| name        | string   | Required                                  |
| description | string   | Optional — what the org is / does         |
| createdAt   | datetime |                                           |
| updatedAt   | datetime | Set on enrich                             |

**Relationships:**

- `HAS_ORGANIZATION` ← FieldContext — the context(s) the org is attached to. The
  only Space tie an Organization has (it owns no Space, holds no membership), so
  it is the load-bearing branch of the read gate.
- `MENTIONED_IN` → FieldPulse — the pulse(s) the org was identified as related to.
- `EXTRACTED_FROM` → Document — doc-ingestion provenance.

**Authorization:** type-level `@authorization` READ filter over `contexts_SOME`
(owner or member of a context's parent Space) — an org unreachable through any
visible context is filtered out entirely, mirroring the PersonPulse context-reach
gate. All generated mutations are disabled (`@mutation(operations: [])`); orgs are
created server-side only, via the audited doc-ingestion write in
`src/lib/chat/hitl.ts` (`createOrganizationAuthorized`), which gates on
`canEditContent`.

**Writes:** created / enriched **only** by the doc-ingestion path
(`create_organization` tool). Idempotent by name-within-context (a same-named org
in the context is enriched, never duplicated). No embedding / vector index yet —
semantic org discovery is a follow-up (resonance is pulse↔pulse today).

---

### FieldResonance

**Neo4j Labels:** `["FieldResonance"]`

| Field       | Type   | Notes                                           |
| ----------- | ------ | ----------------------------------------------- |
| label       | string | Indexed — e.g., "grief", "courage", "belonging" |
| description | string | Optional                                        |

---

### ConversationChunk

**Neo4j Labels:** `["ConversationChunk"]`

| Field     | Type     | Notes                              |
| --------- | -------- | ---------------------------------- |
| id        | string   |                                    |
| content   | string   | Sentence text                      |
| order     | int      | Indexed — position in conversation |
| role      | string   | user / assistant / system          |
| embedding | float[]  | 1536-dim vector                    |
| createdAt | datetime |                                    |

**Relationships:**

- `HAS_CHUNK` ← FieldPulse

---

### ConversationThread

**Neo4j Labels:** `["ConversationThread"]`

Server-side persisted AI assistant chat thread. A `User` can own many — one
implicit "reflective" thread created on first message, plus any threads
spawned via the sidebar "+" or doc-ingest.

**Hydration (GOAL-345): the panel opens on an empty conversation on every
initial load** — fresh navigation, hard refresh, new tab. No thread is
restored on arrival, and no thread node is created just by loading the app.
Threads are hydrated only when the member explicitly picks one from the
switcher / threads sidebar (`GET /api/chat/simulation/thread?id=…`, which
requires an id), and the landing conversation creates its thread lazily on the
first send so that turn carries an explicit id rather than MERGEing onto the
implicit `ownerId`-keyed thread. Replay is via `useChatRuntime({ messages })`
on mount.

There is no last-viewed pin. GOAL-240 introduced `User.lastViewedThreadId` so a
hard refresh re-opened the last thread; GOAL-345 reversed that and removed the
property's readers and writers — including the stamp `createIngestThread` used
to apply, which made every load after a background ingest land in an
"Uploaded ….pdf" thread the member never opened.

| Field       | Type     | Notes                                                                            |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| id          | string   | UUID, UNIQUE                                                                     |
| ownerId     | string   | Set only on the implicit reflective thread (MERGE key in `appendConversationTurn`). Not unique; concurrent first-writes can produce two implicit threads, which is acceptable degeneracy — both surface in the sidebar normally. |
| createdAt   | datetime |                                                                                  |
| lastTurnAt  | datetime | Indexed — orders the thread switcher (newest first)                              |
| turnCount   | int      | Atomic counter — incremented per append, source of `Turn.order`                  |
| mode        | string   | `'default' \| 'aiden' \| 'braider'`. Locked to `'default'` on ingest threads.   |
| kind        | string   | `'reflective' \| 'ingest'`. Drives the mode-selector lock in the switcher.       |
| title       | string   | Auto-generated for ingest threads; auto-generated by GPT-4o-mini for reflective on first exchange. Null until set. |

**Relationships:**

- `HAS_THREAD` ← Person:User (multiple threads per user)
- `HAS_INGEST_THREAD` ← Document (ingest threads only)
- `HAS_TURN` → ConversationTurn

---

### ConversationTurn

**Neo4j Labels:** `["ConversationTurn"]`

Single message in a `ConversationThread`. Stores the full `parts` payload
from the AI SDK `UIMessage` shape so tool calls + results can be replayed
verbatim on hydration.

| Field     | Type     | Notes                                                                       |
| --------- | -------- | --------------------------------------------------------------------------- |
| id        | string   | UUID, UNIQUE                                                                |
| role      | string   | user / assistant / system                                                   |
| content   | string   | Plain-text view of the message — derived from text parts on save            |
| parts     | string   | JSON-serialised `UIMessagePart[]` (text, tool-call, tool-result, …)         |
| order     | int      | Indexed — monotonically increasing within a thread (gaps allowed under race)|
| createdAt | datetime |                                                                             |

**Relationships:**

- `HAS_TURN` ← ConversationThread

**Activity Log exemption:** chat turn writes are intentionally NOT mirrored
into the `Log` stream. The thread itself is the audit trail (every turn is
timestamped, ordered, and attributed via the user→thread relationship), and
logging every assistant message would swamp the activity feed. Mirrors the
existing exemption for `ConversationChunk` writes.

---

### Log (Activity)

**Neo4j Labels:** `["Log"]`

| Field       | Type     | Notes                    |
| ----------- | -------- | ------------------------ |
| id          | string   |                          |
| description | string   | Required                 |
| metadata    | string   | JSON metadata, optional  |
| createdAt   | datetime | Immutable, set on create |

**Relationships:**

- `CREATED_BY` → Person
- `LOGGED_FOR` → GoalPulse / ResourcePulse / FieldPulse

**Authorization (GOAL-342).** Writes are **server-side only** —
`@mutation(operations: [])`. Every real Log is written by raw Cypher
(`createLog`, or inline in a mutation's own statement) or by the `log*Activity`
resolvers, which gate on `canEditContext`. The generated `createLogs` /
`updateLogs` / `deleteLogs` roots were open to any authenticated caller, who
could forge an activity entry, rewrite someone else's, or delete one. An
activity feed its own subject can rewrite is not an audit trail.

READ is filtered: a Log is as visible as what it is *about* — its author can
always see it (`createdBy`), and anyone who can reach the Space of a pulse it
is `LOGGED_FOR` can see it. This matters because **descriptions are assembled
server-side from graph reads**, so they carry pulse titles, people's names and
field titles verbatim; ungated, `logs(where: { description_CONTAINS: … })` was
a platform-wide read oracle. Fails closed: a Log about nothing, by someone
else, is invisible.

**Writing a Log from new code:** set `metadata` only. `createLog` also writes a
`metadataJson` twin, but nothing reads it — it is absent from the GraphQL type
and from this table, and `@neo4j/graphql` can neither project nor filter on it.

### Notification

**Neo4j Labels:** `["Notification"]`

Recipient-addressed, per-person notification with server-side read state.
**Distinct from `Log`:** a `Log` is the immutable, space-wide _audit trail_ of
everything that happened (including your own actions); a `Notification` is owned
by exactly one recipient, concerns _them specifically_ (you were invited, your
role changed, a resonance was found on your pulse, you were mentioned), and
carries its own read/unread flag. Notifications back the bell popover; the audit
`Log` backs the dedicated activity-log page. Emission is decoupled (see
`src/lib/notifications/create-notification.ts`) so an email/Resend channel can
layer on later without touching call sites.

| Field     | Type     | Notes                                                                |
| --------- | -------- | -------------------------------------------------------------------- |
| id        | string   | Required, unique (`ntf_<ts>_<rand>`)                                 |
| type      | string   | Enum: `INVITE`, `ROLE_CHANGE`, `MEMBERSHIP`, `RESONANCE`, `MENTION`  |
| title     | string   | Short headline, e.g. "New resonance on your pulse"                   |
| message   | string   | Human-readable body. Never embed raw internal IDs (Rule 1).         |
| link      | string   | Optional in-app route for click-through                             |
| read      | boolean  | Server-side read state. Defaults `false`.                           |
| readAt    | datetime | Set when first marked read; null while unread.                      |
| createdAt | datetime | Immutable, set on create.                                           |
| metadata  | string   | JSON-serialized optional contextual data (spaceId, pulseId, role…). |

**Relationships:**

- `NOTIFIES` → Person (the recipient; exactly one)
- `TRIGGERED_BY` → Person (the actor who caused it; optional — system events
  may have none)

**Authorization:** readable ONLY by the recipient. Enforced via the
`@authorization` filter on the `Notification` `@node` type
(`{ where: { node: { recipient_SOME: { id_EQ: "$jwt.user.id" } } } }`), which
gates the library-generated read query. The mark-read mutations additionally
re-check `context.jwt.user.id` server-side (the recipient MATCH is the auth gate).

**Emission rules:**

- Never notify the actor about their own action — `createNotification` drops any
  notification whose `recipientId === actorId`.
- Marking a notification read does NOT write to the `Log` audit stream (avoids
  audit-feed spam).

**Lifecycle:** forward-only. No backfill of historical events; the bell shows
nothing until new events fire. Read state is sticky — there is no "mark unread"
in v1. `@mention` notifications are plumbed (`type: MENTION`) but have no
production caller until a mention-authoring surface exists.

### Document

**Neo4j Labels:** `["Document"]`

Uploaded source document attached to a FieldContext. Created by the
direct-to-S3 ingestion flow: `POST /api/ingest/document/presign` mints a
short-lived presigned PUT URL; the browser uploads straight to S3; `POST
/api/ingest/document/process` then anchors the Document node as `PENDING` and
returns **202** — extraction itself (Gemini multimodal for PDFs, OpenAI for
text/markdown) runs in `/api/cron/process-document-ingestion` (GOAL-292). The
original file lives in AWS S3 (memory store for dev/tests); the graph node
carries metadata and provenance edges. See WF-10 in `kb/03-workflows.md`
and ADR-014 / ADR-015 in `kb/06-adr.md`.

| Field                    | Type     | Notes                                                                                  |
| ------------------------ | -------- | -------------------------------------------------------------------------------------- |
| id                       | string   | Required, unique                                                                       |
| filename                 | string   | Required                                                                               |
| mimeType                 | string   | v1: `text/plain`, `text/markdown`, `application/pdf`                                   |
| sizeBytes                | int      | Required                                                                               |
| pageCount                | int      | `1` for .txt/.md; real page count for .pdf; null until the worker reads the blob        |
| blobKey                  | string   | Internal — UI surfaces filename instead                                                |
| blobUrl                  | string   | Provider-issued URL for the blob (may be private/expiring; treat as opaque)            |
| userHint                 | string   | Optional one-line "What is this?" hint; reused on re-extract                           |
| sourceUrl                | string   | Public link the bytes were fetched from when the bulk article import read an article server-side (GOAL-344); null for uploads. Idempotency key: one FieldContext never fetches the same article twice. Stored as the member typed it (never the post-redirect URL, which can carry session tokens), so a share link's own token (OneDrive `?e=…`) is visible to every member of the Space — the same exposure the row pulse's `location` already has |
| summary                  | string   | AI-generated 1-paragraph synopsis; refreshed on re-extract; null on summarizer failure |
| concepts                 | string[] | Up to 5 short concept phrases the AI surfaced as top-level themes; empty on failure    |
| status                   | string   | *GraphQL-exposed.* Ingest lifecycle (GOAL-292): `PENDING` → `PROCESSING` → `COMPLETE` / `FAILED`. **Absent on pre-GOAL-292 documents — every read coalesces missing to `COMPLETE`.** See `kb/04-state-machines.md` |
| statusMessage            | string   | *GraphQL-exposed.* Member-safe failure copy, safe to render verbatim; null unless `status = FAILED`        |
| statusUpdatedAt          | datetime | *Internal (not in the GraphQL schema).* When `status` last changed; also the staleness clock for reclaiming dead claims         |
| ingestAttempts           | int      | *Internal.* Times this document has been claimed; at 3 a stalled claim is abandoned to `FAILED`     |
| ingestClaimedBy          | string   | *Internal.* Worker run id holding the claim; null when not `PROCESSING`. Only the winning claimant writes it, so it is a truthful owner — the terminal writes fence on it |
| ingestLockToken          | string   | *Internal.* Throwaway value written to force Neo4j's write lock during a claim. Never read — its only job is making the status guard evaluate post-lock |
| ingestCreatedEntityCount | int      | *GraphQL-exposed.* Tool calls the ingest run landed, set when `status` reaches `COMPLETE`. Counts `MENTIONED_IN` links as well as entities, so it slightly over-reads as "entities" in the UI copy |
| ingestFailedEntityCount  | int      | *GraphQL-exposed.* Proposed entities whose write failed (partial success is normal)                       |
| uploadedAt               | datetime | Immutable, set on create                                                               |

**Ingest throughput limits (GOAL-292):** one account may hold at most **20**
documents in `PENDING`/`PROCESSING` at a time; `POST /api/ingest/document/process`
refuses beyond that with **429** and `reason: 'queue_full'`. The worker drains
**4** documents per one-minute tick, oldest upload first, with no per-user
interleaving — so the cap is what stops one member starving every other Space.

**Relationships:**

- `HAS_DOCUMENT` ← FieldContext (parent context owns the document)
- `UPLOADED_BY` → Person:User (the uploader)
- `EXTRACTED_FROM` ← Person (extracted persons trace back here)
- `EXTRACTED_FROM` ← FieldPulse (extracted goal/resource/story pulses trace back here)
- `EXTRACTED_FROM` ← Organization (extracted orgs trace back here — GOAL-298)
- `HAS_INGEST_THREAD` → ConversationThread (one per upload + one per re-extract)

**Attribution:** when the extractor identifies whose voice/authorship an
extracted pulse carries (a byline, the user hint, a named speaker), the
created pulse's canonical `INITIATED_BY` author edge points at that extracted
Person — not the uploader — so the person stays related to their
contributions in the graph. The extractor emits an `authorName` per pulse,
validated against the extracted persons + context roster
(`extraction-model-invoker.ts`), resolved to the live person id by the ingest
orchestrator, and enforced context-scoped (the credited person must be
`HAS_PERSON`-attached to the same FieldContext) in
`createPulseAuthorized` (`src/lib/chat/hitl.ts`). The activity `Log` stays
`CREATED_BY` the uploader either way, and `UPLOADED_BY` still records who
brought the document in. Any `HAS_PERSON`-attached Person qualifies —
including a registered `:User` (e.g. a WeSpace co-member): deliberate, since
the Log keeps the uploader accountable for the write itself.

The update paths re-attribute **conservatively** (GOAL-318): a re-extract or
a second document that roster-matches an existing pulse (`update_pulse`, or
`create_pulse`'s enrich-don't-duplicate branch) carries the same
`authorName`, and the write re-points `INITIATED_BY` at the credited person
ONLY when the pulse's current displayed author (`initiatedBy[0]`, else
`createdBy[0]` — `resolvePulseAuthor` precedence) is the acting uploader or
absent. Default uploader attribution gets corrected; authorship a different
person already holds is never stolen (`reattributeIngestPulseAuthor` in
`src/lib/chat/hitl.ts`). Each re-attribution writes its own attribution
suffix into the update Log. Context-attached Persons lacking embeddings are
also swept at upload time (`on-upload-discovery.ts` Step 1b) so authors
become visible to person vector search without waiting for the nightly
resonance cron — the pass runs after any upload or re-extract whose run
created a pulse **or a person** (`process/route.ts`, `document-resolver.ts`);
an update-only run that mints no new entity still defers to the cron.

**Related people & organizations (GOAL-298):** beyond the single author,
the extractor also emits, per pulse, the people and organizations the document
names as *related to* it (subjects, contributors, the cooperative offering a
resource). Each extracted person becomes a `:Person:PersonPulse`
(`create_person`), each org an `:Organization` (`create_organization`), both
attached to the FieldContext (`HAS_PERSON` / `HAS_ORGANIZATION`); then a
`MENTIONED_IN` edge links each to the pulse it belongs to. Authorship stays on
`INITIATED_BY`; `MENTIONED_IN` is the distinct "named in / related to" edge, so
one pulse can carry one author and many mentioned entities. The link write
(`linkEntityToPulseAuthorized`) is co-location-gated — the entity must already be
attached to a context that holds the pulse — and writes one `Log`. The ingest
orchestrator resolves each link's endpoints by name/title from the entities
created earlier in the same run (`handle-ingest-document.ts`).

**Authorization:** inherits read access from the parent Space — the same
`@authorization` pattern as FieldContext. Writes (`POST /api/ingest/document/{presign,process}`,
`reExtractDocument`, `deleteDocument`) all gate on `canEditContent` against
the parent Space (`kb/02-user-roles.md`).

**Lifecycle:** Documents are **never auto-deleted**. Deletion is user-driven
via `deleteDocument`, which removes the blob and the Document node;
previously approved Persons and FieldPulses extracted from the document
survive (their `EXTRACTED_FROM` edges drop with the Document). v1 has no
file-versioning; uploading a new revision of a source creates a new
Document node with its own ingest thread.

---

### ArticleImportJob

**Neo4j Labels:** `["ArticleImportJob"]`

One queued bulk spreadsheet import (GOAL-326). `POST /api/import/articles`
validates the rows, gates on `canEditContent`, anchors this node as `PENDING`
and returns **202**; `/api/cron/process-article-imports` mints one pulse per row
through the authorized write path and drives the status machine. The member
polls `GET /api/import/articles/<jobId>`. See WF-11 in `kb/03-workflows.md`,
the status machine in `kb/04-state-machines.md`, and ADR-019 in `kb/06-adr.md`.

**Not in the GraphQL schema** — this is queue infrastructure, not domain data
(same class as `LlmUsage`). Exposing it would generate CRUD roots over its own
status machine, exactly the hole `Document` had to close with
`@mutation(operations: [])`.

| Field           | Type     | Notes                                                                                     |
| --------------- | -------- | ----------------------------------------------------------------------------------------- |
| id              | string   | Required, unique (`article_import_job_id` constraint). `import_<uuid>` — the handle the client polls with. Every hot path matches by it: the claim, each of up to 300 per-row outcome appends, all three terminal writes, the load, and the member's 2-second poll |
| status          | string   | `PENDING` → `PROCESSING` → `COMPLETE` / `FAILED`. See `kb/04-state-machines.md`            |
| statusMessage   | string   | Member-safe failure copy, safe to render verbatim; null unless `status = FAILED`           |
| statusUpdatedAt | datetime | When `status` last changed; also the staleness clock, refreshed by every per-row outcome    |
| createdAt       | datetime | Enqueue time; the queue drains oldest-first on this                                        |
| totalRows       | int      | Row count at enqueue — the one summary value that cannot be derived from the outcomes      |
| rowsJson        | string   | The validated payload, JSON. Written once at enqueue, **nulled at every terminal status** — the outcomes are what the member reads from then on |
| rowOutcomes     | string[] | One JSON outcome per processed row, in row order. `size()` is the resume cursor, and the whole summary is recomputed from it |
| attempts        | int      | Times claimed; at 3 a stalled claim is abandoned to `FAILED`. Reset to 0 by a voluntary requeue, which proves progress |
| claimedBy       | string   | Worker run id holding the claim; null when not `PROCESSING`. Only the winning claimant writes it, so it is a truthful owner — every outcome append and terminal write fences on it |
| lockToken       | string   | Throwaway value written to force Neo4j's write lock during a claim. Never read           |

**Import throughput limits:** a single sheet is capped at **300** rows
(`MAX_ARTICLE_IMPORT_ROWS`), one account may hold **5** jobs in
`PENDING`/`PROCESSING` at once (**429** `reason: 'queue_full'` beyond that), and
the `bulk-import` rate limit allows **10 imports/hour/account**. The in-flight
cap is enforced in the graph specifically because the rate limiter fails OPEN
when Redis is unreachable. The worker claims at most **2** jobs per one-minute
tick and stops starting rows at ~220s, handing the rest back to the queue.

**Relationships:**

- `HAS_IMPORT_JOB` ← FieldContext (the target field; purged with it)
- `REQUESTED_BY` → Person:User (the member who submitted the sheet)

**Authorization:** `canEditContent` on the parent Space is checked at enqueue
*and* re-checked by the worker at claim time, since the gap can be minutes. The
`REQUESTED_BY` edge is how that decision crosses the queue boundary — the worker
holds no JWT and attributes every write, and every activity `Log`, to that
person. Reads are scoped to the requester alone: a job belonging to someone else
is indistinguishable from one that does not exist.

**Lifecycle:** jobs are not user-deletable and have no restore. They are hard-
deleted with their FieldContext at the 90-day purge — an unfinished one still
holds the member's uploaded rows, so it must not outlive the context.

---

### AssistantFeedback

Captures signal about a single assistant turn so devs can improve prompts and
tools over time. Two write paths land here:

- **`user_thumb`** — explicit thumbs-up / thumbs-down from the chat UI,
  optionally with a "what would have been better" comment.
- **`auto_*`** — server-side signals emitted from the chat route's
  `onFinish` callback: tool errors, empty assistant text, Rule-1
  violations (raw ids, `__typename`, internal graph labels — see
  `kb/07-ai-assistant-ux.md`).

**Properties:**

| Field                  | Notes                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| `id`                   | `feedback_<uuid>`                                                 |
| `rating`               | `'positive' \| 'negative'`                                        |
| `source`               | `'user_thumb' \| 'auto_tool_error' \| 'auto_empty_text' \| 'auto_rule_violation'` |
| `userComment`          | Optional free-text from the user (thumbs-down comment).           |
| `ruleViolated`         | For auto rule violations: `rule_1_raw_id_leak`, `rule_1_typename_leak`, `rule_1_graph_label_leak`, `rule_1_uuid_leak`. |
| `autoSignal`           | Machine-readable code (e.g. `tool_error:get_my_spaces`).          |
| `classification`       | LLM-assigned failure mode — see cron output for the enum.         |
| `classificationReason` | One-sentence rationale from the classifier.                       |
| `cluster`              | `cluster_<id>` assigned by nearest-neighbor on `questionEmbedding`. |
| `questionEmbedding`    | 1536-dim vector of the user question — drives clustering.         |
| `goldenSet`            | Boolean — devs flag rows that should be replayed by the (future) eval harness. |
| `status`               | Triage workflow: `'open'` (default) \| `'in_progress'` \| `'resolved'`. Rows predating this field coalesce to `'open'`. The dashboard hides `resolved` by default. |
| `statusUpdatedAt`      | datetime — when the status last changed (null until first touched). |
| `statusNote`           | Optional short note attached at the last status change (e.g. "fixed in 9d7bd9f"; "wontfix — accepted limitation"). |
| `createdAt`            | datetime.                                                         |

**Relationships:**

- `(AssistantFeedback)-[:FEEDBACK_ON]->(ConversationTurn)` — the assistant
  turn being rated.
- `(AssistantFeedback)-[:FEEDBACK_FROM]->(:Person)` — submitter (present
  for `user_thumb` only).
- `(AssistantFeedback)-[:IN_CONTEXT_OF]->(:ConversationThread)` — query
  convenience.

**Privacy / activity log:** AssistantFeedback writes are NOT mirrored
into the `Log` stream — the same exemption as `ConversationTurn` and
`ConversationChunk`. The nodes themselves are the audit trail.

**Where it's consumed:**

- `src/lib/feedback/assistant-feedback.service.ts` — Neo4j CRUD.
- `src/app/dev/ai-quality/page.tsx` — dev-gated triage dashboard.
- `src/app/api/cron/classify-ai-feedback/route.ts` — daily classifier.

---

### LlmUsage

Per-call token & cost metering (GOAL-297, Phase 1 — measurement). One node is
written per LLM/embedding call at every instrumented site (chat, title-gen,
cypher-gen, doc extract/summary, embeddings, person enrichment, resonance
analysis, feedback classification). Cost is derived from a configurable
per-model price table (`src/lib/llm/pricing.ts`, overridable via
`LLM_PRICING_JSON`). This is an internal metering node — it is deliberately
NOT part of the assistant's cypher-generator vocabulary (kb/07 Rule 9).

**Properties:**

| Field              | Notes                                                             |
| ------------------ | ----------------------------------------------------------------- |
| `id`               | `usage_<uuid>`                                                   |
| `model`            | Exact model id (e.g. `gpt-5.4`, `gpt-4o-mini`, `text-embedding-3-small`, `gemini-2.5-pro`). |
| `provider`         | `'openai' \| 'gemini'`                                            |
| `source`           | Call site: `'chat' \| 'title-gen' \| 'cypher-gen' \| 'doc-extract' \| 'doc-summary' \| 'embeddings' \| 'enrichment' \| 'resonance-analysis' \| 'feedback-classify'` |
| `promptTokens`     | Input tokens. Embeddings: counted locally via tiktoken (LangChain returns no usage). |
| `completionTokens` | Output tokens (0 for embeddings).                                |
| `totalTokens`      | Sum, or the model-reported total.                                |
| `costUsd`          | Derived at write time from the price table.                      |
| `priced`           | `false` when the model had no explicit rate (fallback used) — surfaced as "est." in the report. |
| `tokensEstimated`  | Reserved; `false` today (embeddings use an exact tiktoken count). |
| `principal`        | `'user'` (interactive) \| `'system'` (background/cron).          |
| `userId`           | The acting user's id when `principal='user'` (also carried on the edge). |
| `createdAt`        | datetime.                                                        |

**Relationships:**

- `(LlmUsage)-[:INCURRED_BY]->(:Person)` — the acting user (interactive spend).
- `(LlmUsage)-[:INCURRED_BY]->(:SystemPrincipal {id:'system'})` — the singleton
  principal for background/cron spend with no logged-in caller. MERGE'd on
  first write.
- `(LlmUsage)-[:IN_CONTEXT_OF]->(:ConversationThread)` — optional, for chat
  spend. The usage node is always created even when the Person / thread
  doesn't exist (edges are conditional; nothing is dropped).

**Privacy / activity log:** LlmUsage writes are NOT mirrored into the `Log`
stream — the same exemption as `ConversationTurn`, `ConversationChunk`, and
`AssistantFeedback`. The nodes themselves are the audit trail. (Phase-2
spend-cap *config* mutations WILL be logged; that is out of scope for Phase 1.)

**Where it's consumed:**

- `src/lib/llm/usage/llm-usage.service.ts` — write (`recordLlmUsage`) + report reads (`getLlmUsageReport`).
- `src/lib/llm/pricing.ts` — per-model price table.
- `src/app/dev/llm-usage/page.tsx` — dev-gated spend report (by user / by model / system).

---

## Neo4j Constraints

| Constraint                | Target                        |
| ------------------------- | ----------------------------- |
| `person_id`               | Person.id UNIQUE              |
| `community_id`            | Community.id UNIQUE           |
| `space_id`                | Space.id UNIQUE               |
| `context_id`              | FieldContext.id UNIQUE        |
| `pulse_id`                | FieldPulse.id UNIQUE          |
| `resonance_link_id`       | ResonanceLink.id UNIQUE       |
| `promise_weave_id`        | PromiseWeave.id UNIQUE        |
| `document_id`             | Document.id UNIQUE           |
| `conversation_thread_id`       | ConversationThread.id UNIQUE       |
| `conversation_turn_id`         | ConversationTurn.id UNIQUE         |
| `assistant_feedback_id`        | AssistantFeedback.id UNIQUE        |
| `organization_id`              | Organization.id UNIQUE             |
| `llm_usage_id`                 | LlmUsage.id UNIQUE                 |
| `system_principal_id`          | SystemPrincipal.id UNIQUE         |
| `log_id_unique`                | Log.id UNIQUE                     |

## Vector Indexes (1536 dimensions, cosine similarity)

| Index                                | Label             | Property          | Purpose                                       |
| ------------------------------------ | ----------------- | ----------------- | --------------------------------------------- |
| `personBioVectorIndex`               | Person            | embedding         | Find people by interests/themes               |
| `pulseContentVectorIndex`            | FieldPulse        | embedding         | Find similar pulses                           |
| `conversationChunkVectorIndex`       | ConversationChunk | embedding         | Find specific conversation moments            |
| `assistantFeedbackQuestionVectorIndex` | AssistantFeedback | questionEmbedding | Cluster bad-question patterns for triage     |

## Property Indexes

| Index                              | Target                          |
| ---------------------------------- | ------------------------------- |
| `resonance_label`                  | FieldResonance.label            |
| `pulse_createdAt`                  | FieldPulse.createdAt            |
| `pulse_modifiedAt`                 | FieldPulse.modifiedAt           |
| `chunk_order`                      | ConversationChunk.order         |
| `assistant_feedback_createdAt`     | AssistantFeedback.createdAt     |
| `assistant_feedback_classification` | AssistantFeedback.classification |
| `assistant_feedback_status`        | AssistantFeedback.status        |
| `person_invite_token_hash`         | Person.inviteTokenHash          |
| `person_reset_token_hash`          | Person.resetTokenHash           |
| `llm_usage_createdAt`              | LlmUsage.createdAt              |
| `resource_ingest_status`           | ResourcePulse.ingestStatus — the ingest queue after GOAL-354. Matters strictly more than `document_status` did: the cron's seek is the same shape but the label it scans is ~5x larger. `pulse_id` is on `:FieldPulse`, NOT `:ResourcePulse`, so the re-anchored by-id claim must match `(d:FieldPulse {id})` and assert the label in a WHERE, or it degrades to a label scan |
| `document_status`                  | Document.status — the ingest queue; the one-minute cron seeks it twice per tick (measured 53 dbHits with it vs 10,101 without, at 5k documents) |
| `article_import_job_status`        | ArticleImportJob.status — the bulk-import queue; the one-minute cron seeks it twice per tick and every enqueue seeks it twice more for the in-flight cap. **The drain query must anchor on this seek, not on `(c:FieldContext)-[:HAS_IMPORT_JOB]->(j)`** — the context-anchored form never touches the index and label-scans instead (measured 1,501 dbHits vs 1 at a 1,500-job backlog). It plans as a seek against an EMPTY label, so only a seeded profile proves anything |
| `context_deletedAt`                | FieldContext.deletedAt — the daily purge sweep (GOAL-319) |
| `notification_createdAt`           | Notification.createdAt |
| `notification_read`                | Notification.read      |

Uniqueness constraints also carry backing RANGE indexes — notably `pulse_id`
on `FieldPulse.id` (`scripts/init-db.js`), which is what makes by-id pulse
lookups (e.g. `FieldPulse.__resolveType`'s label query) index seeks rather
than scans.

## ID Strategy

All entities use string IDs — generated server-side or client-side as needed.
