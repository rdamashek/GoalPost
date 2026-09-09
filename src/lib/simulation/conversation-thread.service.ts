import { randomUUID } from 'node:crypto'
import { driver } from '@/lib/neo4j/driver'

/**
 * Server-side persistence for the AI assistant's conversation thread.
 *
 * Each authenticated user has a single rolling `ConversationThread` (the
 * most recent one is treated as "active"). Every user turn and every
 * assistant turn is appended as a `ConversationTurn` linked to the thread,
 * ordered by `order` for deterministic replay.
 *
 * Schema:
 *
 *   (:Person:User {id})-[:HAS_THREAD]->(:ConversationThread {
 *      id, createdAt, lastTurnAt
 *   })-[:HAS_TURN]->(:ConversationTurn {
 *      id, role, content, parts, order, createdAt
 *   })
 *
 *   - `parts` is a JSON-serialised array of AI-SDK `UIMessagePart` objects
 *     (text, tool-call, tool-result, ...). Storing the serialised tree lets
 *     us round-trip tool calls + their results so the chat can be replayed
 *     verbatim on hydration.
 *   - `order` is monotonically increasing within a thread; new turns use
 *     `coalesce(max(existing.order), -1) + 1`.
 *
 * Activity logging: chat turns are intentionally NOT mirrored into the Log
 * stream. The thread itself is the audit trail (every turn is timestamped,
 * ordered, and attributed via the user→thread relationship), and logging
 * every assistant message would swamp the activity feed. This mirrors the
 * existing exemption for `ConversationChunk` writes from
 * `pulse/create-from-conversation`.
 *
 * Authorization: every read/write requires a `userId` argument. The Cypher
 * always anchors via `(p:Person:User {id: $userId})` so a missing or
 * spoofed id can't read or write someone else's thread.
 */

export type ConversationTurnRole = 'user' | 'assistant' | 'system'

export interface ConversationTurnInput {
  role: ConversationTurnRole
  content: string
  /** Serialised AI-SDK UIMessagePart[]. Stored as a JSON string. */
  parts?: unknown
}

export interface ConversationTurnRecord {
  id: string
  role: ConversationTurnRole
  content: string
  /** Parsed UIMessagePart[]. `null` when the row had no parts payload. */
  parts: unknown[] | null
  order: number
  createdAt: string
}

export interface ConversationThreadRecord {
  id: string
  createdAt: string
  lastTurnAt: string | null
  /** Stored AssistantMode. `'default' | 'aiden' | 'braider'`. `'default'` if unset. */
  mode: string
  /** `'ingest'` for doc-ingestion threads; `'reflective'` for the user's normal chat. */
  kind: string
  /** Human-readable title (e.g. "Ingest: meeting-notes.pdf"). Null when unset. */
  title: string | null
  turns: ConversationTurnRecord[]
}

const MAX_REPLAY_TURNS = 200

