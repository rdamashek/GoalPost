/**
 * GOAL-354 — Remodel Document as a Resource subtype.
 *
 * A document is a *type of Resource*, not a node in its own right. This script
 * relabels every `:Document` in place into a `:FieldPulse:ResourcePulse`
 * carrying `resourceType: 'document'`, so the Resource becomes the focal point
 * for resonance and discussion and the file is just the source it points back
 * at. The bytes never move — they stay in S3; the graph keeps only the key/URL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A CUTOVER, NOT A STANDALONE MIGRATION. READ BEFORE RUNNING.
 * ─────────────────────────────────────────────────────────────────────────────
 * The migration removes `:Document`, deletes `HAS_DOCUMENT`, and renames
 * `status` → `ingestStatus` and `blobKey` → `sourceBlobKey`. Roughly 25 call
 * sites still match on exactly those three things, so running this before the
 * code slices land breaks them all. The worst are:
 *
 *   - `src/app/api/ingest/document/[documentId]/download/route.ts` matches
 *     `(c:FieldContext)-[:HAS_DOCUMENT]->(d:Document {id})` and returns
 *     `d.blobKey`. All three predicates die here, so EVERY document download
 *     404s — including the ~72 pulses whose `location` already points at that
 *     route, and the `location` this script writes onto each migrated node.
 *   - `src/lib/ingest/document-ingest-queue.ts` (`findPendingDocumentIds`,
 *     `reclaimStalledIngests`, `markDocumentIngestComplete`) matches
 *     `(d:Document)` on `d.status`. A document mid-ingest becomes invisible to
 *     the queue, unreclaimable, and unrecoverable — the exact stuck-forever
 *     state `kb/04-state-machines.md` says must not be possible.
 *   - `src/lib/ingest/handle-delete-document.ts` is the only path that removes
 *     the S3 blob and clears stale pulse `location`s.
 *
 * So `--execute` additionally requires `--cutover`, which is an assertion by the
 * operator that the ingest/download/delete slices are deployed to the target
 * environment. The script cannot verify that itself; the flag is the checkpoint.
 * It also refuses outright while any document is PENDING/PROCESSING — drain the
 * queue and pause the ingest cron first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why relabel in place rather than create-and-copy
 * ─────────────────────────────────────────────────────────────────────────────
 *   - The node keeps its `id`, so once the download route is re-anchored the
 *     existing `/api/ingest/document/<id>/download` locators resolve again
 *     rather than needing a rewrite pass over every pulse `location`.
 *   - Every inbound `EXTRACTED_FROM` edge (623 on demo, 408 on dev) survives
 *     untouched, so provenance cannot be half-migrated.
 *   - `HAS_INGEST_THREAD` and `UPLOADED_BY` keep pointing at the same node, so
 *     the audit history is preserved exactly as the ticket requires.
 *
 * Property renames are lossless. Two are not cosmetic:
 *   - `status` → `ingestStatus`. ResourcePulse already has a `status` field with
 *     an unrelated meaning (the pulse's own status). Left alone, every migrated
 *     document would read as a pulse whose status is literally "COMPLETE".
 *   - `statusUpdatedAt` → `ingestStatusUpdatedAt`. Same collision, and this is
 *     the staleness clock the ingest cron uses to reclaim dead claims.
 * `uploadedAt` is deliberately NOT renamed or removed: its value is copied to
 * `createdAt` and the original is retained as an undeclared property so the
 * upload timestamp survives independently of any later edit to `createdAt`.
 *
 * Behaviour this creates, so the next reader does not file it as a bug: every
 * migrated resource gets `CREATED_BY` → its uploader (pulses need a displayable
 * author; `resolvePulseAuthor` reads `initiatedBy[0] ?? createdBy[0]`). That
 * also means a later re-extract by a *different* member will not re-attribute
 * these pulses, because `reattributeIngestPulseAuthor` refuses to overwrite a
 * `CREATED_BY` held by someone other than the acting user. That is the intended
 * "never steal authorship" rule, applied to ~600 nodes at once.
 *
 * Idempotent: only ever matches nodes that still carry `:Document`, and every
 * write is `coalesce`-guarded. `graph.query` issues one auto-commit transaction
 * per statement, so the relabel is all-or-nothing.
 *
 * Dry-run by DEFAULT. Nothing is written without BOTH `--execute` and
 * `--cutover`.
 *
 *   npm run migrate:document-to-resource:demo                      # report only
 *   npm run migrate:document-to-resource:demo -- --execute --cutover
 *
 * Production has zero `:Document` and zero `:ResourcePulse` nodes (verified
 * 2026-09-08), so this is a no-op there; demo and dev are the real targets.
 */

