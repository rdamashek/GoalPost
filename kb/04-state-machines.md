# State Machines

Valid states and transitions for core entities in GoalPost.

## FieldContext Lifecycle (GOAL-319)

```
Live → Soft-deleted → (purged after 90 days)
```

| State        | Marked By                                                                                   | Trigger                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Live         | `deletedAt` absent; `(Space)-[:HAS_CONTEXT]->(ctx)`                                          | Creation                                                                |
| Soft-deleted | `deletedAt` set on the context AND its pulses; Space edge re-pointed to `HAS_DELETED_CONTEXT` | `deleteFieldContext` mutation / assistant `delete_field_context` (owner or ADMIN only) |
| Purged       | Node and all nested entities removed from the graph                                          | Daily `/api/cron/purge-deleted-contexts` once `deletedAt` > 90 days old  |

Deleting a context CASCADES over its nested sub-context subtree (GOAL-295):
every live descendant reached via `HAS_SUBCONTEXT*` is soft-deleted in the
same transaction (own `deletedAt` stamp + own Space-edge re-point), so a
parent can never be hidden while its children stay visible. A sub-context
deleted on its own leaves its ancestors untouched; the `HAS_SUBCONTEXT`
overlay edge survives soft delete and drops at purge (`DETACH DELETE`).

Soft-deleted content is invisible to every read surface (all access flows
through `HAS_CONTEXT`). There is no user-facing restore; within the 90-day
window an operator can manually reverse the stamp + edge. The transition is
one-way per surface — nothing moves a purged context back.

---

## GoalPulse Status

```
ACTIVE ⇄ PAUSED → COMPLETED
ACTIVE → COMPLETED
```

| Status      | Description                     |
| ----------- | ------------------------------- |
| `ACTIVE`    | Goal is being actively pursued  |
| `PAUSED`    | Goal is on hold, may be resumed |
| `COMPLETED` | Goal has been achieved          |

---

## GoalPulse Horizon

Not a state machine — a classification of time scope:

| Horizon | Description           |
| ------- | --------------------- |
| `SHORT` | Near-term objective   |
| `MID`   | Medium-term objective |
| `LONG`  | Long-term aspiration  |

---

## ResonanceLink Status

```
Pending → Confirmed
Pending → Rejected
```

| Status      | Description                                 | Who Triggers              |
| ----------- | ------------------------------------------- | ------------------------- |
| `pending`   | AI-generated, awaiting human review         | Resonance Discovery Job   |
| `confirmed` | Human reviewed and confirmed the connection | User via review interface |
| `rejected`  | Human reviewed and rejected the connection  | User via review interface |

---

## PromiseWeave Status

```
Proposed → Active → Fulfilled
Proposed → Dissolved
Active   → Dissolved
```

| Status      | Description                                         | Who Triggers                          |
| ----------- | --------------------------------------------------- | ------------------------------------- |
| `proposed`  | AI-proposed, awaiting human confirmation            | The assistant's `propose_promise_weave` tool (GOAL-342) |
| `active`    | Live — member-authored, or a confirmed proposal     | Member via the Promise weaves section |
| `fulfilled` | The promise it holds has been kept                  | **No surface yet** — see the note below |
| `dissolved` | Withdrawn, or a proposal the member declined        | Member via the Promise weaves section |

Stored **lowercase**, matching `ResonanceLink.status` rather than the uppercase
convention Document ingest uses.

**`fulfilled` has no affordance yet (GOAL-341).** The value is defined in
`src/lib/promise-weave.ts`, accepted by `setStatus`, and mapped in the activity
log — but no button in the Promise weaves section or the drawer triggers it, so
`active → fulfilled` is currently reachable only through the API. Do not read
the table above as a description of shipped UI for that row.

**Transitions are not enforced server-side.** `status` is a free String with an
open `status_SET`, so the illegal moves this table omits (`fulfilled → proposed`,
`dissolved → active`, or an arbitrary value) are refused only by the UI, which
offers legal moves alone. `ResonanceLink.status` has the same shape. Anything
reading a weave's status must go through `normalizeWeaveStatus`.

**Legacy values exist — do not compare the raw string.** The starting-point
weaves the prod→dev migration built (GOAL-266) predate this lifecycle and carry
the legacy CarePoint status verbatim, casing and all. Dev holds `"Active"` (5),
`"Inactive"` (3) and `"active"` (1) across its 9 weaves. So:

- Comparison is **case-insensitive**, and `inactive` is a recognised legacy
  alias classified as `dissolved`.
