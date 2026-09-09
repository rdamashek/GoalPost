/**
 * GOAL-354 — how the ingest pipeline addresses a document-backed Resource.
 *
 * A document is a *type of Resource*, not a node in its own right: the graph
 * node is a `:FieldPulse:ResourcePulse` with `resourceType: 'document'`, and the
 * file it was read from is described by its `source*` properties. The bytes stay
 * in S3; the graph holds only the key/URL.
 *
 * Every Cypher site in the ingest pipeline goes through the fragments here so
 * the label pattern and the renamed property names have exactly one definition.
 * When `:Document` was its own node those names were spread across six files,
 * and the rename is precisely the kind of change that leaves one straggler
 * matching a property nothing writes any more.
 */

/**
 * `resourceType` of a Resource that was created from an uploaded/fetched file.
 *
 * Note which gates narrow on it and which do not. The DELETE paths
 * (`handleDeleteDocument`, `document-storage.deleteDocument`) require
 * `resourceType = 'document'`, because they reach through HAS_PULSE and would
 * otherwise let a plain MEMBER hard-delete any resource in the context — past
 * what the kb/02 DELETE matrix allows. The read and lifecycle paths gate only on
 * the `:ResourcePulse` label, since a non-document resource simply has no
 * `sourceBlobKey` and falls out harmlessly. Do not assume
 * `MATCH_SOURCE_RESOURCE_BY_ID` narrows by type — it does not.
 */
export const RESOURCE_TYPE_DOCUMENT = 'document'

/**
 * Match one document-backed Resource by id, as the driving clause of a query.
 *
 * The anchor label is `:FieldPulse`, not `:ResourcePulse`, and that is
 * deliberate: the `pulse_id` uniqueness constraint is declared on `:FieldPulse`
 * (`scripts/init-db.js`), so this shape is a `NodeUniqueIndexSeek`. Matching
 * `(d:ResourcePulse {id: …})` instead has no supporting constraint and degrades
 * to a label scan filtered by id — on every claim, every terminal write, and
 * every re-extract. The subtype is asserted in the WHERE instead, which costs
 * one label check on a single already-seeked node.
 *
 * Binds `d`. Expects a `$documentId` parameter.
 */
export const MATCH_SOURCE_RESOURCE_BY_ID = `
        MATCH (d:FieldPulse {id: $documentId})
        WHERE d:ResourcePulse`

/**
 * The same match, anchored through its parent FieldContext — for the paths that
 * need the context (authorization scope, soft-delete checks, re-extract).
 *
 * Binds `c` and `d`. Expects `$documentId`.
 *
 * NOT YET WIRED IN. It exists for the follow-up that scopes the seven
 * `EXTRACTED_FROM` provenance sites in `lib/chat/hitl.ts`: those still match
 * `$documentId` against any ResourcePulse in the database, with no check that it
 * belongs to the `$contextId` the write targets. That was narrow when the
 * reachable set was documents only (45 on demo); it is now every resource (217),
 * so a bad id can plant a cross-Space provenance edge. Each site binds its
 * context under a different name, hence the separate change.
 */
export const MATCH_SOURCE_RESOURCE_IN_CONTEXT = `
        MATCH (c:FieldContext)-[:HAS_PULSE]->(d:FieldPulse {id: $documentId})
        WHERE d:ResourcePulse`

/**
 * Queue-ordering key. Migrated documents keep their original `uploadedAt`, and
 * `anchorDocument` stamps it on new ones, so the queue still drains
 * oldest-upload-first exactly as it did off `:Document`. `createdAt` is the
 * fallback because it is `DateTime!` on the pulse and therefore always present,
 * where `uploadedAt` is an undeclared property a hand-written pulse would lack.
 */
export const QUEUE_ORDER_KEY = 'coalesce(d.uploadedAt, d.createdAt)'
