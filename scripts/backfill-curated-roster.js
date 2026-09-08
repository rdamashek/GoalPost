/**
 * GOAL-346 — backfill `curated` on pre-existing HAS_PERSON edges.
 *
 * WHY THIS IS REQUIRED, not optional.
 *
 * The roster filter hides a person who has an EXTRACTED_FROM edge and whose
 * HAS_PERSON edge is not marked `curated`. At the instant of deploy that reads
 * correctly: ingestion-attached people carry EXTRACTED_FROM, hand-added people
 * do not.
 *
 * It does not stay correct. `update_person` (src/lib/chat/hitl.ts ~1990)
 * appends `MERGE (p)-[:EXTRACTED_FROM]->(d)` to a person who ALREADY exists
 * whenever a later document names them. A member added by hand months ago
 * carries no `curated` flag, so the first upload that mentions them evicts
 * them from the roster — silently, driven by somebody else's upload.
 *
 * Marking every pre-existing hand-added edge curated closes that: afterwards,
 * an uncurated edge reliably means "attached by ingestion", which is exactly
 * what the filter assumes.
 *
 * THE RULE. An edge is treated as hand-added when the person has no
 * EXTRACTED_FROM edge to a document held by THAT SAME field. The per-field
 * qualifier matters: a person may be extracted in field A and added by hand to
 * field B, and only A's edge should stay uncurated.
 *
 * Idempotent — re-running sets the same edges to the same value. Safe to run
 * before or after the code deploy: until the code ships nothing reads the
 * flag, and after it ships this only ever makes people MORE visible.
 *
 * Usage:
 *   node scripts/backfill-curated-roster.js                    # dry run, dev
 *   node scripts/backfill-curated-roster.js --apply            # writes to dev
 *   node scripts/backfill-curated-roster.js demo               # dry run, demo
 *   node scripts/backfill-curated-roster.js demo --apply       # writes to demo
 *
 * The optional first argument is a PROFILE resolving to `.env.<profile>`,
 * matching `scripts/clone-neo4j.ts`: `local` (default, dev), `demo`,
 * `production`. Env files are resolved against the REPO ROOT rather than
 * process.cwd(), so running from another directory cannot silently target a
 * different database. Always read the dry-run count before applying.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import neo4j from 'neo4j-driver'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

/**
 * Minimal env-file reader — deliberately NOT dotenv, which mutates
 * process.env. Reading each profile into its own object is what keeps two
 * profiles from colliding on the same variable names (the same reasoning
 * clone-neo4j.ts and migrate-prod-to-dev.ts document).
 */
function readEnvFile(filename) {
  const filePath = path.join(REPO_ROOT, filename)
  if (!fs.existsSync(filePath)) return {}
  const out = {}
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

// Anchored on the field's OWN documents: `(c)-[:HAS_DOCUMENT]->(d)`. A person
// extracted somewhere else entirely is hand-added as far as THIS field is
// concerned, and should keep their roster place here.
const MATCH_HAND_ADDED = `
  MATCH (c:FieldContext)-[hp:HAS_PERSON]->(p:Person)
  WHERE hp.curated IS NULL
    AND NOT EXISTS {
      MATCH (p)-[:EXTRACTED_FROM]->(d:Document)<-[:HAS_DOCUMENT]-(c)
    }
`

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const profile = args.find((a) => !a.startsWith('--')) || 'local'
  const envFile = `.env.${profile}`
  const env = readEnvFile(envFile)

  const uri = env.NEO4J_URI
  // `.env.local` uses NEO4J_USERNAME; init-db.js reads NEO4J_USER but masks
  // the difference behind a 'neo4j' default. Accept both, prefer the one the
  // env actually sets.
  const user = env.NEO4J_USERNAME || env.NEO4J_USER
  const password = env.NEO4J_PASSWORD

  // No localhost defaults here, unlike init-db.js: this script WRITES to
  // whatever it connects to, and silently falling back to a local database
  // would make a misconfigured run look like a successful one.
  if (!uri || !user || !password) {
    console.error(
      `Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD in ${envFile}.`
    )
    process.exit(1)
  }
  // Print the profile AND the host every run: this script writes, and the
  // single most costly mistake it can make is writing to the wrong database.
  const host = (() => {
    try {
      return new URL(uri).host
    } catch {
      return uri
    }
  })()
  console.log(`Profile: ${profile}  (${envFile})`)
  console.log(`Target:  ${host}\n`)

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password))
  const session = driver.session()

  try {
    // Report the whole picture first, so the operator can sanity-check the
    // split before writing anything.
    const survey = await session.run(`
      MATCH (:FieldContext)-[hp:HAS_PERSON]->(:Person)
      RETURN count(hp) AS total,
             count(CASE WHEN hp.curated = true THEN 1 END) AS alreadyCurated
    `)
    const totals = survey.records[0]
    console.log(`HAS_PERSON edges total:      ${totals.get('total')}`)
    console.log(`already curated:             ${totals.get('alreadyCurated')}`)

    const candidates = await session.run(
      `${MATCH_HAND_ADDED} RETURN count(hp) AS n`
    )
    const n = candidates.records[0].get('n')
    console.log(`hand-added, to be curated:   ${n}`)

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply to write.')
      return
    }

    const result = await session.run(
      `${MATCH_HAND_ADDED} SET hp.curated = true RETURN count(hp) AS n`
    )
    console.log(`\nMarked curated: ${result.records[0].get('n')}`)
  } finally {
    await session.close()
    await driver.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