- **Null reads as `active`, never as `proposed`** — treating a missing status as
  proposed would park every migrated care point behind a confirmation gate it
  was never meant to have.
- An unrecognised value is **displayed verbatim** rather than renamed into a
  lifecycle state it never meant; only `proposed` gates, so classifying it as
  `active` for logic is safe.

`normalizeWeaveStatus` (logic) and `getWeaveStatusLabel` (display) in
`src/lib/promise-weave.ts` are the single place those rules live — read status
through them rather than comparing the raw string.

Only `proposed` is a gate: it is the human-in-the-loop step for AI-proposed
weaves, and the section renders Confirm / Dismiss on exactly those rows.
Member-authored weaves are born `active` — the member IS the human in the loop.

**An AI proposal passes TWO gates, and both are load-bearing (GOAL-342).** The
assistant's `propose_promise_weave` is a write tool, so the member first
approves it on the HITL card (`kb/07` Rule 5) — nothing is written until they
do. What that approval creates is a `proposed` weave, which is *not* an
established connection: it must not be counted, aggregated or narrated as one,
and only a member's Confirm in the field's "Promise weaves" section promotes it
to `active`. Dismiss moves it to `dissolved`. Collapsing the two — writing
`active` straight from the approved tool call — would leave a proposal
indistinguishable from an agreed weave, which is the failure this whole state
exists to prevent.

Both transitions out of `proposed` re-authorize server-side on the acting
member — Owner / ADMIN / MEMBER, the same rule `canEditContent` encodes
elsewhere, though the confirm/dismiss path does not call that helper: it goes
through `updatePromiseWeaves` and is gated by `PromiseWeave`'s own
`@authorization` validate rules, not by anything the client asserts. A GUEST
can read a proposal but can neither confirm nor dissolve it.

---

## Space Visibility

Not a state machine — a configuration setting:

| Visibility | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| `PRIVATE`  | Only visible to owner (MeSpace) or owner + members (WeSpace) |
| `SHARED`   | Discoverable by others (future feature)                      |

---

## SpaceMembership Role

Not a state machine — an assigned role within a WeSpace:

| Role     | Description                                                  |
| -------- | ------------------------------------------------------------ |
| `ADMIN`  | Full control — manage members, edit content, view everything |
| `MEMBER` | Contribute pulses and view content                           |
| `GUEST`  | View-only access                                             |

---

## User Onboarding

```
Not Started → In Progress → Completed
                          → Skipped
```

| State       | Tracked By                                                                         |
| ----------- | ---------------------------------------------------------------------------------- |
| Not Started | `onboardingCurrentStepIndex = 0`, `onboardingIsCompleted = false`                  |
| In Progress | `onboardingCurrentStepIndex > 0`, steps accumulating in `onboardingCompletedSteps` |
| Completed   | `onboardingIsCompleted = true`                                                     |
| Skipped     | `onboardingSkipped = true`                                                         |

---

## Document Ingest Status (GOAL-292)

> **GOAL-354 rename — the code has moved, the data has not.** This machine now
> lives on `ResourcePulse.ingestStatus`, not `Document.status`
> (`ResourcePulse.status` already exists with the pulse's own unrelated
> meaning), and the staleness clock is `ingestStatusUpdatedAt`. The states,
> guards, claim fencing and attempt cap are all unchanged — only the node and
> the property names moved. Read every `Document.status` below as
> `ResourcePulse.ingestStatus`.
>
> **Ingestion therefore does not work against an unmigrated database.** The
> queue seeks `(:ResourcePulse {ingestStatus: …})`, and until
> `scripts/migrate-document-to-resource.ts` has run, the environment's documents
> are still `:Document` nodes the queue cannot see. That is the cutover: deploy
> the code, drain the queue, migrate. The script refuses to run while anything
> is `PENDING`/`PROCESSING`, because a document that loses its `:Document` label
> mid-flight can never be claimed, reclaimed or completed.

```
PENDING → PROCESSING → COMPLETE
                     → FAILED
```

`Document.status` is both the lifecycle and the work queue — there is no
separate job node, because the Document already carries everything the worker
needs (`blobKey`, `mimeType`, `userHint`, parent FieldContext, uploader).