function parseStoredParts(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Append a single turn to the user's active thread, creating the thread if
 * it doesn't yet exist. Returns the new turn id and the parent thread id.
 *
 * Race-safety:
 *   1. The implicit (no-threadId) fallback MERGEs the user's chat thread
 *      keyed on `ownerId`. The UNIQUE constraint that previously paired
 *      with this MERGE was dropped because it also blocked every other
 *      kind of thread (sidebar "+", ingest) from being created. The
 *      residual race: the AI-SDK chat route writes the user turn at
 *      request-start and the assistant turn from `onFinish`; both call
 *      `appendConversationTurn(..., undefined)` and can be in flight
 *      concurrently on the very first exchange (no implicit thread yet)
 *      and both MERGE-miss then CREATE separate thread nodes. The
 *      failure mode is "two implicit threads exist" — both surface in
 *      the sidebar listing as siblings, the user can pick either, and
 *      no downstream invariant breaks. Acceptable degeneracy.
 *   2. We `SET t.turnCount = coalesce(t.turnCount, 0) + 1` BEFORE the
 *      OPTIONAL MATCH for next-order. The SET row-locks `t` for the rest
 *      of the transaction, serialising concurrent appends. `nextOrder`
 *      then derives from the incremented counter rather than a separate
 *      `max(order)` read, which avoids two writers picking the same
 *      ordinal under contention.
 */
export async function appendConversationTurn(
  userId: string,
  turn: ConversationTurnInput,
  threadId?: string,
  /**
   * Optional pre-generated turn id. The chat route generates the
   * assistant-turn id upfront so it can stream the same id back to the
   * client (via `messageMetadata`) — letting the client attach feedback
   * to the row this function will write a few milliseconds later. Pass
   * undefined to keep the legacy behavior (randomly generated id).
   */
  presetTurnId?: string
): Promise<{ threadId: string; turnId: string; order: number }> {
  if (!userId) throw new Error('appendConversationTurn: userId is required')
  const turnId = presetTurnId ?? randomUUID()
  const partsJson =
    turn.parts === undefined || turn.parts === null
      ? null
      : JSON.stringify(turn.parts)

  const session = driver.session()
  try {
    const result = await session.executeWrite(async (tx) => {
      if (threadId) {
        // Append to a specific named thread (multi-thread support).
        return tx.run(
          `
          MATCH (p:Person:User {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
          WITH t
          SET t.turnCount = coalesce(t.turnCount, 0) + 1,
              t.lastTurnAt = datetime()
          WITH t, t.turnCount - 1 AS nextOrder
          CREATE (t)-[:HAS_TURN]->(turn:ConversationTurn {
            id: $turnId,
            role: $role,
            content: $content,
            parts: $partsJson,
            order: nextOrder,
            createdAt: t.lastTurnAt
          })
          RETURN t.id AS threadId, turn.id AS turnId, turn.order AS order
          `,
          { userId, threadId, turnId, role: turn.role, content: turn.content, partsJson }
        )
      }
      // Default: MERGE to the user's implicit thread (keyed on ownerId).
      return tx.run(
        `
        MATCH (p:Person:User {id: $userId})
        MERGE (p)-[:HAS_THREAD]->(t:ConversationThread {ownerId: $userId})
          ON CREATE SET
            t.id = $newThreadId,
            t.createdAt = datetime(),
            t.lastTurnAt = datetime(),
            t.turnCount = 0,
            t.mode = 'default',
            t.kind = 'reflective'
        WITH t
        SET t.turnCount = coalesce(t.turnCount, 0) + 1,
            t.lastTurnAt = datetime(),
            t.mode = coalesce(t.mode, 'default'),
            t.kind = coalesce(t.kind, 'reflective')
        WITH t, t.turnCount - 1 AS nextOrder
        CREATE (t)-[:HAS_TURN]->(turn:ConversationTurn {
          id: $turnId,
          role: $role,
          content: $content,
          parts: $partsJson,
          order: nextOrder,
          createdAt: t.lastTurnAt
        })
        RETURN t.id AS threadId, turn.id AS turnId, turn.order AS order
        `,
        {
          userId,
          newThreadId: `thread_${randomUUID()}`,
          turnId,
          role: turn.role,
          content: turn.content,
          partsJson,
        }
      )
    })
    const record = result.records[0]
    if (!record) {
      throw new Error(
        `appendConversationTurn: no User/Thread found for userId=${userId}${threadId ? ` threadId=${threadId}` : ''}`
      )
    }
    return {
      threadId: record.get('threadId') as string,
      turnId: record.get('turnId') as string,
      order: Number(record.get('order')),
    }
  } finally {
    await session.close()
  }
}

export interface ConversationThreadSummary {
  id: string
  createdAt: string
  lastTurnAt: string | null
  turnCount: number
  snippet: string
  title: string | null
  mode: string
  kind: string
}

/** Return a lightweight list of all threads for the user, newest first. */
export async function listConversationThreadsSummary(
  userId: string
): Promise<ConversationThreadSummary[]> {
  if (!userId) return []
  const session = driver.session()
  try {
    const result = await session.executeRead(async (tx) =>
      tx.run(
        `
        MATCH (p:Person:User {id: $userId})-[:HAS_THREAD]->(t:ConversationThread)
        // collect()[0] returns the first user turn or null. The earlier
        // "turn IS NOT NULL + LIMIT 1" form filtered the empty-thread row
        // out of the subquery, and CALL row-join semantics then dropped
        // the outer t — invisible while threads were always seeded with
        // a turn, but every empty thread from the sidebar "+" vanished.
        CALL (t) {
          OPTIONAL MATCH (t)-[:HAS_TURN]->(turn:ConversationTurn {role: 'user'})
          WITH turn ORDER BY turn.order ASC
          RETURN collect(turn)[0] AS firstTurn
        }
        RETURN
          t.id AS id,
          toString(t.createdAt) AS createdAt,
          toString(t.lastTurnAt) AS lastTurnAt,
          coalesce(t.turnCount, 0) AS turnCount,
          substring(coalesce(firstTurn.content, ''), 0, 120) AS snippet,
          t.title AS title,
          coalesce(t.mode, 'default') AS mode,
          coalesce(t.kind, 'reflective') AS kind
        ORDER BY t.lastTurnAt DESC
        LIMIT 50
        `,
        { userId }
      )
    )
    return result.records.map((r) => ({
      id: r.get('id') as string,
      createdAt: (r.get('createdAt') as string) ?? '',
      lastTurnAt: (r.get('lastTurnAt') as string) ?? null,
      turnCount: Number(r.get('turnCount') ?? 0),
      snippet: (r.get('snippet') as string) ?? '',
      title: (r.get('title') as string | null) ?? null,
      mode: (r.get('mode') as string) ?? 'default',
      kind: (r.get('kind') as string) ?? 'reflective',
    }))
  } catch (error) {
    console.warn('[conversation-thread] listSummary failed:', error instanceof Error ? error.message : error)
    return []
  } finally {
    await session.close()
  }
}

/** Fetch a specific thread by id — auth-scoped: user must own it. */
export async function getConversationThread(
  userId: string,
  threadId: string
): Promise<ConversationThreadRecord | null> {
  if (!userId || !threadId) return null
  const session = driver.session()
  try {
    const result = await session.executeRead(async (tx) =>
      tx.run(
        `
        MATCH (p:Person:User {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
        // Aggregate inside the subquery so a zero-turn thread still yields
        // a row (collect over an empty input set returns [], not zero rows).
        // The previous shape returned the outer t WITH collect(...) joined
        // against a subquery that produced zero rows on empty threads, which
        // row-join semantics turned into "thread not found" — indistinguishable
        // from a real auth failure for the caller.
        CALL (t) {
          OPTIONAL MATCH (t)-[:HAS_TURN]->(turn:ConversationTurn)
          WITH turn WHERE turn IS NOT NULL
          WITH turn ORDER BY turn.order DESC, turn.createdAt DESC
          LIMIT toInteger($maxTurns)
          RETURN collect({
            id: turn.id,
            role: turn.role,
            content: turn.content,
            parts: turn.parts,
            order: turn.order,
            createdAt: toString(turn.createdAt)
          }) AS recentTurnsDesc
        }
        RETURN
          t.id AS threadId,
          toString(t.createdAt) AS createdAt,
          toString(t.lastTurnAt) AS lastTurnAt,
          coalesce(t.mode, 'default') AS mode,
          coalesce(t.kind, 'reflective') AS kind,
          t.title AS title,
          reverse(recentTurnsDesc) AS turns
        `,
        { userId, threadId, maxTurns: MAX_REPLAY_TURNS }
      )
    )
    const record = result.records[0]
    if (!record) return null
    const turnsRaw = (record.get('turns') as Array<Record<string, unknown>>) ?? []
    const turns: ConversationTurnRecord[] = turnsRaw
      .filter((row) => row && typeof row.id === 'string')
      .map((row) => ({
        id: row.id as string,
        role: row.role as ConversationTurnRole,
        content: typeof row.content === 'string' ? row.content : '',
        parts: parseStoredParts(row.parts),
        order: Number(row.order ?? 0),
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      }))
    return {
      id: record.get('threadId') as string,
      createdAt: (record.get('createdAt') as string) ?? '',
      lastTurnAt: (record.get('lastTurnAt') as string) ?? null,
      mode: (record.get('mode') as string) ?? 'default',
      kind: (record.get('kind') as string) ?? 'reflective',
      title: (record.get('title') as string | null) ?? null,
      turns,
    }
  } catch (error) {
    console.warn('[conversation-thread] getThread failed:', error instanceof Error ? error.message : error)
    return null
  } finally {
    await session.close()
  }
}

/**
 * Create a brand-new empty thread for the user.
 *
 * Authorization + listing flow through the `HAS_THREAD` edge, not a
 * property — every thread the user can see hangs off the user node.
 */
export async function createConversationThread(
  userId: string
): Promise<{ threadId: string }> {
  if (!userId) throw new Error('createConversationThread: userId is required')
  const newId = `thread_${randomUUID()}`
  const session = driver.session()
  try {
    await session.executeWrite(async (tx) =>
      tx.run(
        `
        MATCH (p:Person:User {id: $userId})
        CREATE (p)-[:HAS_THREAD]->(t:ConversationThread {
          id: $threadId,
          createdAt: datetime(),
          lastTurnAt: datetime(),
          turnCount: 0,
          mode: 'default',
          kind: 'reflective'
        })
        `,
        { userId, threadId: newId }
      )
    )
    return { threadId: newId }
  } finally {
    await session.close()
  }
}

/** Persist an auto-generated title on a thread. Auth-scoped via userId. */
export async function setConversationThreadTitle(
  userId: string,
  threadId: string | undefined,
  title: string
): Promise<void> {
  if (!userId) return
  const session = driver.session()
  try {
    await session.executeWrite(async (tx) => {
      if (threadId) {
        return tx.run(
          `MATCH (p:Person:User {id: $userId})-[:HAS_THREAD]->(t:ConversationThread {id: $threadId})
           SET t.title = $title`,
          { userId, threadId, title }
        )
      }
      // No explicit threadId — update the most recently active thread.
      return tx.run(
        `MATCH (p:Person:User {id: $userId})-[:HAS_THREAD]->(t:ConversationThread)
         WITH t ORDER BY t.lastTurnAt DESC LIMIT 1
         SET t.title = $title`,
        { userId, title }
      )
    })
  } finally {
    await session.close()
  }
}
