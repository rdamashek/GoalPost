# GoalPost Workflows

Core workflows for the GoalPost platform.

## Workflow Sequence

```
WF-01: User Registration & Onboarding     (New user signs up, completes profile)
WF-02: Space Creation                     (User creates MeSpace or WeSpace)
WF-03: FieldContext Creation              (User creates a thematic container within a space)
WF-04: Conversation & Pulse Creation      (User converses with AI, captures a pulse)
WF-05: Embedding & Person Enrichment      (Background: generate embeddings, enrich profiles)
WF-06: Resonance Discovery               (Background: AI finds semantic connections between pulses)
WF-07: Human Resonance Review            (User confirms, edits, or rejects AI-found resonances)
WF-08: WeSpace Collaboration             (Owner invites members, shared pulse creation)
WF-09: Data Import                       (User imports CSV/XLSX data into the system)
WF-10: Document Ingestion                (User uploads a file; a worker extracts entities from it)
WF-11: Bulk Article Import               (User uploads a spreadsheet; a worker mints one pulse per row)
WF-12: Promise Weave Authoring           (Member weaves pulses + a person into a navigable neighbourhood)
```

---

## WF-01 — User Registration & Onboarding

**Actor:** New User

1. User signs up with name, email, and password.
2. JWT token issued, user redirected to onboarding flow.
3. Onboarding guides user through profile setup (pronouns, location, interests, passions, careManual).
4. MeSpace automatically created for the user on account creation.
5. Onboarding state tracked via `onboardingCurrentStepIndex`, `onboardingCompletedSteps`, `onboardingIsCompleted`.
6. User can skip onboarding (`onboardingSkipped = true`).

---

## WF-02 — Space Creation

**Actor:** Authenticated User

### MeSpace (automatic)

1. Created automatically during user registration.
2. One MeSpace per user — personal, private container.
3. Only the owner can access content within it.

### WeSpace (manual)

1. User creates a new WeSpace from the Spaces page.
2. Specifies: name, description, visibility (PRIVATE / SHARED).
3. Optional fields: why, location, time, activities.
4. WeSpace becomes available for member invitations.

---

## WF-03 — FieldContext Creation

**Actor:** Space Owner or Member (with edit permissions)

1. User navigates to a Space (MeSpace or WeSpace).
2. Creates a new FieldContext with a title.
3. FieldContext appears within the space, ready to receive pulses.
4. Over time, an emergent name may be generated from the content within.

### Sub-context creation & nesting (GOAL-295)

**Actor:** Space Owner, ADMIN, or MEMBER (`canEditContent`)

1. User opens a FieldContext detail page and uses "New nested field" in the
   Nested fields section, or — from either studio canvas view, including
   Bloom — "Add nested field" in the canvas action bar (GOAL-339). Both
   mount the shared `CreateNestedFieldModal` (custom
   `createSubFieldContext` mutation).
2. The child is created in the SAME Space as the parent — its own
   `HAS_CONTEXT` edge — plus a `HAS_SUBCONTEXT` overlay edge from the
   parent. Depth is capped at 5 levels.
3. "Move" on the detail page re-parents a field under another same-Space
   field, or lifts it to the top level (custom `moveFieldContext` mutation;
   cycles and depth violations are rejected server-side).
4. The Space page lists only TOP-LEVEL fields; nested fields are
   reached by drilling into their parent (breadcrumb shows
   Space → field → … → nested field).
5. Both mutations write an activity Log in the same transaction.
6. Resonance discovery is NOT partitioned by nesting: the root field's
   whole subtree is one resonance scope (see ADR-017).

---

## WF-04 — Conversation & Pulse Creation

**Actor:** Authenticated User

1. User opens the AI assistant (Standard, Aiden, or Braider mode).
2. User converses with the AI — messages are chunked into sentences.
3. Each sentence becomes a `ConversationChunk` node.
4. User clicks "Create Pulse" to capture a pulse from the conversation.
5. User selects pulse type: GoalPulse, ResourcePulse, StoryPulse, CarePulse, or CoreValuePulse.
6. User provides: title, content, intensity, and type-specific fields.
7. Pulse created as a `FieldPulse` node, linked to its `FieldContext` and `ConversationChunks`.
8. Background job queued for embedding generation and person enrichment.

### Direct Pulse Creation (without conversation)