| Status       | Set By                                              | Meaning                                                                 |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `PENDING`    | `POST /api/ingest/document/process` (anchor + 202)  | File is in blob storage and queued; nothing extracted yet               |
| `PROCESSING` | `/api/cron/process-document-ingestion` on claim     | A worker owns this document and is running extraction + summarization   |
| `COMPLETE`   | The worker, a re-extract, or the inline test path    | Entities written, summary stored, ingest thread created                 |
| `FAILED`     | Same three writers, on unrecoverable error          | `statusMessage` holds member-safe copy; Re-extract (GOAL-241) recovers  |

Two `FAILED` reasons are owned by the worker rather than the pipeline, and both
are security-relevant: the document has **no single `UPLOADED_BY` uploader** (so
no identity to attribute writes to), or the uploader **lost `canEditContent`
between enqueue and the claim**. The `UPLOADED_BY` edge captures the
authorization decision, but the worker re-validates it live before spending
anything — see `kb/03-workflows.md` WF-10 step 2b.

Rules:

- **Claiming is conditional.** The worker writes a throwaway `ingestLockToken`
  to force Neo4j's write lock, re-checks `status = 'PENDING'` *under* that lock,
  and only then stamps `ingestClaimedBy`. Neo4j is read-committed, so the naive
  `MATCH (d {status:'PENDING'}) SET d.status='PROCESSING'` loses updates and
  every overlapping cron run wins — measured at 11/12 trials, all 8 claimants.
  Even the by-id form loses updates: an index seek only becomes `Locking` when a
  write follows it. Never simplify that shape back.
  The lock is taken on `ingestLockToken` and **not** on `ingestClaimedBy`
  because the lock-forcing write commits even when the guard rejects the row —
  so a loser writing `ingestClaimedBy` would leave it naming a worker that does
  not hold the claim (measured correct in 0/6 contended trials before this was
  fixed). It has to stay truthful: it is what an operator reads to find the
  owner of a stuck document, and the terminal writes fence on it.
- **Stalled claims are recovered, not orphaned.** A `PROCESSING` document whose
  `statusUpdatedAt` is older than 15 minutes (longer than the 300s function
  ceiling, so a live run is never stolen) returns to `PENDING`, or lands in
  `FAILED` once `ingestAttempts` reaches 3. No document can spin forever.
- **Legacy documents have no `status` property.** Every read coalesces a missing
  value to `COMPLETE`, so pre-GOAL-292 uploads are never re-ingested and never
  render as stuck.
- Re-extract is blocked while a document is `PENDING`/`PROCESSING` — a second
  pipeline on the same document would double-write its summary and thread and
  double the model spend. Enforced **server-side** in `handleReExtractDocument`
  (reason `in_progress`), not just by the disabled button: re-extract does not go
  through the worker's claim, so a direct GraphQL call would otherwise bypass the
  mutual exclusion entirely. A successful re-extract also lands a fresh terminal
  status, so it genuinely clears a `FAILED` document rather than leaving stale
  failure copy on a row that now has entities.

---

## Article Import Job Status (GOAL-326)

```
PENDING → PROCESSING → COMPLETE
        ↑            → FAILED
        └── requeued (out of time, or a stalled claim reclaimed)
```

`:ArticleImportJob.status` is both the lifecycle and the work queue for bulk
spreadsheet article import. Unlike document ingestion — where `Document.status`
*is* the queue because the document already carries everything a worker needs —
a bulk import has no pre-existing entity to hang state on: the rows exist only
in the request. So the job node carries them. See ADR-019.

| Status       | Set By                                          | Meaning                                                              |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| `PENDING`    | `POST /api/import/articles` (anchor + 202)      | Rows are validated, gated, and queued; nothing written into the field |
| `PROCESSING` | `/api/cron/process-article-imports` on claim    | A worker owns this job and is minting pulses row by row               |
| `COMPLETE`   | The worker, once every row has an outcome       | Per-row outcomes are final; `rowsJson` is dropped                     |
| `FAILED`     | The worker, or the reclaim path at 3 attempts   | `statusMessage` holds member-safe copy; rows already imported stay    |

Three `FAILED` reasons are the worker's rather than a row's, and two are
security-relevant: the job has **no single `REQUESTED_BY` requester** (no
identity to attribute writes to), the requester **lost `canEditContent` between
enqueue and the claim**, or an unexpected crash. The `REQUESTED_BY` edge carries
the authorization decision across the queue boundary, and the worker
re-validates it live before spending anything — `kb/03-workflows.md` WF-11.

Rules:

