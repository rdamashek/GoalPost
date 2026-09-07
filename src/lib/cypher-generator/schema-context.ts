/**
 * Schema descriptor for the AI Cypher generator.
 *
 * Sourced from `kb/05-data-entities.md`. Two roles:
 *
 *   1. SCHEMA_DOC — a compact textual description fed into the generator's
 *      system prompt so the LLM knows what labels, properties, and
 *      relationships actually exist in GoalPost's Neo4j graph.
 *   2. ALLOWED_LABELS / ALLOWED_RELATIONSHIPS — the validator's whitelist.
 *      Any `:LabelName` or `[:REL_TYPE]` token in generated Cypher that
 *      does not appear here is rejected before execution.
 *
 * Keep these in sync when entities or relationships are added/renamed in
 * the schema. Conversation* nodes and Log are deliberately excluded —
 * they are not meaningful to render in a graph canvas and surfacing them
 * would blow past the relevance budget.
 */

export const ALLOWED_LABELS = [
  // Identity / membership
  'Person',
  'User',
  'PersonPulse',
  'SpaceMembership',
  'Community',
  // First-class organization named in an uploaded document (GOAL-298). Nodes
  // carry ["Organization","LifeSensor","RelationalEntity"]; match the
  // load-bearing :Organization label. Attached to a FieldContext via
  // HAS_ORGANIZATION and linked to the pulses it relates to via MENTIONED_IN.
  'Organization',
  // Containers
  'Space',
  'MeSpace',
  'WeSpace',
  // Content
  'FieldContext',
  'FieldPulse',
  'GoalPulse',
  'ResourcePulse',
  'StoryPulse',
  'CarePulse',
  'CoreValuePulse',
  // Legacy / provenance marker carried by every MIGRATED core value (GOAL-287).
  // Backfilled DBs hold `FieldPulse:CoreValuePulse:CoreValue`; an un-backfilled
  // env (a demo box cloned before the backfill) still holds the pre-GOAL-287
  // shape `FieldPulse:StoryPulse:CoreValue` — no `:CoreValuePulse` at all.
  // Without `CoreValue` whitelisted here those values were DOUBLY invisible to
  // query_for_bloom (the generator could not name the label, and a lucky guess
  // was rejected by the validator), so "show me all core values" came back
  // empty while `search_pulses` — which bridges the same label in
  // pulse.service.ts `typeFilterCypher()` — found them. That divergence was
  // GOAL-333. Whitelisting only lets the generator TRAVERSE the label; node
  // visibility is still gated by the post-execute Space filter in execute.ts.
  'CoreValue',
  // Relational discoveries
  'ResonanceLink',
  'FieldResonance',
  // Connective container (reified connector, like ResonanceLink — NOT a pulse
  // subtype). Wraps a migrated care point so "show surrounding relationships"
  // has a starting point. Surfaced inside a FieldContext via HAS_WEAVE.
  'PromiseWeave',
  // Uploaded source document attached to a FieldContext. The resource/goal/
  // story pulses (and persons) extracted from it trace back via EXTRACTED_FROM.
  // Without this label whitelisted, "what documents led to these resources?"
  // was a silent dead end — the generator could neither name :Document nor
  // traverse to it. Its human label is `filename`.
  'Document',
] as const

export type AllowedLabel = (typeof ALLOWED_LABELS)[number]