1. User navigates to a FieldContext within a Space.
2. Creates a pulse directly with title, content, type, and optional fields.
3. Same background processing applies.

---

## WF-05 — Embedding & Person Enrichment

**Actors:** Vercel Cron Jobs (API route handlers)

### Pulse Processing Job

1. Triggered on every pulse creation.
2. Generates individual embeddings for each ConversationChunk (sentence-level).
3. Generates composite pulse embedding (pulse content + all linked chunks).
4. Stores embeddings in Neo4j vector indexes.

### Person Enrichment Job

1. Triggered after pulse processing.
2. Fetches the person's last 30 days of pulses.
3. Sends to LLM: "Extract themes, passions, traits from these pulses."
4. Updates Person node properties (passions, fieldsOfCare, traits).
5. Regenerates Person embedding with enriched profile data.

---

## WF-06 — Resonance Discovery

**Actors:** Vercel Cron Job (daily schedule)

1. Finds all pulses created or modified since the last discovery run.
2. For each pulse, performs vector similarity search (cosine > 0.7).
3. Groups similar pulses into clusters.
4. Sends clusters to LLM for pattern analysis.
5. LLM returns: label (e.g., "grief"), description, and connections with confidence scores.
6. Creates `FieldResonance` node for the pattern (if new).
7. Creates `ResonanceLink` nodes between pulse pairs with confidence and evidence.
8. Links are created with status `pending` — awaiting human review.

---

## WF-07 — Human Resonance Review

**Actor:** Authenticated User

1. User views pending resonances via the review interface (`GET /api/resonance/review`).
2. For each AI-generated link, sees: source pulse, target pulse, resonance label, confidence, and evidence.
3. User takes one of three actions:
   - **Confirm** — marks the link as `confirmed`.
   - **Edit** — adjusts confidence, rewrites evidence, then confirms.
   - **Reject** — marks the link as `rejected`.
4. Review metadata stored: `reviewedBy`, `reviewedAt`, `editedBy`.

---

## WF-08 — WeSpace Collaboration

**Actor:** Space Owner + Members

1. Owner creates a WeSpace (see WF-02).
2. Owner invites members — each gets a `SpaceMembership` with a role (ADMIN / MEMBER / GUEST).
   - **Existing User:** gets a token-free "you've been added" email deep-linking into the space.
   - **Not yet registered (GOAL-329):** a placeholder `Person` (no `:User` label) is created/resolved by email, the `SpaceMembership` is created immediately, and a **single-use invite link (7-day expiry)** is emailed. The raw token only exists in the email; only its sha256 hash is stored on the Person. Accepting the link (`/auth/accept-invite`) collects name + password, promotes the Person to `:User`, creates their MeSpace, and signs them in to the invited space.
   - **Re-adding a pending invitee re-mints + re-sends the link** — this is the recovery path for expired, overwritten, or lost invite links. The pending membership's role is never changed by a re-invite. Emailed links are built via `resolveAppBaseUrl` (never a raw `NEXT_PUBLIC_BASE_URL`), so they always point at the deployment whose DB minted the token.
3. Members can browse the space's FieldContexts and pulses (based on role permissions).
4. ADMIN and MEMBER roles can create pulses within shared FieldContexts.
5. Resonances form across contributions from different members.
6. Owner or ADMIN can manage membership (add/remove members, change roles).

---

## WF-09 — Data Import

**Actor:** Authenticated User

1. User navigates to the import page.
2. Uploads a CSV or XLSX file.
3. System parses the file (Papa Parse for CSV, XLSX library for Excel).
4. Data mapped to GoalPost entities (Persons, Pulses, etc.).
5. Entities created in Neo4j with appropriate relationships.
6. Import status tracked and reported to user.

## WF-10 — Document Ingestion (FieldContext)

**Actor:** Authenticated User with `canEditContent` on the parent Space.

See ADR-014 (dedicated extraction endpoint) and ADR-015 (Document + blob storage + `EXTRACTED_FROM` edges) in `kb/06-adr.md` for rationale.