- **Claiming is conditional**, in exactly the shape the document queue uses: a
  throwaway `lockToken` write forces Neo4j's write lock, the `status = 'PENDING'`
  guard is re-evaluated *under* that lock, and only the winner stamps
  `claimedBy`. Never simplify it back to
  `MATCH (j {status:'PENDING'}) SET j.status='PROCESSING'` — that loses updates
  and every overlapping run wins (measured: 24 racing claimants, all 24 won).
- **The claim FENCE needs the same lock-forcing write as the claim.** Every
  statement that reads `claimedBy` in a `WHERE` and then `SET`s — each outcome
  append and all three terminal writes — is itself a read-then-write, and Neo4j
  only takes the node lock at the `SET`. Without a throwaway `lockToken` write
  first, a run whose claim was revoked mid-statement evaluates the fence against
  the pre-revoke value and its write lands anyway (measured 2–3 of every 4).
  The worst case stamped `COMPLETE` onto a job another worker was still
  processing, so the member saw a successful import with rows silently missing
  and no error. Mirroring the claim's shape is not enough; mirror its *reason*.
- **`size(rowOutcomes)` is the resume cursor.** Outcomes are appended one per
  processed row, in row order, so the list length is how far the job got. There
  is no second counter that could disagree with it, and the summary is
  recomputed from the list on every read. **Exactly one outcome per row is the
  load-bearing invariant**: resolving a row and persisting its outcome are
  deliberately separate steps, because a failure path that also recorded would
  write two outcomes for one row — advancing the cursor by two and silently
  skipping an unprocessed row on the next tick.
- **Row counts survive a resume; people counts do not.** created / skipped /
  failed are stable, but the author cache starts cold on a resumed tick, so the
  first row for an author an earlier tick created comes back `matched` rather
  than `created`. One person can be counted once as new and once as matched.
  Making it exact would mean persisting an author identity on every row — more
  member PII in the job node than the count is worth.
- **Every outcome append is fenced on the claim.** A rejected append tells the
  worker it no longer owns the job, and it stops immediately: a zombie run
  minting pulses beside the new claimant would double-write every remaining row.
- **A run out of time requeues itself** (`PROCESSING → PENDING`, cursor intact),
  resetting `attempts` **only if it actually landed rows** — progress is what
  proves the job is not the poison-payload case the ceiling exists for. The
  yield is checked at the top of the row loop, so a job claimed near the run's
  claim deadline can yield having processed nothing; resetting there would let
  it be claimed, yield, and requeue forever without ever being abandoned. A
  300-row import may legitimately span several ticks.
- **Stalled claims are recovered, not orphaned.** A `PROCESSING` job whose
  `statusUpdatedAt` is older than 15 minutes returns to `PENDING`, or lands in
  `FAILED` once `attempts` reaches 3. The per-row outcome write refreshes that
  clock, so a job that is genuinely progressing is never stolen.
- **A `PENDING` job whose FieldContext was deleted is failed, not left.** Once
  the context is soft-deleted nothing can move the job — the drain skips it, the
  in-flight cap skips it, and the stale sweep only matches `PROCESSING` — so it
  would sit `PENDING` forever and the member's modal would poll forever. Enqueue
  refuses a soft-deleted context up front; the sweep covers the
  delete-after-enqueue window.
- **The stale sweep can requeue a job that is actually alive.** It reads
  `statusUpdatedAt` before it holds the lock, so a concurrent append that
  refreshes the clock may go unobserved (measured 3 of 4 trials). This degrades
  safely and is left alone: the displaced run's next append fails the claim
  fence, it stops, and at worst one row is processed twice — which the
  enrich-don't-duplicate write tools absorb.
- **Retry is re-upload, not re-queue.** A `FAILED` job is terminal; the member
  uploads the sheet again. That is safe because every row goes through
  `create_pulse` / `create_person`, which enrich rather than duplicate — the
  rows that already landed come back as `skipped_existing`.

---

## Background Job States

### Pulse Processing Job

```
Queued → Processing → Completed
                    → Failed
```

### Person Enrichment Job

```
Queued → Processing → Completed
                    → Failed
```

### Resonance Discovery Job

```
Scheduled (cron) → Running → Completed
                           → Failed
```

---

## Assistant Mode

Not a state machine — a runtime toggle:

| Mode                 | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `default` (Standard) | Direct database answers, straightforward assistance  |
| `aiden`              | Questions assumptions, surfaces hidden frames        |
| `braider`            | Stays present with difficulty without rushing to fix |

Switched at any time via API parameter or UI selector. No persistent state between sessions (singleton in dev; session/DB in production).