export const ALLOWED_RELATIONSHIPS = [
  'OWNS',
  'HAS_MEMBER',
  'IS_MEMBER',
  'HAS_CONTEXT',
  // Nested sub-contexts (GOAL-295): (parent:FieldContext)-[:HAS_SUBCONTEXT]->
  // (child:FieldContext). A pure hierarchy overlay — every context, nested or
  // not, ALSO keeps its own (Space)-[:HAS_CONTEXT] edge, so the post-execute
  // Space anchor in execute.ts keeps working for children unchanged.
  'HAS_SUBCONTEXT',
  'HAS_PULSE',
  // A FieldContext surfaces the people in its relational world via HAS_PERSON
  // → (:Person). The target is USUALLY a non-member (:Person:PersonPulse) but
  // can be a :Person:User (the uploader self-links their own node on ingest),
  // so match the base :Person label and filter membership by the :User label.
  // Without this edge whitelisted the generator cannot reach contacts attached
  // to a field, so "show the non-members connected to me" came back empty
  // (GOAL-277).
  'HAS_PERSON',
  // A FieldContext surfaces the organizations in its relational world via
  // HAS_ORGANIZATION → (:Organization) (GOAL-298). Parallels HAS_PERSON.
  'HAS_ORGANIZATION',
  // A Person or Organization named in / related to a pulse (but not its author)
  // is linked to that pulse via MENTIONED_IN (GOAL-298). Authorship stays on
  // INITIATED_BY; MENTIONED_IN is the "related to / appears in" edge. Written by
  // the doc-ingestion link path. (person|org)-[:MENTIONED_IN]->(:FieldPulse).
  'MENTIONED_IN',
  'HAS_RESONANCE',
  // PromiseWeave edges — directly analogous to ResonanceLink's
  // SOURCE/TARGET/HAS_RESONANCE. A weave WEAVES the pulse(s) it connects, is
  // WOVEN_FOR the person it concerns, and is surfaced inside its FieldContext
  // via a HAS_WEAVE context edge.
  'WEAVES',
  'WOVEN_FOR',
  'HAS_WEAVE',
  // Document provenance edges. A FieldContext HAS_DOCUMENT each uploaded source
  // doc; a pulse (or person) points at the doc it was EXTRACTED_FROM; the doc
  // was UPLOADED_BY a member. These let the assistant answer "what documents
  // are associated with these resources?" — a ResourcePulse reaches its source
  // via (resource)-[:EXTRACTED_FROM]->(:Document). Node visibility stays gated
  // by the post-execute Space filter (Document anchors through HAS_DOCUMENT).
  'HAS_DOCUMENT',
  'EXTRACTED_FROM',
  'UPLOADED_BY',
  // Pulse authorship — TWO live edges, written by different surfaces.
  // INITIATED_BY is the canonical author edge (assistant + doc-ingest paths:
  // lib/chat/hitl.ts, api/pulse/create-from-conversation); CREATED_BY is
  // still written by the dashboard create flow and the CSV/document imports
  // (and also exists, unrelated to pulse authorship, on Log/FieldContext/
  // PromiseWeave). Authorship queries must match the alternation
  // [:INITIATED_BY|CREATED_BY] — either edge alone silently drops the other
  // surface's pulses ("show pulses by X" was a dead end for assistant-created
  // pulses while only CREATED_BY was whitelisted). Display-side resolution
  // lives in src/lib/pulse-author.ts.
  'INITIATED_BY',
  'CREATED_BY',
  'CONNECTED_TO',
  'SOURCE',
  'TARGET',
  'RESONATES_AS',
  // Semantic ontology edges between pulses (and pulse↔person/community).
  // These are the migrated GoalPost ontology relationships — a Goal
  // ENABLES a Story, a Goal DEPENDS_ON a Resource, a Goal is ALIGNED_TO a
  // CoreValue, a Person PROVIDES a Resource, etc. They are PUBLIC schema
  // surface (unlike the private internals LOGGED_FOR / CONTEXT /
  // HAS_THREAD / HAS_TURN / HAS_CHUNK, which stay off this list), so the
  // generator may traverse them. Node visibility is still gated by the
  // post-execute Space auth filter in execute.ts — whitelisting an edge
  // type never bypasses canViewContent.
  'ENABLES',
  'ENABLED_BY',
  'DEPENDS_ON',
  'APPLIED_TO',
  'APPLIED_IN',
  'ALIGNED_TO',
  'CARES_FOR',
  'MOTIVATED_BY',
  'EMBRACES',
  'PROVIDES',
  'HAS_ACCESS_TO',
  'GUIDED_BY',
] as const