1. User picks a `.txt` / `.md` / `.pdf` from the studio with a
   FieldContext focused. **Two entry points open the same modal**, both
   gated on `canEditContent`:
   - The **bottom floating canvas action bar** → the **Upload** dropdown →
     **Upload document** (`field-context-upload-action.tsx`). This is the
     primary one; it shares that dropdown with **Import articles** (WF-11).
     Upload is *not* in the FieldContext page header.
   - The Pulses section's **empty-state secondary CTA** ("Upload a
     document", `pulses-section.tsx`) on the FieldContext page — shown only
     while the field has no pulses.

   Both converge on one client flow
   (`src/lib/ingest/upload-document-flow.ts`, GOAL-337 — the page briefly
   carried a drifted pre-GOAL-292 copy): POST
   `/api/ingest/document/presign` to get a short-lived presigned PUT URL,
   then upload the file **directly to S3** (bytes never traverse our
   server), then POST `/api/ingest/document/process` to **enqueue**
   extraction. (The legacy GraphQL `uploadDocument` mutation has been
   removed — see ADR-015.)
2. The process endpoint gates on `canEditContent`, anchors a Document
   node to the FieldContext via `HAS_DOCUMENT` and to the uploader via
   `UPLOADED_BY`, stamps the S3 `blobKey`, sets `status = 'PENDING'`, and
   returns **202 Accepted** immediately (GOAL-292). Nothing has been read
   or extracted at this point.
2b. **`/api/cron/process-document-ingestion` (every minute) does steps 3–7.**
   It claims PENDING documents with a conditional transition to
   `PROCESSING` that is safe against overlapping runs, then runs the shared
   pipeline as the **persisted uploader** — the worker holds no JWT, so the
   `UPLOADED_BY` edge written at step 2 *is* the captured authorization
   decision. It finishes by setting `COMPLETE`, or `FAILED` with member-safe
   `statusMessage`. A claim stranded by a killed worker is reclaimed after
   15 minutes and abandoned to `FAILED` after 3 attempts, so nothing spins
   forever. Status lifecycle: `kb/04-state-machines.md`.
   Instead of blocking on the response, the upload flow follows the ingest
   client-side (`src/lib/ingest/watch-document-ingest.ts`): a narrow
   `Document.status` projection is polled every 3s for up to 8 minutes,
   driving one evolving toast (uploaded → extracting → entity counts on
   COMPLETE, member-safe `statusMessage` on FAILED) and opening the ingest
   thread when the run lands. The Queued / Extracting / Failed chip on the
   document row advances during the watch because both queries normalise
   onto the same Apollo `Document:<id>` cache entry. There is **no standing
   poll outside an active upload** — after a page reload mid-ingest, the
   chip shows the status as of the last fetch and updates on the next
   refetch. This replaced the original synchronous orchestrator, which held
   the whole LLM pipeline inside the request and was the source of every
   observed 504 (`maxDuration = 300` was the stopgap).
3. A dedicated extraction model (independent of the chat assistant; may
   be reasoning — `kb/07-ai-assistant-ux.md` Rule 6) reads the document
   alongside the FieldContext roster (persons + pulses + **organizations**)
   and proposes Persons, Organizations, and FieldPulses — plus, per pulse,
   the people/orgs *related to* it (GOAL-298). PDFs route through Gemini
   multimodal via a freshly minted presigned GET URL (`file_data.fileUri`);
   `.txt`/`.md` route through OpenAI against the decoded body.
4. A fresh ConversationThread titled `Ingest: <filename>` is created
   (`kind = 'ingest'`, `mode = 'default'`). The thread is linked back to
   the source Document via `HAS_INGEST_THREAD`.
5. In parallel with the entity extractor, a separate **summarizer** model
   call produces a 1-paragraph synopsis + up to 5 concept phrases. Both
   are persisted on the Document node (`summary`, `concepts`). Failure is
   non-fatal — the upload still lands with empty values.
6. Every proposed tool call is **auto-executed** server-side via
   `executeAuthorizedWriteTool` — the same path manual creation uses.
   Auto-approve replaced the original HITL-gated flow because the upload
   itself already gates on `canEditContent` and the "upload + nothing
   happens until you click Approve" experience was the most common
   confusion point. Each created entity gets:
   - an `EXTRACTED_FROM` edge from the Person/Organization/FieldPulse to
     the Document,
   - one `:Log` row attributed to the uploader via `CREATED_BY`,
     stamping `metadata.documentId` + `metadata.conversationThreadId`.

   Tool calls run in the order persons → organizations → pulses →
   `link_entity_to_pulse` (MENTIONED_IN). The single pulse author is linked
   via `INITIATED_BY`; every other person/org the extractor named as related
   to a pulse is linked to it via `MENTIONED_IN`, with endpoints resolved by
   name/title from the entities created earlier in the same run. Attribution
   also rides on `update_pulse` (GOAL-318): when a re-extract or a second
   document matches an existing pulse, the write re-points `INITIATED_BY` at
   the credited author — but only when the pulse's current author is the
   acting uploader or absent, so corrected default attribution never steals
   authorship a different person already holds.