import 'dotenv/config.js'
import { initGraph } from '../src/modules/graph.js'

/**
 * Neo4j integers come back from the LangChain graph wrapper as strings
 * (`count()` → `"5"`), so every numeric read has to be coerced explicitly —
 * `.low` is not present and arithmetic on the raw value silently concatenates.
 */
const num = (value: unknown): number => Number(value ?? 0)

const EXECUTE = process.argv.includes('--execute')
const CUTOVER = process.argv.includes('--cutover')

/**
 * Properties copied to a namespaced name and then dropped. Interpolated
 * directly into the REMOVE clause below so the list has exactly one definition
 * — these are literal identifiers from this file, never input, so there is no
 * injection surface.
 */
const RENAMED_KEYS = [
  'filename',
  'mimeType',
  'sizeBytes',
  'pageCount',
  'blobKey',
  'blobUrl',
  'userHint',
  'summary',
  'concepts',
  'status',
  'statusMessage',
  'statusUpdatedAt',
] as const

/** Only terminal documents are safe to migrate — see the cutover note above. */
const TERMINAL_STATUSES = ['COMPLETE', 'FAILED']

async function main() {
  const graph = await initGraph()

  console.log(
    `\nGOAL-354 — Document → ResourcePulse migration  [${
      EXECUTE ? 'EXECUTE' : 'DRY RUN'
    }]`
  )

  // `initGraph()` hardcodes `config({ path: '.env.local' })`. It picks up
  // .env.demo only because `dotenv/config` runs first via DOTENV_CONFIG_PATH and
  // dotenv never overrides an already-set variable — which means any variable
  // .env.demo omits silently falls through to the local value. Echo the
  // resolved target so an operator can never be wrong about what they are about
  // to rewrite.
  console.log(`  target : ${process.env.NEO4J_URI ?? '(NEO4J_URI unset)'}`)
  console.log(`  database: ${process.env.NEO4J_DATABASE ?? '(default)'}`)
  console.log(`  env file: ${process.env.DOTENV_CONFIG_PATH ?? '(none)'}\n`)

  // ---------------------------------------------------------------------------
  // Step 1 — Report what is about to change.
  // ---------------------------------------------------------------------------
  const [before] = await graph.query<Record<string, unknown>>(
    `
    OPTIONAL MATCH (d:Document)
    WITH count(d) AS documents
    OPTIONAL MATCH (:FieldContext)-[h:HAS_DOCUMENT]->(:Document)
    WITH documents, count(h) AS hasDocumentEdges
    OPTIONAL MATCH ()-[e:EXTRACTED_FROM]->(:Document)
    WITH documents, hasDocumentEdges, count(e) AS extractedFromEdges
    OPTIONAL MATCH (:Document)-[t:HAS_INGEST_THREAD]->()
    WITH documents, hasDocumentEdges, extractedFromEdges, count(t) AS ingestThreadEdges
    OPTIONAL MATCH (fetched:Document) WHERE fetched.sourceUrl IS NOT NULL
    WITH documents, hasDocumentEdges, extractedFromEdges, ingestThreadEdges,
         count(fetched) AS fetchedByImport
    OPTIONAL MATCH (r:ResourcePulse)
    RETURN documents, hasDocumentEdges, extractedFromEdges, ingestThreadEdges,
           fetchedByImport, count(r) AS resourcePulses
    `,
    {}
  )

  const documents = num(before?.documents)
  const fetchedByImport = num(before?.fetchedByImport)

  console.log('  Before:')
  console.log(`    :Document nodes .................. ${documents}`)
  console.log(`    HAS_DOCUMENT edges ............... ${num(before?.hasDocumentEdges)}`)
  console.log(`    EXTRACTED_FROM → :Document ....... ${num(before?.extractedFromEdges)}`)
  console.log(`    HAS_INGEST_THREAD edges .......... ${num(before?.ingestThreadEdges)}`)
  console.log(`    :ResourcePulse nodes (existing) .. ${num(before?.resourcePulses)}`)

  if (documents === 0) {
    console.log('\n  Nothing to migrate — no :Document nodes in this database.\n')
    return
  }

  // Bulk-import documents become a SECOND ResourcePulse alongside the row pulse
  // the import already minted with resourceType 'article' (WF-11 treats the
  // fetched source as enrichment of that row pulse, not a peer artifact). The
  // operator should see this count before writing — the two will sit side by
  // side in the Pulses section with no visible relationship, since the only edge
  // between them is EXTRACTED_FROM.
  if (fetchedByImport > 0) {
    console.log(
      `\n  ⓘ ${fetchedByImport} of these were fetched by the bulk article import` +
        `\n    (sourceUrl set). Each becomes a 'document' resource ALONGSIDE the` +
        `\n    'article' row pulse the import already created. Nesting fetched` +
        `\n    sources under the pulse they enriched is a later UI slice.`
    )
  }

  // A Document orphaned from its FieldContext would lose its Space anchor and
  // become an unreachable pulse, so surface it rather than migrating it blind.
  const orphans = await graph.query<{ id: string; filename: string }>(
    `
    MATCH (d:Document)
    WHERE NOT (:FieldContext)-[:HAS_DOCUMENT]->(d)
    RETURN d.id AS id, coalesce(d.filename, '(no filename)') AS filename
    `,
    {}
  )

  if (orphans.length > 0) {
    console.log(
      `\n  ⚠ ${orphans.length} document(s) have no FieldContext anchor and will be SKIPPED:`
    )
    orphans.forEach((o) => console.log(`      ${o.id}  ${o.filename}`))
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Pre-flight. Each of these is a refusal, not a warning.
  // ---------------------------------------------------------------------------
  const blockers: string[] = []

  // (a) In-flight ingests. The queue still matches (:Document) on d.status, so a
  //     PENDING/PROCESSING document loses its label mid-flight and can never be
  //     claimed, reclaimed, or completed again.
  const inFlight = await graph.query<{ status: string; count: unknown }>(
    `
    MATCH (d:Document)
    WITH coalesce(d.status, 'COMPLETE') AS status, count(*) AS count
    WHERE NOT status IN $terminal
    RETURN status, count
    `,
    { terminal: TERMINAL_STATUSES }
  )

  if (inFlight.length > 0) {
    const detail = inFlight
      .map((r) => `${r.status}=${num(r.count)}`)
      .join(', ')
    blockers.push(
      `${detail} document(s) are mid-ingest. Pause the ingest cron and let the ` +
        `queue drain — migrating these strands them permanently.`
    )
  }

  // (b) id collision. Document ids move onto :FieldPulse, which carries a
  //     uniqueness constraint (`pulse_id`). A collision would abort the whole
  //     relabel; better to report it than to discover it as a failed run.
  const [collisions] = await graph.query<Record<string, unknown>>(
    `
    OPTIONAL MATCH (d:Document)
    WITH collect(d.id) AS documentIds
    OPTIONAL MATCH (p:FieldPulse)
    WHERE p.id IN documentIds
    RETURN count(p) AS collisions
    `,
    {}
  )

  if (num(collisions?.collisions) > 0) {
    blockers.push(
      `${num(collisions?.collisions)} Document id(s) already exist as :FieldPulse ` +
        `ids. The pulse_id uniqueness constraint would abort the migration.`
    )
  }

  if (blockers.length > 0) {
    console.log('\n  ✗ Pre-flight failed:')
    blockers.forEach((b) => console.log(`      - ${b}`))
  }

  if (!EXECUTE) {
    console.log('\n  Dry run — no writes performed.')
    console.log(
      '  To apply: re-run with --execute --cutover, once the ingest, download,\n' +
        '  and delete slices are deployed to this environment.\n'
    )
    return
  }

  if (blockers.length > 0) {
    console.log('\n  Refusing to run. Resolve the above and re-run.\n')
    process.exitCode = 1
    return
  }

  if (!CUTOVER) {
    console.log(
      '\n  ✗ --execute requires --cutover.\n' +
        '\n  --cutover asserts that the code slices re-anchoring the ingest queue,\n' +
        '  the download route, and the delete path onto ResourcePulse are DEPLOYED\n' +
        '  to this environment. This script cannot verify that itself. Without\n' +
        '  them, every document download 404s the moment this completes.\n'
    )
    process.exitCode = 1
    return
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Relabel in place, map properties, rewrite the context edge.
  // ---------------------------------------------------------------------------
  console.log('\n  Migrating...')

  const [migrated] = await graph.query<Record<string, unknown>>(
    `
    MATCH (fc:FieldContext)-[hd:HAS_DOCUMENT]->(d:Document)

    SET d:FieldPulse, d:ResourcePulse

    // Pulse identity. Every migrated document is 'document' — an article
    // fetched by the bulk import already has its own row pulse carrying
    // resourceType 'article', so classifying the fetched source as 'article'
    // too would mint a second, directly competing article resource.
    // Normalising the resourceType vocabulary is its own slice.
    SET d.resourceType = coalesce(d.resourceType, 'document'),
        d.title        = coalesce(d.title, d.filename, 'Untitled document'),
        // content is String! — the chain has to bottom out non-null. Every
        // document on demo and dev has a summary; the rest is belt-and-braces.
        d.content      = coalesce(d.content, d.summary, d.userHint, d.filename, ''),
        // createdAt is DateTime!. In Cypher, SET p = null REMOVES the property,
        // so this floors on datetime() rather than trusting uploadedAt to exist
        // — a missing createdAt would fail the whole pulses selection set for
        // the field, not just this node.
        d.createdAt    = coalesce(d.createdAt, d.uploadedAt, datetime()),
        d.modifiedAt   = coalesce(d.modifiedAt, d.statusUpdatedAt, d.uploadedAt, datetime()),
        // Durable, Space-scoped locator (GOAL-302). The id is unchanged by the
        // relabel, so this is the same URL the file already resolved on — valid
        // again once the download route is re-anchored (see the cutover note).
        d.location     = coalesce(d.location, '/api/ingest/document/' + d.id + '/download')

    // Source-file properties (lossless copy, old keys dropped below).
    SET d.sourceFilename  = coalesce(d.sourceFilename, d.filename),
        d.sourceMimeType  = coalesce(d.sourceMimeType, d.mimeType),
        d.sourceSizeBytes = coalesce(d.sourceSizeBytes, d.sizeBytes),
        d.sourcePageCount = coalesce(d.sourcePageCount, d.pageCount),
        d.sourceBlobKey   = coalesce(d.sourceBlobKey, d.blobKey),
        d.sourceBlobUrl   = coalesce(d.sourceBlobUrl, d.blobUrl),
        d.sourceUserHint  = coalesce(d.sourceUserHint, d.userHint),
        d.sourceSummary   = coalesce(d.sourceSummary, d.summary),
        d.sourceConcepts  = coalesce(d.sourceConcepts, d.concepts)

    // Ingest lifecycle. Pre-GOAL-292 uploads carry no status and have always
    // read back as COMPLETE, so make that explicit rather than leaving a null
    // the cron might mistake for unqueued work. Pre-flight has already
    // guaranteed nothing here is PENDING/PROCESSING.
    SET d.ingestStatus          = coalesce(d.ingestStatus, d.status, 'COMPLETE'),
        d.ingestStatusMessage   = coalesce(d.ingestStatusMessage, d.statusMessage),
        d.ingestStatusUpdatedAt = coalesce(d.ingestStatusUpdatedAt, d.statusUpdatedAt)

    // Give the resource a displayable author. resolvePulseAuthor reads
    // initiatedBy[0] then createdBy[0]; a migrated document has neither, so it
    // would render authorless. UPLOADED_BY survives untouched as the audit edge.
    WITH fc, hd, d
    OPTIONAL MATCH (d)-[:UPLOADED_BY]->(uploader:Person)
    FOREACH (_ IN CASE WHEN uploader IS NULL THEN [] ELSE [1] END |
      MERGE (d)-[:CREATED_BY]->(uploader)
    )

    // Anchor the pulse to its context, then retire the document edge.
    MERGE (fc)-[:HAS_PULSE]->(d)
    DELETE hd

    REMOVE d:Document
    REMOVE ${RENAMED_KEYS.map((k) => `d.${k}`).join(', ')}

    // DISTINCT: the driving MATCH fans out per HAS_DOCUMENT edge (nothing
    // enforces one per document) and again per UPLOADED_BY edge. The writes are
    // idempotent under the coalesce guards, but the count an operator reads to
    // judge the run must not be inflated.
    RETURN count(DISTINCT d) AS migrated
    `,
    {}
  )

  console.log(`    ✓ Migrated ${num(migrated?.migrated)} document(s)`)

  // ---------------------------------------------------------------------------
  // Step 4 — Verify.
  // ---------------------------------------------------------------------------
  const [after] = await graph.query<Record<string, unknown>>(
    `
    OPTIONAL MATCH (d:Document)
    WITH count(d) AS documentsRemaining
    OPTIONAL MATCH (r:ResourcePulse {resourceType: 'document'})
    WITH documentsRemaining, count(r) AS documentResources
    OPTIONAL MATCH (:FieldContext)-[h:HAS_DOCUMENT]->()
    WITH documentsRemaining, documentResources, count(h) AS hasDocumentEdges
    OPTIONAL MATCH ()-[e:EXTRACTED_FROM]->(:ResourcePulse)
    WITH documentsRemaining, documentResources, hasDocumentEdges,
         count(e) AS extractedFromEdges
    OPTIONAL MATCH (p:ResourcePulse {resourceType: 'document'})
    WHERE p.embedding IS NULL
    RETURN documentsRemaining, documentResources, hasDocumentEdges,
           extractedFromEdges, count(p) AS awaitingEmbedding
    `,
    {}
  )

  console.log('\n  After:')
  console.log(`    :Document nodes remaining ........ ${num(after?.documentsRemaining)}`)
  console.log(`    :ResourcePulse resourceType=document ${num(after?.documentResources)}`)
  console.log(`    HAS_DOCUMENT edges remaining ..... ${num(after?.hasDocumentEdges)}`)
  console.log(`    EXTRACTED_FROM → :ResourcePulse .. ${num(after?.extractedFromEdges)}`)
  console.log(`    awaiting embedding ............... ${num(after?.awaitingEmbedding)}`)

  const remaining = num(after?.documentsRemaining)
  if (remaining > orphans.length) {
    console.log(
      `\n  ⚠ ${remaining} :Document node(s) still present but only ${orphans.length} were expected orphans.`
    )
  }

  console.log(
    '\n  Migrated resources carry no embedding yet. The resonance cron sweeps' +
      '\n  (:FieldPulse) WHERE embedding IS NULL, so they join resonance on its' +
      '\n  next run — no separate backfill needed.\n'
  )
  console.log(`  Renamed keys dropped from the node: ${RENAMED_KEYS.join(', ')}`)
  console.log('  `uploadedAt` retained as-is; its value also seeds `createdAt`.\n')
}

main().catch((error) => {
  console.error('\nMigration failed:', error)
  process.exitCode = 1
})