export type AllowedRelationship = (typeof ALLOWED_RELATIONSHIPS)[number]

export const ALLOWED_LABELS_SET: ReadonlySet<string> = new Set(ALLOWED_LABELS)
export const ALLOWED_RELATIONSHIPS_SET: ReadonlySet<string> = new Set(
  ALLOWED_RELATIONSHIPS
)

/**
 * The schema description shown to the Cypher-generation LLM. Stays small
 * but exhaustive enough that the model can write correct queries against
 * any of the labels above. Kept inline (not loaded from KB at runtime) so
 * the production prompt is deterministic and the bundle has no fs read.
 */
export const SCHEMA_DOC = `
GoalPost Neo4j schema (read-only). Use only the labels and relationship types listed.

# Labels and key properties

Person { id, firstName, lastName, name, email, pronouns, photo, location, careManual, passions, traits, fieldsOfCare, interests }
  - Every human is a :Person. An ADJACENT label distinguishes platform access:
      :User        → a MEMBER — a registered platform user who can log in, owns a MeSpace, creates pulses. Labels: ["Person","User"].
      :PersonPulse → a NON-MEMBER — someone in a user's relational world (a contact, family, colleague) with no platform login. Labels: ["Person","PersonPulse"].
      (neither)    → a bare :Person — a NON-MEMBER contact/imported record not yet classified. Labels: ["Person"].
  - "member(s)" / "platform user(s)" / "people on GoalPost" ⇒ :Person:User.
  - "non-member(s)" / "contacts" / "people NOT on the platform" / "my relational world" ⇒ a :Person that is NOT a :User (a bare :Person or a :Person:PersonPulse).
  - To match ONLY non-members, filter by the ABSENCE of the User label with a WHERE predicate: \`MATCH (x:Person) WHERE NOT x:User\`. Do NOT assume every Person is a :User — most Persons in the graph are non-members.
  - To match ONLY members, add the label to the pattern: \`MATCH (x:Person:User)\` or \`WHERE x:User\`.

Space { id, name, description, visibility, why, location, createdAt }
  - Always co-labeled as MeSpace or WeSpace.

MeSpace : Space  — one per Person, owned by exactly one Person.
WeSpace : Space  — collaborative, owner + members.

SpaceMembership { id, role, addedAt } — role ∈ {ADMIN, MEMBER, GUEST}.

Community { id, name, description } — a public collective (e.g. "GoalPost Core Team"). Communities are NOT private — every authenticated user can see them and discover other members.

Organization { id, name, description, createdAt }
  - An organization / group / company / cooperative / institution named in an uploaded document (e.g. "Artisan Cooperative"). Its own type — NOT a Person and NOT a pulse. Nodes carry ["Organization","LifeSensor","RelationalEntity"]; match the \`:Organization\` label. Attached to a FieldContext via HAS_ORGANIZATION and linked to the pulses it relates to via MENTIONED_IN. When the user names an organization (or asks to show one), MATCH \`:Organization\` — these nodes are invisible to any query that omits the label.

FieldContext { id, title, emergentName, createdAt }
  - Belongs to exactly one Space (every context — nested or not — has its own
    direct HAS_CONTEXT edge from that Space).
  - Contexts can be NESTED (GOAL-295): a parent field holds sub-fields via
    (parent)-[:HAS_SUBCONTEXT]->(child), up to 5 levels deep. When the user
    asks about "sub-fields" / "sub-contexts" / what's "inside" or "under" a
    field, traverse HAS_SUBCONTEXT.

FieldPulse { id, title, content, status, intensity, horizon, why, location, time, createdAt }
  - Always co-labeled with one specific pulse subtype:
    GoalPulse, ResourcePulse, StoryPulse, CarePulse, CoreValuePulse.
  - ResourcePulse additionally carries:
      resourceType — free-text kind of resource, stored lower-cased
        ('article', 'book', 'podcast', 'ontology', 'event', …). This is what
        "show me the books / podcasts in this field" should filter on. It is
        NOT an enum, so prefer toLower(p.resourceType) = 'book' over an exact
        match, and never assume the full value set.
      sourceUrl — where the resource was FOUND (a LinkedIn post, a
        newsletter), as distinct from location, which is the resource itself.

CORE VALUES — read this before writing any query about values.
  A "core value" / "value" is a pulse, but it does NOT always carry the
  \`:CoreValuePulse\` label. Migrated values carry a \`:CoreValue\` provenance
  marker, and in an environment that predates the relabel they carry ONLY
  \`FieldPulse:StoryPulse:CoreValue\` — matching \`(:CoreValuePulse)\` there
  returns NOTHING even though the person can plainly see their values.
  So NEVER match a value as \`(v:CoreValuePulse)\` alone, and never anchor on
  \`(v:CoreValue)\` either — only \`FieldPulse.id\` is indexed, so a bare
  \`:CoreValue\` pattern forces a full label scan. ALWAYS match the base label
  and test BOTH markers in a WHERE predicate. Keep the traversal ANCHORED on
  the user — an unanchored \`MATCH (ctx:FieldContext)-[:HAS_PULSE]->(v)\` plans a
  CartesianProduct against a label scan of EVERY tenant's values, then the
  runtime's authorization filter discards nearly all of it, leaving the person
  with an almost-empty canvas:

      MATCH (user:Person {id: $userId})-[:OWNS]->(:Space)-[hc:HAS_CONTEXT]->(ctx:FieldContext)-[hp:HAS_PULSE]->(v:FieldPulse)
      WHERE v:CoreValuePulse OR v:CoreValue

  The same rule applies wherever you filter values — enumeration, keyword
  lookup, or an expansive sweep. A \`:StoryPulse\` that also carries
  \`:CoreValue\` IS a value, not a story.

ResonanceLink { id, label, description, confidence, evidence, status }
  - Connects two FieldPulses via SOURCE / TARGET.

PromiseWeave { id, title, description, status, origin, createdAt, modifiedAt }
  - A connective CONTAINER node — its own type, NOT a pulse subtype (just like
    ResonanceLink). Gathers the pulses and the person a promise implicates so
    its neighbourhood is navigable. Its human label is "title". Surfaced inside
    a FieldContext via a HAS_WEAVE context edge (exactly as ResonanceLink is
    surfaced via HAS_RESONANCE). When the user names a "promise weave" /
    "weave", or asks to show a node whose title matches a PromiseWeave title,
    MATCH the \`:PromiseWeave\` label — these nodes are invisible to any query
    that omits it.
  - "description" says why the woven things belong together.
  - "status" is the lifecycle: proposed / active / fulfilled / dissolved. It is
    NOT reliably cased or complete — weaves carried over from migrated care
    points hold values like "Active" and "Inactive", and some hold nothing at
    all (which means active). So filter it case-insensitively and tolerate
    null, e.g. \`toLower(coalesce(w.status,'active')) = 'proposed'\`. Never
    \`w.status = 'active'\`, which silently drops most weaves.
  - "origin" is who authored it: "user" (a member), "ai" (proposed by
    discovery, awaiting confirmation), or null (built by the migration).

FieldResonance { label, description } — semantic theme node.

Document { id, filename, mimeType, summary, concepts, uploadedAt }
  - An uploaded SOURCE FILE (an article, PDF, note) attached to a FieldContext.
    Its human label is "filename" — caption Documents by filename, never by id,
    blobKey, or blobUrl (those are internal). When a member uploads articles
    into a field, each article becomes a Document, and the ResourcePulses /
    GoalPulses / StoryPulses (and Persons) the extractor pulled out of it point
    back at the Document via EXTRACTED_FROM. This is how "the documents that led
    to these resources" are reached. When the user asks about "documents",
    "source documents", "uploaded files/articles", or "where a resource came
    from", MATCH the \`:Document\` label — these nodes are invisible to any query
    that omits it.

# Relationships (directed)

(Person)-[:OWNS]->(Space)
(Space)-[:HAS_MEMBER]->(SpaceMembership)
(SpaceMembership)-[:IS_MEMBER]->(Person)
(Space)-[:HAS_CONTEXT]->(FieldContext)
(FieldContext)-[:HAS_SUBCONTEXT]->(FieldContext)   // nested sub-field (GOAL-295). Hierarchy overlay only — the child ALSO has its own HAS_CONTEXT edge from the same Space.
(FieldContext)-[:HAS_PULSE]->(FieldPulse)
(FieldContext)-[:HAS_PERSON]->(Person)   // people attached to a field's relational world — usually a non-member (:Person:PersonPulse), but occasionally the :Person:User uploader who self-linked. Match base :Person and filter membership by the :User label.
(FieldContext)-[:HAS_ORGANIZATION]->(Organization)   // organizations attached to a field's relational world (GOAL-298). Parallels HAS_PERSON.
(Person)-[:MENTIONED_IN]->(FieldPulse)         // a person named in / related to a pulse but NOT its author. Authorship is INITIATED_BY|CREATED_BY; MENTIONED_IN is the "appears in / related to" edge.
(Organization)-[:MENTIONED_IN]->(FieldPulse)   // an organization named in / related to a pulse (e.g. the cooperative that offers a resource).
(FieldContext)-[:HAS_RESONANCE]->(ResonanceLink)
(ResonanceLink)-[:SOURCE]->(FieldPulse)
(ResonanceLink)-[:TARGET]->(FieldPulse)
(ResonanceLink)-[:RESONATES_AS]->(FieldResonance)
(FieldContext)-[:HAS_WEAVE]->(PromiseWeave)
(PromiseWeave)-[:WEAVES]->(FieldPulse)     // the care point(s) it connects (1..n)
(PromiseWeave)-[:WOVEN_FOR]->(Person)      // the person it concerns
(PromiseWeave)-[:CREATED_BY]->(Person)     // authorship
(FieldContext)-[:HAS_DOCUMENT]->(Document) // an uploaded source file attached to the field
(FieldPulse)-[:EXTRACTED_FROM]->(Document) // the resource/goal/story pulse was extracted from this document — the "source document" for that pulse
(Person)-[:EXTRACTED_FROM]->(Document)     // a person the extractor surfaced from this document
(Document)-[:UPLOADED_BY]->(Person)        // the member who uploaded it (a :Person:User)
(FieldPulse)-[:INITIATED_BY]->(Person)   // canonical author edge — who made / is credited for this pulse. Written by the assistant + doc-ingest paths; doc-ingested pulses point at the extracted author (often a :Person:PersonPulse), not the uploader.
(FieldPulse)-[:CREATED_BY]->(Person)     // same meaning, written by the dashboard create flow and imports. NEITHER edge alone covers all pulses — ALWAYS match authorship as [:INITIATED_BY|CREATED_BY].
(Person)-[:CONNECTED_TO]-(Person)  // bidirectional
(Community)-[:HAS_MEMBER]->(Person)  // direct community membership (no intermediary node)
(Community)-[:OWNS]->(Space)         // a community can own a WeSpace

# Semantic pulse relationships (the GoalPost ontology — directed)

Pulses are NOT connected only through ResonanceLink. Migrated GoalPost
content carries DIRECT, typed edges between pulses (and between pulses and
the people/communities they involve). When a user asks to "expand",
"explore", or see the "surrounding relationships" of a pulse, these are
usually the edges they mean — alongside the structural HAS_PULSE edge and
the INITIATED_BY|CREATED_BY author edges. A query that omits them will look
empty even though the pulse is richly connected.

(GoalPulse)-[:DEPENDS_ON]->(ResourcePulse)     // a goal needs a resource ("supporting resources")
(StoryPulse)-[:DEPENDS_ON]->(ResourcePulse)
(GoalPulse)-[:ENABLES]->(StoryPulse)           // a goal enables a story/outcome ("enabled goals")
(StoryPulse)-[:ENABLED_BY]->(GoalPulse)        // inverse of ENABLES
(ResourcePulse)-[:APPLIED_TO]->(GoalPulse)     // a resource applied to a goal
(ResourcePulse)-[:APPLIED_IN]->(StoryPulse)
(GoalPulse)-[:ALIGNED_TO]->(CoreValuePulse)    // a goal aligned to a value
(StoryPulse)-[:CARES_FOR]->(GoalPulse)
(Person)-[:MOTIVATED_BY]->(GoalPulse)          // a person motivated by a goal
(Person)-[:PROVIDES]->(ResourcePulse)          // a person provides a resource
(Person)-[:EMBRACES]->(CoreValuePulse)         // a person embraces a value
(Person)-[:HAS_ACCESS_TO]->(ResourcePulse)
(StoryPulse)-[:GUIDED_BY]->(Person)

These edges run in BOTH directions depending on subtype, so match them
WITHOUT an arrow — \`(focal)-[r:ENABLES|DEPENDS_ON|…]-(other)\` — to catch
incoming and outgoing without guessing direction.

Intent phrasing → edge:
- "enabled goals" / "what does this enable" → ENABLES / ENABLED_BY (a GoalPulse / StoryPulse)
- "supporting resources" / "resources it depends on" → DEPENDS_ON / APPLIED_TO / APPLIED_IN (a ResourcePulse)
- "values it aligns to" → ALIGNED_TO (a CoreValuePulse)
- "who is motivated by / provides this" → MOTIVATED_BY / PROVIDES (a Person)
- "who created / authored / added this pulse" / "pulses by <person>" / "<person>'s contributions" → (FieldPulse)-[:INITIATED_BY|CREATED_BY]->(Person)
- "documents" / "source documents" / "uploaded files/articles" / "what documents led to these resources" / "where did this resource come from" → (:Document), reached via (:FieldContext)-[:HAS_DOCUMENT]->(:Document) for a field's docs, and via (:FieldPulse)-[:EXTRACTED_FROM]->(:Document) for the source doc(s) behind specific pulses

NOTE on HAS_MEMBER: it has two valid domains.
  (Space)-[:HAS_MEMBER]->(SpaceMembership)  // Space membership goes through a SpaceMembership node carrying the role
  (Community)-[:HAS_MEMBER]->(Person)       // Community membership is a direct edge to Person, no role node

# Access pattern

Every viewable node reaches a Space OR a Community the current user can see:
- Space access: the user OWNS the Space, OR
  (Space)-[:HAS_MEMBER]->(:SpaceMembership)-[:IS_MEMBER]->(:Person {id: $userId})
- Community access: communities are public to all authenticated users.
  (Community)-[:HAS_MEMBER]->(:Person {id: $userId})  // or just any Community node — visibility is permissive

This makes Community a useful bridge node for path-finding between two Persons who share no Space — e.g. "How is X connected to Y?" can travel (X)<-[:HAS_MEMBER]-(c:Community)-[:HAS_MEMBER]->(Y).

# Conventions

- All ids are stored on the node as the property "id" (string).
- Names: Space.name, FieldContext.title (fallback: emergentName), FieldPulse.title.
- Person names: \`Person.name\` is OFTEN NULL — most Persons only carry \`firstName\` + \`lastName\`. When matching a Person by a user-typed name, do NOT use \`a.name\` alone. Use the four-clause tolerant predicate (CONTAINS over \`name\`, \`firstName\`, \`lastName\`, and the trimmed \`firstName + ' ' + lastName\` concatenation) so single-token, partial, and full-name inputs all match.
- Pulse subtypes share the FieldPulse base — match on FieldPulse for cross-type queries,
  match on the subtype label (e.g. GoalPulse) when filtering by type.
`.trim()