7. A synthesized assistant turn carries the **execution result** of each
   tool call (not a pending-approval payload). The chat panel auto-
   switches to the new ingest thread so the user sees a record of what
   ran, plus a one-line "Created N entities" header. Partial failures
   render per-row.

   This auto-switch is **in-session only** — a client-side event
   (`emitOpenAssistantThread`, `src/lib/simulation/assistant-panel-events.ts`)
   that the studio shell subscribes to. Ingest does **not** pin the thread
   server-side: on the member's *next* load the chat panel opens on an empty
   conversation (GOAL-345) and this thread is simply listed first in the
   switcher. That matters most for the cron worker, which finishes ingests
   while nobody is watching — previously every subsequent load dropped the
   member into an "Uploaded ….pdf" thread they never opened.
8. Re-extract reuses the stored blob + original hint, creates a new
   ingest thread, refreshes the summary + concepts, and auto-executes
   the new proposals. Delete removes the blob and Document node;
   extracted entities survive (their `EXTRACTED_FROM` edges drop with
   the Document). In the same transaction the delete also nulls
   `location` on surviving pulses whose stored value parses (via
   `parseDocumentDownloadLocation`) to the deleted document's durable
   download locator, and writes an attributed `:Log` for the clearing
   (GOAL-321) — extracted or manually set locations that aren't this
   document's locator are never touched. A stale locator that survives
   elsewhere (browser history, shared links) resolves to a friendly
   `/document-unavailable` page for browser navigations; API callers
   keep the JSON 404.
9. Extracted pulses flow through the existing post-creation embedding and
   enrichment jobs (WF-05) and become eligible for daily resonance
   discovery (WF-06) without any ingest-specific pipeline.

### WF-10 v1 implementation constraints

- **Accepted formats.** `text/plain`, `text/markdown`, `application/pdf` only. Hard size cap ~20 pages / ~50K characters of extracted text. `.docx`, `.xlsx`, image OCR, and audio transcription are v2 candidates.
- **Pulse types extracted.** `GoalPulse`, `ResourcePulse`, `StoryPulse` only. `CarePulse` and `CoreValuePulse` remain manual-only (StoryPulse absorbs the legacy Care + CoreValue concepts).
- **Organizations are captured (GOAL-298).** Named organizations / groups / cooperatives are extracted as first-class `:Organization` nodes (`create_organization`), attached to the FieldContext via `HAS_ORGANIZATION`, and idempotent by name-within-context. Full first-class org modelling beyond upload-time capture (Living-System / LifeSensor sub-classes) is a follow-up.
- **Durable source link on extracted pulses (GOAL-283 / GOAL-316).** Every pulse created from a document — `GoalPulse`, `ResourcePulse`, and `StoryPulse` alike — gets `location` auto-populated with the durable Space-scoped download URL (`/api/ingest/document/<id>/download`) when the extractor read no explicit location from the text. `location` is the **user-facing** provenance surface (the UI renders it as an opaque "Open document" action per GOAL-302, never the raw URL); the `EXTRACTED_FROM` edge remains a graph-only audit trail. An extracted or manually set location is never clobbered.
- **Deduplication is in-extractor.** The ingest worker pre-loads the FieldContext roster (persons + pulses + organizations, projected to id + name + minimal context) and inlines it in the model prompt; the model emits `update_person` / `update_pulse` for roster matches rather than creating duplicates (orgs dedup at write time by name-in-context).
- **Partial persons are skipped.** `create_person` / `update_person` is emitted only when both `firstName` AND `lastName` can be confidently filled. First-name-only / initial-only / role-only mentions are listed in the assistant's free-text reply for manual follow-up — but a single-name mention that is actually an organization is routed to `organizations`, not dropped.
- **No auto-`CONNECTED_TO`.** Extraction does not create `CONNECTED_TO` edges between the uploader and extracted Persons. `EXTRACTED_FROM` records "this person came from a doc the user has"; `CONNECTED_TO` remains a deliberate user gesture.
- **Failure path.** On extraction failure (model error, malformed output, empty result), the synthesized assistant turn carries a plain-text "Extraction failed" / "Nothing to extract" message. The Document persists; re-extract is the uniform retry path. A failure *before* the model runs (unreadable blob, unsupported type, oversize, parse error) never produces a thread — it lands the Document in `status = 'FAILED'` with member-safe `statusMessage`, rendered as a Failed chip plus an inline error on the document row. Re-extract is blocked while a document is `PENDING`/`PROCESSING`, since a second pipeline would double-write its summary and thread.
- **Re-upload semantics.** Uploading the same file again creates a new `Document` node with its own ingest thread — no file versioning in v1.

