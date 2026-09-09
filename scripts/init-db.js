import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import neo4j from 'neo4j-driver'
import dotenv from 'dotenv'

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load environment variables from .env.local
dotenv.config({ path: path.join(__dirname, '../.env.local') })

// Get database connection details from environment variables
const uri = process.env.NEO4J_URI || 'neo4j://localhost:7687'
const user = process.env.NEO4J_USER || 'neo4j'
const password = process.env.NEO4J_PASSWORD || 'password'

async function initializeDatabase() {
  console.log('Connecting to Neo4j database...')

  // Create a Neo4j driver instance
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
  const session = driver.session()

  try {
    // Read the seed-dev.cypher file
    const cypherFilePath = path.join(
      __dirname,
      '../docs/cypher/seed-dev.cypher'
    )
    let cypherQuery = fs.readFileSync(cypherFilePath, 'utf8')

    console.log('Executing database initialization queries...')

    // Split the cypher file into individual statements and execute them
    const statements = cypherQuery
      .split(';')
      .filter((stmt) => stmt.trim().length > 0)

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim()
      if (statement) {
        console.log(`Executing statement ${i + 1} of ${statements.length}...`)
        await session.run(statement)
      }
    }
    // Create constraints for unique IDs
    console.log('Creating database constraints...')
    const constraints = [
      `CREATE CONSTRAINT conversation_chunk_id IF NOT EXISTS
       FOR (n:ConversationChunk) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT person_id IF NOT EXISTS
       FOR (n:Person) REQUIRE n.id IS UNIQUE`,
      // One Person per email — the structural guarantee behind login,
      // signup's duplicate-user guard, findUserByEmail, and
      // inviteToSpaceByEmail's resolve-or-create. Emails are normalized
      // (trim + lowercase, see src/lib/auth/normalize-email.ts) at every
      // write + match boundary, so this case-sensitive constraint actually
      // enforces one-account-per-inbox rather than letting casing fork
      // duplicates. The constraint provides its own backing index, so no
      // separate RANGE index on email is needed. NOTE: bringing this online
      // requires no duplicate non-null emails — run
      // scripts/normalize-person-emails.ts first (it lowercases existing
      // rows and aborts if any case-insensitive collision exists).
      `CREATE CONSTRAINT person_email_unique IF NOT EXISTS
       FOR (n:Person) REQUIRE n.email IS UNIQUE`,
      `CREATE CONSTRAINT community_id IF NOT EXISTS
       FOR (n:Community) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT space_id IF NOT EXISTS
       FOR (n:Space) REQUIRE n.id IS UNIQUE`,
      // Enforces the "one MeSpace per Person" invariant at the DB layer.
      // Application-level guards (validateOneMeSpacePerPerson, atomic
      // create in /api/me-space/create) close TOCTOU races, but a stray
      // direct Cypher run from a migration or admin session could still
      // double-write. Denormalizing the owner id onto the MeSpace node +
      // UNIQUE constraint here is the structural guarantee. See
      // kb/05-data-entities.md and kb/03-workflows.md for the domain rule.
      `CREATE CONSTRAINT mespace_owner_unique IF NOT EXISTS
       FOR (n:MeSpace) REQUIRE n.ownerId IS UNIQUE`,
      `CREATE CONSTRAINT context_id IF NOT EXISTS
       FOR (n:FieldContext) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT pulse_id IF NOT EXISTS
       FOR (n:FieldPulse) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT resonance_id IF NOT EXISTS
       FOR (n:FieldResonance) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT resonance_link_id IF NOT EXISTS
       FOR (n:ResonanceLink) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT resonance_suggestion_id IF NOT EXISTS
       FOR (n:ResonanceSuggestion) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT conversation_thread_id IF NOT EXISTS
       FOR (n:ConversationThread) REQUIRE n.id IS UNIQUE`,
      `CREATE CONSTRAINT conversation_turn_id IF NOT EXISTS
       FOR (n:ConversationTurn) REQUIRE n.id IS UNIQUE`,
      // Context-scoped document ingest writes a `ContextExtraction` event
      // per run (`src/lib/imports/context-extraction.ts`). The id is
      // generated client-side (`extraction_<ts>_<uuid>`), so a UNIQUE
      // constraint protects against double-writes if the route ever
      // retries — matches the project pattern of every other event-style
      // node having an id uniqueness gate.
      `CREATE CONSTRAINT context_extraction_id IF NOT EXISTS
       FOR (n:ContextExtraction) REQUIRE n.id IS UNIQUE`,
      // Document ingestion (GOAL-235) writes a `Document` node per upload
      // anchored to a FieldContext via `HAS_DOCUMENT`. Every hot path
      // (uploadDocument, reExtractDocument, deleteDocument, the
      // documentsByFieldContext query) matches by `Document.id`. Without
      // this constraint the planner falls back to `NodeByLabelScan` +
      // Filter, which degrades linearly with the document count across
      // all Spaces.
      `CREATE CONSTRAINT document_id IF NOT EXISTS
       FOR (n:Document) REQUIRE n.id IS UNIQUE`,
      // GOAL-326: same reasoning for the bulk-import queue, and the by-id path
      // is far hotter — the claim, EVERY per-row outcome append (300 per job),
      // all three terminal writes, the load, and the member's 2-second poll all
      // match by id. Measured at a 2,000-job backlog: the append alone went
      // 4,020 dbHits (NodeByLabelScan + Filter) → 6 (NodeUniqueIndexSeek), so a
      // 300-row import was paying ~1.2M dbHits in pure lookup overhead.
      // Uniqueness also closes the one ambiguity `loadArticleImportJob`'s
      // edge-count check cannot see: duplicate ids would make `records[0]`
      // arbitrary and let a claim take two nodes at once.
      `CREATE CONSTRAINT article_import_job_id IF NOT EXISTS
       FOR (n:ArticleImportJob) REQUIRE n.id IS UNIQUE`,
      // AI self-improvement loop: AssistantFeedback nodes capture both
      // explicit user thumb-ratings and server-side auto-signals (tool
      // errors, empty responses, Rule-1 raw-id leaks). Powers the
      // /dev/ai-quality triage dashboard and the daily classify cron.
      `CREATE CONSTRAINT assistant_feedback_id IF NOT EXISTS
       FOR (n:AssistantFeedback) REQUIRE n.id IS UNIQUE`,
      // Recipient-addressed notifications (bell popover). Distinct from Log
      // (the immutable, space-wide audit trail): one Notification is owned by
      // exactly one recipient and carries its own server-side read flag.
      `CREATE CONSTRAINT notification_id IF NOT EXISTS
       FOR (n:Notification) REQUIRE n.id IS UNIQUE`,
      // Activity-log audit trail (Log). The post-write re-fetches in
      // activity-log-resolver.ts (MATCH (log:Log {id: $logId})-[:CREATED_BY]->…)
      // key by Log.id; without this constraint each pays a growing
      // NodeByLabelScan + Filter as the audit stream accumulates (a
      // NodeUniqueIndexSeek once present). The constraint also makes
      // create-log.ts's id-keyed CREATE race-safe against a double-write.
      // (getContextLogs/getUserLogs reach Log by traversal, not by id.) Add the
      // id uniqueness gate — matches every other event-style node. (GOAL-307)
      `CREATE CONSTRAINT log_id_unique IF NOT EXISTS
       FOR (n:Log) REQUIRE n.id IS UNIQUE`,
      // First-class organizations named in uploaded documents (GOAL-298).
      // The backing RANGE index also turns the assistant's Bloom node-anchor
      // lookup (MATCH (o:Organization {id}) in cypher-generator/execute.ts)
      // from a label scan into an index seek. Nodes also carry :LifeSensor
      // :RelationalEntity; the constraint targets the load-bearing :Organization.
      `CREATE CONSTRAINT organization_id IF NOT EXISTS
       FOR (n:Organization) REQUIRE n.id IS UNIQUE`,
      // Per-user, per-model LLM usage & cost metering (GOAL-297). One
      // LlmUsage node is written per LLM/embedding call; the /dev/llm-usage
      // report aggregates by user/model. The id is generated client-side
      // (`usage_<uuid>`), so a UNIQUE constraint guards against any double
      // write and backs the id lookup — matches every other event-style node.
      `CREATE CONSTRAINT llm_usage_id IF NOT EXISTS
       FOR (n:LlmUsage) REQUIRE n.id IS UNIQUE`,
      // Singleton principal that background/cron LLM spend is attributed to
      // (GOAL-297). recordLlmUsage MERGEs (:SystemPrincipal {id:'system'});
      // without this constraint two concurrent background jobs could MERGE
      // duplicate nodes on a cold DB and split the "System (background)"
      // row in the /dev/llm-usage report.
      `CREATE CONSTRAINT system_principal_id IF NOT EXISTS
       FOR (n:SystemPrincipal) REQUIRE n.id IS UNIQUE`,
    ]

    // Drop deprecated standalone indexes that now conflict with a constraint.
    // person_email was a plain RANGE index in an earlier revision; the
    // person_email_unique constraint below owns its own backing index, and
    // Neo4j refuses to create the constraint while the standalone index still
    // exists (Neo.ClientError.Schema.IndexAlreadyExists). DROP ... IF EXISTS
    // is a no-op on a fresh DB, so this is safe to run every init.
    console.log('Dropping deprecated indexes...')
    const deprecatedIndexes = ['DROP INDEX person_email IF EXISTS']
    for (const drop of deprecatedIndexes) {
      await session.run(drop)
      console.log(`✓ Deprecated index dropped (if present)`)
    }

    for (const constraint of constraints) {
      try {
        await session.run(constraint)
        console.log(`✓ Constraint created`)
      } catch (error) {
        if (
          error.code ===
          'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists'
        ) {
          console.log(`✓ Constraint already exists`)
        } else {
          throw error
        }
      }
    }

    // Create vector indexes
    console.log('\nCreating vector indexes...')
    const vectorIndexes = [
      {
        name: 'personBioVectorIndex',
        label: 'Person',
        property: 'embedding',
        description: 'Person bio embeddings for semantic search',
      },
      {
        name: 'pulseContentVectorIndex',
        label: 'FieldPulse',
        property: 'embedding',
        description: 'Pulse content embeddings (aggregated from chunks)',
      },
      {
        name: 'conversationChunkVectorIndex',
        label: 'ConversationChunk',
        property: 'embedding',
        description: 'Individual conversation chunk embeddings',
      },
      {
        name: 'assistantFeedbackQuestionVectorIndex',
        label: 'AssistantFeedback',
        property: 'questionEmbedding',
        description:
          'AssistantFeedback user-question embeddings for failure clustering',
      },
    ]

    for (const index of vectorIndexes) {
      try {
        await session.run(
          `
          CALL db.index.vector.createNodeIndex(
            $name,
            $label,
            $property,
            1536,
            'cosine'
          )
        `,
          { name: index.name, label: index.label, property: index.property }
        )
        console.log(`✓ Created ${index.description}: ${index.name}`)
      } catch (error) {
        // Neo4j wraps schema errors raised inside a procedure call as
        // `ProcedureCallFailed`, so the "already exists" check must look
        // at either the wrapped cause or the error message — the
        // outermost `error.code` is the procedure code, not the schema
        // code, on Aura's vector procedure path.
        const causeCode = error?.cause?.code ?? error?.cause?.gqlStatus
        const messageLooksLikeExists =
          typeof error?.message === 'string' &&
          /already exists/i.test(error.message)
        if (
          error.code ===
            'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists' ||
          causeCode ===
            'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists' ||
          messageLooksLikeExists
        ) {
          console.log(`✓ Vector index already exists: ${index.name}`)
        } else {
          throw error
        }
      }
    }

    // Create indexes for performance
    console.log('\nCreating property indexes...')
    const propertyIndexes = [
      `CREATE INDEX resonance_label IF NOT EXISTS
       FOR (r:FieldResonance) ON (r.label)`,
      `CREATE INDEX pulse_createdAt IF NOT EXISTS
       FOR (p:FieldPulse) ON (p.createdAt)`,
      `CREATE INDEX pulse_modifiedAt IF NOT EXISTS
       FOR (p:FieldPulse) ON (p.modifiedAt)`,
      `CREATE INDEX chunk_order IF NOT EXISTS
       FOR (c:ConversationChunk) ON (c.order)`,
      `CREATE INDEX conversation_turn_order IF NOT EXISTS
       FOR (t:ConversationTurn) ON (t.order)`,
      `CREATE INDEX conversation_thread_lastTurnAt IF NOT EXISTS
       FOR (t:ConversationThread) ON (t.lastTurnAt)`,
      // Dashboard list query orders by createdAt DESC; without an index the
      // planner falls back to a full label scan as the feedback table grows.
      `CREATE INDEX assistant_feedback_createdAt IF NOT EXISTS
       FOR (f:AssistantFeedback) ON (f.createdAt)`,
      // GOAL-292: Document.status IS the ingest queue. The one-minute cron seeks
      // PENDING (findPendingDocumentIds) and PROCESSING (reclaimStalledIngests)
      // on every single tick, so this is the hottest index in the schema by
      // frequency. Measured at 5k documents: 53 dbHits with the index vs 10,101
      // without (a full Document label scan), per query, twice a minute —
      // ~144k dbHits/day indexed against ~29.1M unindexed, growing linearly.
      // A composite (status, uploadedAt) was tried and the planner ignored it.
      `CREATE INDEX document_status IF NOT EXISTS
       FOR (d:Document) ON (d.status)`,
      // GOAL-354: the same queue, re-anchored. A document is a Resource, so the
      // ingest lifecycle now lives on `ResourcePulse.ingestStatus` (renamed off
      // `status`, which ResourcePulse already uses for the pulse's own,
      // unrelated status). The cron's seek is unchanged in shape but the label
      // it scans is larger — there are ~5x more ResourcePulses than there were
      // Documents — so this index matters strictly more than the one above, not
      // less. `document_status` stays until the Document type is retired.
      `CREATE INDEX resource_ingest_status IF NOT EXISTS
       FOR (r:ResourcePulse) ON (r.ingestStatus)`,
      // GOAL-326: same story for the bulk-article-import queue. The one-minute
      // cron seeks PENDING (findPendingArticleImportJobIds) and PROCESSING
      // (reclaimStalledArticleImports) on every tick, and the enqueue path
      // seeks both again for the per-user in-flight cap. Without the index each
      // of those is a full ArticleImportJob label scan that grows with every
      // import ever run.
      `CREATE INDEX article_import_job_status IF NOT EXISTS
       FOR (j:ArticleImportJob) ON (j.status)`,
      // LlmUsage is the fastest-growing node in the system (one per LLM /
      // embedding call, never pruned). The /dev/llm-usage report filters
      // `WHERE u.createdAt >= datetime($since)` for its time windows and
      // orders recent calls by createdAt DESC. Without this range index the
      // windowed reads degrade to a full label scan of every usage row ever.
      // (GOAL-297)
      `CREATE INDEX llm_usage_createdAt IF NOT EXISTS
       FOR (u:LlmUsage) ON (u.createdAt)`,
      // Classification cron filters `WHERE classification IS NULL`; an index
      // on the property lets that filter resolve via index seek rather than
      // a per-row property check.
      `CREATE INDEX assistant_feedback_classification IF NOT EXISTS
       FOR (f:AssistantFeedback) ON (f.classification)`,
      // Purge cron (GOAL-319) sweeps `WHERE c.deletedAt IS NOT NULL AND
      // c.deletedAt < cutoff` daily; the index keeps that a seek instead of
      // a full FieldContext label scan as contexts accumulate.
      `CREATE INDEX context_deletedAt IF NOT EXISTS
       FOR (c:FieldContext) ON (c.deletedAt)`,
      // Default dashboard view filters `WHERE coalesce(f.status, 'open') IN
      // ['open', 'in_progress']` — once the table has thousands of rows the
      // unindexed property check becomes the long pole. Index it.
      `CREATE INDEX assistant_feedback_status IF NOT EXISTS
       FOR (f:AssistantFeedback) ON (f.status)`,
      // Auth single-use tokens (invite + password reset) are stored as
      // sha256 hashes — never plaintext — on Person.inviteTokenHash /
      // Person.resetTokenHash. The accept-invite + reset-password routes
      // re-hash the URL-bound raw token and look up by these indexed
      // hash fields. Sparse RANGE index — only Persons with a pending
      // token occupy index space. Storing the hash defends against
      // database-read compromise; the index also collapses the lookup
      // to ~1 dbHit so it can't be used as a timing-enumeration oracle.
      // (Migrated from plaintext inviteToken/resetToken indexes via
      // scripts/hash-person-tokens.ts — GOAL-248.)
      `CREATE INDEX person_invite_token_hash IF NOT EXISTS
       FOR (p:Person) ON (p.inviteTokenHash)`,
      `CREATE INDEX person_reset_token_hash IF NOT EXISTS
       FOR (p:Person) ON (p.resetTokenHash)`,
      // Notification bell query is "my notifications, newest first" plus an
      // unread count. Index createdAt (ORDER BY ... DESC) and read (the
      // unread-count predicate) so the planner seeks rather than scanning the
      // whole Notification label as it grows.
      `CREATE INDEX notification_createdAt IF NOT EXISTS
       FOR (n:Notification) ON (n.createdAt)`,
      `CREATE INDEX notification_read IF NOT EXISTS
       FOR (n:Notification) ON (n.read)`,
      // NOTE: no separate index on Person.email — the person_email_unique
      // constraint above provides its own backing index for the exact-match
      // email lookups (login, signup guard, findUserByEmail, invite).
    ]

    for (const index of propertyIndexes) {
      try {
        await session.run(index)
        console.log(`✓ Property index created`)
      } catch (error) {
        if (
          error.code ===
          'Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists'
        ) {
          console.log(`✓ Property index already exists`)
        } else {
          throw error
        }
      }
    }

    console.log('\n✅ Database initialization completed successfully!')
  } catch (error) {
    console.error('Error initializing database:', error)
    process.exit(1)
  } finally {
    await session.close()
    await driver.close()
  }
}

initializeDatabase()
