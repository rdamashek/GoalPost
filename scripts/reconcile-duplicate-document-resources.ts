/**
 * GOAL-354 — reconcile the duplicate resources the Document remodel surfaced.
 *
 * The bulk article import (GOAL-317 / GOAL-344) mints TWO nodes per sheet row
 * whose link it can read: the row's own pulse, built from the sheet columns, and
 * a Document holding the fetched article. While a Document was its own node type
 * that was invisible — one showed in the Pulses list, the other in the Documents
 * list. Now that a document IS a Resource, both land in the same list and the
 * member sees the same artifact twice.
 *
 * WF-11 is explicit that the fetched document is *enrichment of the row's
 * pulse*, not a peer artifact, so the two are merged back into one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What counts as a duplicate
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY a pair where all three hold:
 *
 *   1. the row pulse points at the document via EXTRACTED_FROM,
 *   2. both hang off the SAME FieldContext, and
 *   3. the document's title with its file extension stripped equals the row
 *      pulse's title.
 *
 * The third condition is what makes this safe. On demo, 72 pulses point at a
 * document via EXTRACTED_FROM but only 17 share its title — the other 55 are
 * genuine provenance: resources, goals and stories the extractor pulled OUT of
 * an article, which merely came from the same source. Merging on EXTRACTED_FROM
 * alone would have collapsed a whole field's extracted content into its source
 * file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Which node survives, and why
 * ─────────────────────────────────────────────────────────────────────────────
 * The DOCUMENT node survives; the row pulse is folded into it. That is the
 * cheaper and safer direction:
 *
 *   - The document keeps its id, so every existing
 *     `/api/ingest/document/<id>/download` locator on other pulses keeps
 *     resolving. Merging the other way would strand them all.
 *   - The document carries ~278 inbound EXTRACTED_FROM edges (people,
 *     organizations, pulses). Those stay put. The row pulse carries ~230 edges,
 *     which is the smaller set to move.
 *   - The blob pointer, ingest thread and ingest state stay where they are.
 *
 * The survivor takes the row pulse's IDENTITY, though: its clean title (no file
 * extension) and its `resourceType`. That last point is deliberate and is the
 * one thing worth arguing about — after this runs, a merged resource is a
 * `book` / `article` / `event` that happens to have a file attached, NOT a
 * `document`. That is the right product model (`resourceType` describes what the
 * resource IS; the file is how we got it), and it is what "the Resource is the
 * focal point, the file is just the source it points back to" means. The visible
 * consequence is that the count of `resourceType: 'document'` resources drops by
 * the number of pairs merged.
 *
 * Dry-run by DEFAULT. Nothing is written without `--execute`.
 *
 *   npx tsx scripts/reconcile-duplicate-document-resources.ts
 *   npx tsx scripts/reconcile-duplicate-document-resources.ts --execute
 */

import 'dotenv/config.js'
import { initGraph } from '../src/modules/graph.js'

const num = (value: unknown): number => Number(value ?? 0)

const EXECUTE = process.argv.includes('--execute')

/**
 * The pair-matching clause, shared by the report and the merge so they can never
 * disagree about what is about to be touched. Binds `c`, `doc` and `row`.
 */
const MATCH_DUPLICATE_PAIRS = `
    MATCH (c:FieldContext)-[:HAS_PULSE]->(doc:ResourcePulse)
    WHERE doc.resourceType = 'document'
    MATCH (c)-[:HAS_PULSE]->(row:ResourcePulse)-[:EXTRACTED_FROM]->(doc)
    WHERE row <> doc
    WITH c, doc, row,
      toLower(trim(
        replace(replace(replace(replace(doc.title, '.pdf', ''), '.docx', ''),
        '.txt', ''), '.md', '')
      )) AS docTitle,
      toLower(trim(row.title)) AS rowTitle
    WHERE docTitle = rowTitle`