---

## WF-11 — Bulk Article Import (FieldContext)

**Actor:** Authenticated User with `canEditContent` on the parent Space.

Spreadsheet-driven bulk upload of articles as pulses (GOAL-317), made durable
in GOAL-326. See ADR-019 in `kb/06-adr.md` for why the job lives in the graph
rather than on Redis, and `kb/04-state-machines.md` for the status machine.

1. The member opens the import modal and picks a `.csv` / `.xlsx` where each
   row is an article — title, author, date, URL, plus optional
   `author_email` / `pulse_type` / `description` / `resource_type` /
   `source_url` (the last two added in GOAL-355). Parsing, header mapping and
   per-row validation happen **in the browser** (`article-import.ts`), so the
   preview step can show exactly what will and will not import.

   **Two entry points open the same modal**, both gated on `canEditContent`:
   - The **bottom floating canvas action bar** → the **Upload** dropdown →
     **Import articles** (`field-context-upload-action.tsx`, GOAL-327). This is
     the primary one. Upload is *not* in the FieldContext page header.
   - The **Pulses** section header pill inside the FieldContext page
     (`pulses-section.tsx`, `onImportArticles`).

   The action-bar item emits `emitOpenImportArticlesModal`; the FieldContext
   page owns the modal itself (it holds the post-import refetch wiring and
   loads it dynamically so SheetJS stays out of the dashboard bundle).
2. The preview is the human-in-the-loop gate: valid rows, rows with issues,
   and the file name. Nothing has been written yet. Confirming POSTs the typed
   rows to `/api/import/articles`.
3. That request **enqueues and returns 202** with a job id. It authenticates,
   applies the `bulk-import` rate limit (10/hour/account), re-runs the same
   validation server-side, gates on `canEditContent`, checks the per-account
   in-flight cap (5), and anchors an `:ArticleImportJob` as `PENDING`, linked to
   the FieldContext by `HAS_IMPORT_JOB` and to the member by `REQUESTED_BY`.
   Missing and forbidden contexts share one message, so the response cannot be
   used to probe other people's Spaces.
4. **`/api/cron/process-article-imports` (every minute) does the work.** It
   reclaims stalled claims, claims `PENDING` jobs with a transition that is safe
   against overlapping runs, re-validates the requester's `canEditContent`
   *live*, then walks the rows from the resume cursor. Each row goes through
   `executeAuthorizedWriteTool` — the same audited path chat HITL and document
   ingestion use — so it inherits the enrich-don't-duplicate idempotency, the
   `INITIATED_BY` attribution guard, and one `:Log` per write attributed to the
   requester. A failing row never aborts the batch.
5. Author resolution per row: email match first, scoped to the member's
   relational world (themselves → people already in the context → their
   `CONNECTED_TO` contacts, which are attached to the context under the
   GOAL-275 target gate), then the name path via `create_person`, which
   self-links, enriches, or mints a `PersonPulse`. Results are cached per run,
   so a 50-row sheet by one author resolves once.
5b. **The row's link is read (GOAL-344).** Once the row's pulse has landed, the
   worker fetches the URL (`article-url-fetcher.ts` — http(s) only, a
   validating DNS lookup at connect time that refuses loopback / private /
   link-local / metadata addresses, per-hop redirect re-validation, a 20s
   whole-chain deadline, 2 MB for pages / 15 MB for PDFs, and only HTML / plain
   text / PDF accepted; OneDrive share links are resolved to the file with
   `download=1` and the chain's own cookies; a link that fails is not retried
   by later rows of the same run),
   reduces HTML to article text (`article-html-text.ts`), stores the result as
   a `Document` on the field exactly like an upload (`sourceUrl` set, hint =
   the row's title/author/date/link, anchored `PROCESSING` so the document
   cron cannot claim it), and runs the same `runDocumentIngestPipeline` WF-10
   uses — summary, ingest thread, auto-executed persons / organizations /
   pulses with `EXTRACTED_FROM` provenance and one Log per write. The row's
   pulse is in the roster, so the extractor updates it; as a deterministic
   floor the worker also links it `EXTRACTED_FROM` the document and, when its
   body is still the sheet placeholder (the seeded sentence or a bare URL),
   fills it from the document summary. The outcome records what the article
   yielded (`extraction`). A link that cannot be read fails **only that half**:
   the pulse stands on the sheet's details and the outcome carries member-safe
   copy saying why. `sourceUrl` is the idempotency key — a re-uploaded sheet
   never fetches the same article into a field twice.
6. Each row's outcome is persisted **before the next row starts**. That list is
   the resume cursor and the source of every summary count, so a worker killed
   mid-batch resumes where it stopped instead of re-walking the sheet. A run
   that is out of time hands the job back to the queue and the next tick
   continues it.
7. The worker lands the job in `COMPLETE` (or `FAILED` with member-safe
   `statusMessage`) and then runs the embedding + resonance sweep
   (`runContextResonanceDiscovery`) for any context that gained pulses —
   **awaited, in the worker**, not fired at a request that has already answered.
   Imported articles therefore surface in search and resonance without waiting
   for the nightly cron. A run that yields with rows remaining kicks the next
   sweep itself (`kickQueueWorker`), so a long sheet keeps moving on dev/demo
   where scheduled ticks are far apart.
8. The modal polls `GET /api/import/articles/<jobId>` and shows Queued →
   Importing (with a row-count meter) → the per-row result summary. Closing it
   does not cancel anything; the job id is remembered per field, so reopening
   Import Articles returns to the running import. Reads are requester-scoped.

### WF-11 implementation constraints

- **300 rows per sheet** (`MAX_ARTICLE_IMPORT_ROWS`), unchanged by the move to a
  queue: it bounds one job's share of the shared worker and the size of the
  payload the job node carries. Larger backlogs are several jobs, which now
  drain reliably rather than racing a request ceiling.
- **Pulse types.** `ResourcePulse` (the default — articles are resources),
  `GoalPulse`, `StoryPulse`. `ResourcePulse` rows also get a `resourceType`,
  from the sheet's `resource_type` column when present and `'article'` when not.
- **`resource_type` and `source_url` (GOAL-355)** are the two optional columns
  that replaced a pair of member workarounds. Before them the type was appended
  to the title as free text ("The World Ending Fire - book") and the source link
  was parked in `description`, where the article read (step 5b) could overwrite
  it — a bare-URL body counts as a placeholder, so the AI summary replaced it.
  - `resource_type` → `ResourcePulse.resourceType`, lower-cased and
    whitespace-collapsed (`normalizeArticleResourceType`) so "Book" and "book"
    are one filterable value. Deliberately **not** an enum: the SDL declares
    `resourceType: String!` and GOAL-354 keeps it extensible, so a member's own
    vocabulary ("ontology", "zine") imports rather than failing the row.
  - `source_url` → `ResourcePulse.sourceUrl`, a property of its own — where the
    resource was *found* (a LinkedIn post, a newsletter), as distinct from
    `location`, which is the resource itself. Nothing in the ingest path writes
    it, so the summary can never eat it. Validated with the same
    `normalizeArticleUrl` the `url` column uses; a present-but-unusable value
    fails the row in the preview rather than being silently dropped.
  - Both are **additive**: a sheet with neither column parses, validates, and
    writes exactly as it did before GOAL-355. The aliases are deliberately
    narrow (`resource_type`/`resourcetype`, `source_url`/`sourceurl`) because a
    present-but-unusable value fails the row — a wider alias like `source_link`
    would newly break a sheet that already keeps provenance prose under that
    header.
  - Both are **ResourcePulse-only**, since that is the one pulse type declaring
    them. A goal/story row carrying either column fails in the preview rather
    than importing and silently dropping the value.
  - **Re-importing does not RE-type an existing pulse.** `create_pulse`'s
    enrich branch is fill-gaps-only (`coalesce`), so a pulse the importer
    already created carries `resourceType: 'article'`, and a re-upload with
    `resource_type: book` leaves it as `'article'` — while `sourceUrl`, which
    was null, does get backfilled. The receipt still says "kept it and filled
    in any missing details", which is true but easy to over-read. Correcting
    the type of an already-imported pulse is an edit, not a re-import.