async function main() {
  const graph = await initGraph()

  console.log(
    `\nGOAL-354 — reconcile duplicate document resources  [${
      EXECUTE ? 'EXECUTE' : 'DRY RUN'
    }]`
  )
  console.log(`  target : ${process.env.NEO4J_URI ?? '(unset)'}`)
  console.log(`  env file: ${process.env.DOTENV_CONFIG_PATH ?? '(none)'}\n`)

  const pairs = await graph.query<Record<string, unknown>>(
    `
    ${MATCH_DUPLICATE_PAIRS}
    RETURN doc.title AS docTitle, doc.resourceType AS docType,
           row.title AS rowTitle, row.resourceType AS rowType,
           c.title AS context
    ORDER BY rowTitle
    `,
    {}
  )

  console.log(`  ${pairs.length} duplicate pair(s) to merge:\n`)
  for (const p of pairs) {
    console.log(`    "${p.rowTitle}"  [${p.rowType}]`)
    console.log(`      absorbs  "${p.docTitle}"  [${p.docType}]   in ${p.context}`)
  }

  if (pairs.length === 0) {
    console.log('\n  Nothing to reconcile.\n')
    return
  }

  if (!EXECUTE) {
    console.log('\n  Dry run — no writes. Re-run with --execute to apply.\n')
    return
  }

  console.log('\n  Merging...')

  // One statement, so the whole reconcile is a single transaction — a partial
  // merge would leave a resource with half its edges moved and no way to tell.
  const [result] = await graph.query<Record<string, unknown>>(
    `
    ${MATCH_DUPLICATE_PAIRS}

    // ---- Collapse many rows onto one document -------------------------------
    // A document frequently has MORE THAN ONE matching row pulse, because the
    // sheet was imported more than once: 'Bioregional Fractal Consciousness'
    // appears as both 'article' and 'Article', 'The World Ending Fire - book' as
    // both 'Article' and 'book'. Those rows are duplicates of each other as well
    // as of the document, so all of them fold in — but exactly one has to supply
    // the survivor's identity, or resourceType would be whichever row the
    // planner happened to visit last. ORDER BY before collect() makes rows[0]
    // the earliest-created row, with the id as a stable tie-break.
    WITH doc, row ORDER BY row.createdAt ASC, row.id ASC
    WITH doc, collect(DISTINCT row) AS rows
    WITH doc, rows, rows[0] AS primary

    // ---- Identity: the survivor becomes the primary row pulse ---------------
    // Title loses the file extension; resourceType stops being 'document' and
    // becomes what the resource actually is. Lower-cased on the way through,
    // which also chips at the unnormalised vocabulary ('Book' vs 'book').
    SET doc.title = primary.title,
        doc.resourceType = toLower(trim(primary.resourceType)),
        // The row's body is the member-facing description from the sheet. Keep
        // it when the document's own content is just the filename placeholder
        // or the AI summary; otherwise leave the richer text alone.
        doc.content = CASE
          WHEN primary.content IS NOT NULL AND trim(primary.content) <> ''
           AND (doc.content IS NULL OR trim(doc.content) = ''
                OR doc.content = doc.sourceFilename)
          THEN primary.content ELSE doc.content END,
        // Where it was found, if the document did not already record it.
        doc.sourceUrl = coalesce(doc.sourceUrl, primary.location),
        doc.why = coalesce(doc.why, primary.why),
        doc.time = coalesce(doc.time, primary.time),
        doc.availability = coalesce(doc.availability, primary.availability),
        doc.intensity = coalesce(doc.intensity, primary.intensity),
        // Force a re-embed: the survivor's title and content have changed, so
        // the old vector describes a node that no longer exists. The resonance
        // cron sweeps (:FieldPulse) WHERE embedding IS NULL.
        doc.embedding = null,
        doc.modifiedAt = datetime()

    // ---- Move the row pulse's edges onto the survivor ------------------------
    // MERGE throughout: the two nodes frequently share an endpoint (the same
    // person authored both, the same organization is mentioned in both), and a
    // plain CREATE would leave duplicate parallel edges behind.
    WITH doc, rows
    UNWIND rows AS row

    WITH doc, rows, row
    OPTIONAL MATCH (row)-[:INITIATED_BY]->(author:Person)
    FOREACH (_ IN CASE WHEN author IS NULL THEN [] ELSE [1] END |
      MERGE (doc)-[:INITIATED_BY]->(author))

    WITH doc, rows, row
    OPTIONAL MATCH (row)-[:CREATED_BY]->(creator:Person)
    FOREACH (_ IN CASE WHEN creator IS NULL THEN [] ELSE [1] END |
      MERGE (doc)-[:CREATED_BY]->(creator))

    WITH doc, rows, row
    OPTIONAL MATCH (mentioner)-[:MENTIONED_IN]->(row)
    FOREACH (_ IN CASE WHEN mentioner IS NULL THEN [] ELSE [1] END |
      MERGE (mentioner)-[:MENTIONED_IN]->(doc))

    WITH doc, rows, row
    OPTIONAL MATCH (log:Log)-[:LOGGED_FOR]->(row)
    FOREACH (_ IN CASE WHEN log IS NULL THEN [] ELSE [1] END |
      MERGE (log)-[:LOGGED_FOR]->(doc))

    // Resonance endpoints. Re-pointed rather than dropped so the field keeps the
    // connections it had, then de-looped below.
    WITH doc, rows, row
    OPTIONAL MATCH (link)-[:SOURCE]->(row)
      WHERE link:ResonanceLink OR link:ResonanceSuggestion
    FOREACH (_ IN CASE WHEN link IS NULL THEN [] ELSE [1] END |
      MERGE (link)-[:SOURCE]->(doc))

    WITH doc, rows, row
    OPTIONAL MATCH (link2)-[:TARGET]->(row)
      WHERE link2:ResonanceLink OR link2:ResonanceSuggestion
    FOREACH (_ IN CASE WHEN link2 IS NULL THEN [] ELSE [1] END |
      MERGE (link2)-[:TARGET]->(doc))

    WITH collect(DISTINCT doc) AS survivors, collect(DISTINCT row) AS allRows
    FOREACH (r IN allRows | DETACH DELETE r)
    RETURN size(survivors) AS merged, size(allRows) AS removed
    `,
    {}
  )

  console.log(`    ✓ merged ${num(result?.merged)} pair(s), removed ${num(result?.removed)} duplicate pulse(s)`)

  // A resonance whose two endpoints just became the same node is meaningless —
  // "this resource resonates with itself". Only reachable because the merge
  // collapsed two previously distinct endpoints together.
  const [deloop] = await graph.query<Record<string, unknown>>(
    `
    MATCH (link)-[:SOURCE]->(n)
    MATCH (link)-[:TARGET]->(n)
    WHERE link:ResonanceLink OR link:ResonanceSuggestion
    DETACH DELETE link
    RETURN count(DISTINCT link) AS selfLoops
    `,
    {}
  )
  console.log(`    ✓ removed ${num(deloop?.selfLoops)} self-resonance(s) created by the merge`)

  const [after] = await graph.query<Record<string, unknown>>(
    `
    OPTIONAL MATCH (r:ResourcePulse) WITH count(r) AS resources
    OPTIONAL MATCH (d:ResourcePulse {resourceType: 'document'})
      WITH resources, count(d) AS documentResources
    OPTIONAL MATCH (p:ResourcePulse) WHERE p.embedding IS NULL
      RETURN resources, documentResources, count(p) AS awaitingEmbedding
    `,
    {}
  )
  console.log('\n  After:')
  console.log(`    :ResourcePulse total ............. ${num(after?.resources)}`)
  console.log(`    still resourceType 'document' .... ${num(after?.documentResources)}`)
  console.log(`    awaiting re-embed ................ ${num(after?.awaitingEmbedding)}`)
  console.log(
    '\n  Merged resources were cleared of their embeddings so the resonance cron' +
      '\n  re-embeds them against their new title and content.\n'
  )
}

main().catch((error) => {
  console.error('\nReconcile failed:', error)
  process.exitCode = 1
})