- **`location` and `time`** carry the article's URL and normalized date. A date
  that isn't a calendar date ("Spring 2026") survives verbatim rather than
  failing the row. Pulses the extractor adds from the article default their
  `location` to the article URL (not our stored copy's download locator).
- **Rows are slow now (GOAL-344).** A row is a fetch (≤40s) plus the extraction
  and summary model calls (aborted at 90s) plus the entity writes, so the
  worker's row deadline is 120s and its claim deadline 100s of the 300s
  function: a freshly claimed job always gets at least one row, and a row that
  starts at the deadline still lands. A 300-row sheet spans many ticks — that
  is the design, not a stall.
- **What the fetcher refuses** is reported per row, never raised: login walls
  (LinkedIn, paywalls), JavaScript-only pages, pages without readable text,
  non-article content types, oversize responses, unreachable hosts, and any
  address the SSRF policy blocks.
- **Retry is re-upload.** A `FAILED` job is terminal; re-uploading the same
  sheet is safe because rows that already landed come back as
  `skipped_existing` (having filled in any missing details).

---

## WF-12 — Promise Weave Authoring (GOAL-341)

**Actor:** Space Owner, ADMIN, or MEMBER (`canEditContent`). GUESTs see weaves
but get no write affordance, and the server refuses them anyway.

A **PromiseWeave** is a reified connector node — not a pulse — that gathers the
pulses and the person a promise implicates, so opening it is a starting point
for exploration rather than a dead end (`kb/01-glossary.md`). Until GOAL-341
weaves existed only where the prod→dev migration had built them.

1. Member opens a FieldContext detail page and uses **"Weave"** in the Promise
   weaves section (`PromiseWeavesSection`). The affordance is disabled while
   the field has no pulses — a weave must hold at least one.
2. The dialog (`PromiseWeaveModal`) takes a name, an optional "why", a
   multi-select of the field's pulses, and optionally the Person it is
   **woven for**. Candidates are scoped to that field, so a member can only
   weave what they can already see there.
3. `createPromiseWeaves` writes the node with `status: 'active'` and
   `origin: 'user'`, connecting `WEAVES` → the chosen pulses, `WOVEN_FOR` → the
   person, and `HAS_WEAVE` ← the FieldContext. **That context edge is the
   visibility anchor and the path the `@authorization` filter traverses** — a
   weave without it is both invisible and ungated.
4. Editing re-drives the same dialog; the woven set is *reconnected*, not
   appended, so unticking a pulse removes it. Deleting removes the connector
   node and its edges only — the pulses and the person are untouched.
5. Every runtime write logs an activity `Log` via `logWeaveActivity`
   (created / updated / confirmed / dissolved / fulfilled / deleted).
   Migration-built weaves stay Log-exempt, like the other Phase-5 structural
   builds.
6. Rows open the entity-info drawer; AI-proposed weaves (`proposed`) instead
   render an inline **Confirm / Dismiss** gate — see `kb/04-state-machines.md`
   and WF-13. Marking a weave `fulfilled` has no affordance yet; the state
   exists but nothing in the UI reaches it.

### WF-12 implementation constraints

- **`weaves` targets the `FieldPulse` interface.** Connect many pulses with ONE
  `connect` entry using `id_IN`; two or more entries make `@neo4j/graphql`
  emit a duplicate Cypher variable and Neo4j rejects the mutation (`42N07`).
  Full note in `kb/05-data-entities.md`.
- **Status is lowercase and null means `active`,** never `proposed` — read it
  through `normalizeWeaveStatus` (`src/lib/promise-weave.ts`).
- Write logic lives in `src/hooks/usePromiseWeaves.ts` so the field-context
  page and any later surface cannot drift on the connect/disconnect shapes.
