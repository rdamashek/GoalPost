import * as XLSX from 'xlsx'
import {
  buildArticleImportMessage,
  buildArticleRowContent,
  normalizeArticleDate,
  normalizeArticleResourceType,
  normalizeArticleUrl,
  parseArticleRows,
  resolveArticlePulseType,
  summarizeArticleOutcomes,
  validateArticleTemplateHeaders,
  type ArticleImportRowInput,
  type ArticleImportSummary,
  type PersistedArticleRowOutcome,
} from './article-import'
import { parseSpreadsheetArrayBuffer } from './article-sheet-parser'

/**
 * GOAL-317 — unit tests for the shared article-import parsing/validation
 * helpers. Pure functions only; the Neo4j-backed service
 * (article-import-service.ts) is intentionally out of scope here.
 */

function makeRowInput(
  overrides: Partial<ArticleImportRowInput> = {}
): ArticleImportRowInput {
  return {
    row: 2,
    title: 'Mutual aid networks after the storm',
    author: 'Amara Osei',
    date: '2026-05-14',
    url: 'https://example.org/articles/mutual-aid',
    pulseType: 'ResourcePulse',
    ...overrides,
  }
}

function stringToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value)
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

describe('normalizeArticleUrl', () => {
  it('passes https URLs through verbatim', () => {
    expect(normalizeArticleUrl('https://example.org/articles/1')).toBe(
      'https://example.org/articles/1'
    )
  })

  it('passes http URLs through (no forced upgrade)', () => {
    expect(normalizeArticleUrl('http://example.org/a')).toBe(
      'http://example.org/a'
    )
  })

  it('accepts a scheme in any case', () => {
    expect(normalizeArticleUrl('HTTP://Example.org/Path')).toBe(
      'HTTP://Example.org/Path'
    )
  })

  it('prefixes https:// on bare domains', () => {
    expect(normalizeArticleUrl('example.org')).toBe('https://example.org')
  })

  it('prefixes https:// on domains with path, query, and fragment', () => {
    expect(normalizeArticleUrl('news.example.co.uk/story?id=7#top')).toBe(
      'https://news.example.co.uk/story?id=7#top'
    )
  })

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeArticleUrl('  example.org/report  ')).toBe(
      'https://example.org/report'
    )
  })

  it('returns null for free text that is not a URL', () => {
    expect(normalizeArticleUrl('not a url')).toBeNull()
    expect(normalizeArticleUrl('garbage!!')).toBeNull()
  })

  it('returns null for empty and whitespace-only values', () => {
    expect(normalizeArticleUrl('')).toBeNull()
    expect(normalizeArticleUrl('   ')).toBeNull()
  })

  it('returns null for a dotless single word', () => {
    expect(normalizeArticleUrl('localhost')).toBeNull()
  })

  it('returns null for a scheme with no host', () => {
    expect(normalizeArticleUrl('https://')).toBeNull()
  })

  it('rejects non-http(s) schemes', () => {
    expect(normalizeArticleUrl('ftp://files.example.org/doc')).toBeNull()
    expect(normalizeArticleUrl('mailto:amara@example.org')).toBeNull()
    expect(normalizeArticleUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('normalizeArticleDate', () => {
  it('passes ISO YYYY-MM-DD dates through', () => {
    expect(normalizeArticleDate('2026-05-14')).toBe('2026-05-14')
  })

  it('reduces ISO datetimes to the date part', () => {
    expect(normalizeArticleDate('2026-05-14T18:45:00Z')).toBe('2026-05-14')
  })

  it('normalizes long-form month dates to YYYY-MM-DD', () => {
    expect(normalizeArticleDate('May 14, 2026')).toBe('2026-05-14')
    expect(normalizeArticleDate('14 March 2026')).toBe('2026-03-14')
  })

  it('normalizes slashed numeric dates to YYYY-MM-DD', () => {
    expect(normalizeArticleDate('05/14/2026')).toBe('2026-05-14')
  })

  it('trims whitespace around a parseable date', () => {
    expect(normalizeArticleDate('  2026-05-14  ')).toBe('2026-05-14')
  })

  it('keeps unparseable free text verbatim (pulse time is a free string)', () => {
    expect(normalizeArticleDate('Spring 2026')).toBe('Spring 2026')
    expect(normalizeArticleDate('Q2 2026')).toBe('Q2 2026')
    expect(normalizeArticleDate('mid-2026')).toBe('mid-2026')
    expect(normalizeArticleDate('Summer of 2025')).toBe('Summer of 2025')
  })

  it('keeps a bare year verbatim rather than inventing January 1', () => {
    expect(normalizeArticleDate('2026')).toBe('2026')
  })

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeArticleDate('')).toBe('')
    expect(normalizeArticleDate('   ')).toBe('')
  })
})

describe('resolveArticlePulseType', () => {
  it('defaults blank values to ResourcePulse (articles are resources)', () => {
    expect(resolveArticlePulseType(undefined)).toBe('ResourcePulse')
    expect(resolveArticlePulseType('')).toBe('ResourcePulse')
    expect(resolveArticlePulseType('   ')).toBe('ResourcePulse')
  })

  it('resolves goal keywords to GoalPulse', () => {
    expect(resolveArticlePulseType('goal')).toBe('GoalPulse')
    expect(resolveArticlePulseType('Goals')).toBe('GoalPulse')
  })

  it('resolves resource and article keywords to ResourcePulse', () => {
    expect(resolveArticlePulseType('resource')).toBe('ResourcePulse')
    expect(resolveArticlePulseType('resources')).toBe('ResourcePulse')
    expect(resolveArticlePulseType('article')).toBe('ResourcePulse')
    expect(resolveArticlePulseType('Articles')).toBe('ResourcePulse')
  })

  it('resolves story keywords to StoryPulse', () => {
    expect(resolveArticlePulseType('story')).toBe('StoryPulse')
    expect(resolveArticlePulseType('Stories')).toBe('StoryPulse')
  })

  it('accepts Pulse-suffixed variants', () => {
    expect(resolveArticlePulseType('GoalPulse')).toBe('GoalPulse')
    expect(resolveArticlePulseType('resource_pulse')).toBe('ResourcePulse')
    expect(resolveArticlePulseType('story-pulse')).toBe('StoryPulse')
    expect(resolveArticlePulseType('Story Pulse')).toBe('StoryPulse')
  })

  it('returns null for unsupported types so the row fails loudly', () => {
    expect(resolveArticlePulseType('meeting')).toBeNull()
    expect(resolveArticlePulseType('care')).toBeNull()
  })
})

describe('normalizeArticleResourceType', () => {
  it('lower-cases so "Book" and "book" land in one filterable bucket', () => {
    expect(normalizeArticleResourceType('Book')).toBe('book')
    expect(normalizeArticleResourceType('BOOK')).toBe('book')
    expect(normalizeArticleResourceType('book')).toBe('book')
  })

  it('trims and collapses internal whitespace', () => {
    expect(normalizeArticleResourceType('  Blog   Post ')).toBe('blog post')
  })

  it("accepts a member's own vocabulary rather than enforcing an enum", () => {
    expect(normalizeArticleResourceType('Ontology')).toBe('ontology')
    expect(normalizeArticleResourceType('Podcast')).toBe('podcast')
    expect(normalizeArticleResourceType('Event')).toBe('event')
  })

  it('returns undefined for blank input so the caller can default', () => {
    expect(normalizeArticleResourceType('')).toBeUndefined()
    expect(normalizeArticleResourceType('   ')).toBeUndefined()
    expect(normalizeArticleResourceType(undefined)).toBeUndefined()
  })
})

describe('validateArticleTemplateHeaders', () => {
  it('accepts the canonical template headers', () => {
    const rows = [
      { title: 'T', author: 'A', date: '2026-01-01', url: 'example.org' },
    ]
    expect(validateArticleTemplateHeaders(rows)).toEqual([])
  })

  it('accepts alias headers for every required column', () => {
    const rows = [
      {
        headline: 'T',
        byline: 'A',
        pub_date: '2026-01-01',
        web_link: 'example.org',
      },
    ]
    expect(validateArticleTemplateHeaders(rows)).toEqual([])
  })

  it('reports a missing required column by its label', () => {
    const rows = [{ title: 'T', author: 'A', date: '2026-01-01' }]
    const errors = validateArticleTemplateHeaders(rows)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"URL"')
    expect(errors[0]).toContain('url, link, article_url, web_link')
  })

  it('reports all four required columns when the sheet is empty', () => {
    const errors = validateArticleTemplateHeaders([])
    expect(errors).toHaveLength(4)
    expect(errors.join(' ')).toContain('"Article title"')
    expect(errors.join(' ')).toContain('"Author"')
    expect(errors.join(' ')).toContain('"Date"')
    expect(errors.join(' ')).toContain('"URL"')
  })
})

describe('parseArticleRows', () => {
  it('maps a valid row, numbering from spreadsheet row 2', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'Mutual aid networks after the storm',
        author: 'Amara Osei',
        author_email: 'Amara@Example.org',
        date: 'May 14, 2026',
        url: 'example.org/articles/mutual-aid',
        pulse_type: 'story',
        description: 'How neighbourhood groups organised recovery support.',
      },
    ])

    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      row: 2,
      title: 'Mutual aid networks after the storm',
      author: 'Amara Osei',
      authorEmail: 'amara@example.org',
      date: '2026-05-14',
      url: 'https://example.org/articles/mutual-aid',
      pulseType: 'StoryPulse',
      description: 'How neighbourhood groups organised recovery support.',
    })
  })

  it('defaults the pulse type to ResourcePulse when the column is blank', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        pulse_type: '',
      },
    ])
    expect(errors).toEqual([])
    expect(rows[0].pulseType).toBe('ResourcePulse')
  })

  it('reads the description through its aliases', () => {
    const { rows } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        summary: 'From the summary column.',
      },
    ])
    expect(rows[0].description).toBe('From the summary column.')
  })

  it('leaves description undefined when no description column has content', () => {
    const { rows } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        description: '   ',
      },
    ])
    expect(rows[0].description).toBeUndefined()
  })

  // GOAL-355 — the two new optional columns.
  it('maps resource_type and source_url onto their own row fields', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'The World Ending Fire',
        author: 'Wendell Berry',
        date: '2026-02-01',
        url: 'https://example.org/the-world-ending-fire',
        resource_type: 'Book',
        source_url: 'https://www.linkedin.com/posts/example-share',
      },
    ])

    expect(errors).toEqual([])
    expect(rows[0].resourceType).toBe('book')
    expect(rows[0].sourceUrl).toBe(
      'https://www.linkedin.com/posts/example-share'
    )
    // The type is no longer smuggled into the title as a " - book" suffix.
    expect(rows[0].title).toBe('The World Ending Fire')
  })

  it('reads both new columns through their aliases', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        resourcetype: 'Podcast',
        sourceurl: 'example.org/where-i-found-it',
      },
    ])
    expect(errors).toEqual([])
    expect(rows[0].resourceType).toBe('podcast')
    // Bare domains get the same https:// normalization the `url` column gets.
    expect(rows[0].sourceUrl).toBe('https://example.org/where-i-found-it')
  })

  it('leaves both new fields undefined for a sheet in the old format', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'Dictionary of Radical Alternatives - ontology',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        description: 'https://www.linkedin.com/posts/example-share',
      },
    ])
    expect(errors).toEqual([])
    expect(rows[0].resourceType).toBeUndefined()
    expect(rows[0].sourceUrl).toBeUndefined()
    // Additive, not breaking: the old workaround row still imports as before.
    expect(rows[0].description).toBe(
      'https://www.linkedin.com/posts/example-share'
    )
  })

  it('treats blank new columns as absent rather than as errors', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        resource_type: '   ',
        source_url: '  ',
      },
    ])
    expect(errors).toEqual([])
    expect(rows[0].resourceType).toBeUndefined()
    expect(rows[0].sourceUrl).toBeUndefined()
  })

  it('fails a row whose source_url is not a usable http(s) link', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        source_url: 'a LinkedIn post',
      },
    ])
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('not a valid http(s) source URL')
  })

  it('refuses to strand the new columns on a non-resource row', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        pulse_type: 'story',
        resource_type: 'Book',
        source_url: 'https://example.org/found-here',
      },
    ])
    expect(rows).toEqual([])
    expect(errors[0].message).toContain(
      'resource_type and source_url only apply to resource rows'
    )
  })

  it('names only the stranded column that was actually supplied', () => {
    const { errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        pulse_type: 'goal',
        source_url: 'https://example.org/found-here',
      },
    ])
    expect(errors[0].message).toContain('source_url only applies to')
    expect(errors[0].message).not.toContain('resource_type')
  })

  it('ignores a source-ish header that is not one of the two aliases', () => {
    // A pre-GOAL-355 sheet with a hand-kept "Source link" column of prose must
    // keep importing — the narrow alias list is what protects it.
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        source_link: 'Amara sent it to me',
      },
    ])
    expect(errors).toEqual([])
    expect(rows[0].sourceUrl).toBeUndefined()
  })

  it('does not let source_url claim the required url column', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        source_url: 'https://example.org/where-i-found-it',
      },
    ])
    expect(rows).toEqual([])
    expect(errors[0].message).toContain('URL is required.')
  })

  it('skips fully empty rows silently while keeping row numbers aligned', () => {
    const { rows, errors } = parseArticleRows([
      { title: '', author: '  ', date: '', url: '' },
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
      },
      { title: 'Broken', author: '', date: '', url: '' },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].row).toBe(3)
    expect(errors).toHaveLength(1)
    expect(errors[0].row).toBe(4)
  })

  it('aggregates every problem on a row into one message', () => {
    const { rows, errors } = parseArticleRows([
      {
        author: 'A',
        date: '2026-01-01',
        url: 'not a url',
        author_email: 'not-an-email',
      },
    ])

    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Article title is required.')
    expect(errors[0].message).toContain(
      '"not a url" is not a valid http(s) URL.'
    )
    expect(errors[0].message).toContain(
      '"not-an-email" is not a valid author email.'
    )
  })

  it('distinguishes a missing URL from an invalid one', () => {
    const { errors } = parseArticleRows([
      { title: 'T', author: 'A', date: '2026-01-01', url: '' },
      { title: 'T2', author: 'A2', date: '2026-01-01', url: 'nope!!' },
    ])
    expect(errors).toHaveLength(2)
    expect(errors[0].message).toContain('URL is required.')
    expect(errors[1].message).toContain('"nope!!" is not a valid http(s) URL.')
  })

  it('rejects malformed author emails but accepts well-shaped ones', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        author_email: 'jane@newsroom',
      },
      {
        title: 'T2',
        author: 'A2',
        date: '2026-01-01',
        url: 'https://example.org/b',
        email: 'Jane@Newsroom.org',
      },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain(
      '"jane@newsroom" is not a valid author email.'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].authorEmail).toBe('jane@newsroom.org')
  })

  it('fails rows with unsupported pulse types instead of mistyping them', () => {
    const { rows, errors } = parseArticleRows([
      {
        title: 'T',
        author: 'A',
        date: '2026-01-01',
        url: 'https://example.org/a',
        pulse_type: 'meeting',
      },
    ])
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain(
      '"meeting" is not a supported pulse type'
    )
  })

  it('echoes only trimmed, non-empty cells back in error data', () => {
    const { errors } = parseArticleRows([
      {
        title: '  Broken row  ',
        author: '',
        date: '',
        url: '',
        description: '   ',
      },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0].data).toEqual({ title: 'Broken row' })
  })
})

describe('buildArticleRowContent', () => {
  it('prefers the member-supplied description, trimmed', () => {
    const row = makeRowInput({ description: '  A hand-written summary.  ' })
    expect(buildArticleRowContent(row)).toBe('A hand-written summary.')
  })

  it('falls back to a metadata sentence including the date', () => {
    const row = makeRowInput({ description: undefined })
    expect(buildArticleRowContent(row)).toBe(
      'Article by Amara Osei, published 2026-05-14: https://example.org/articles/mutual-aid'
    )
  })

  it('omits the date clause when no date is present', () => {
    const row = makeRowInput({ date: undefined, description: '   ' })
    expect(buildArticleRowContent(row)).toBe(
      'Article by Amara Osei: https://example.org/articles/mutual-aid'
    )
  })
})

describe('parseSpreadsheetArrayBuffer', () => {
  it('parses a CSV buffer and normalizes headers', () => {
    const csv = [
      'Article Title,Author Name,Pub Date,Web Link,Author Email,Pulse Type,Description',
      'Storm recovery,Amara Osei,2026-05-14,https://example.org/a,amara@example.org,resource,Neighbourhood recovery support',
    ].join('\n')

    const { rows, parseErrors } = parseSpreadsheetArrayBuffer(
      stringToArrayBuffer(csv)
    )

    expect(parseErrors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      article_title: 'Storm recovery',
      author_name: 'Amara Osei',
      pub_date: '2026-05-14',
      web_link: 'https://example.org/a',
      author_email: 'amara@example.org',
      pulse_type: 'resource',
      description: 'Neighbourhood recovery support',
    })
  })

  it('feeds parseArticleRows via alias headers end-to-end', () => {
    const csv = [
      'Headline,Byline,Published,Link',
      'T,A,2026-01-02,example.org/x',
    ].join('\n')
    const parsed = parseSpreadsheetArrayBuffer(stringToArrayBuffer(csv))
    expect(parsed.parseErrors).toEqual([])
    expect(validateArticleTemplateHeaders(parsed.rows)).toEqual([])

    const { rows, errors } = parseArticleRows(parsed.rows)
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({
      row: 2,
      title: 'T',
      author: 'A',
      date: '2026-01-02',
      url: 'https://example.org/x',
      pulseType: 'ResourcePulse',
    })
  })

  it('parses an XLSX workbook with the same normalized row shape', () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Title', 'Author', 'Date', 'URL'],
      ['Sheet story', 'Kofi Mensah', '2026-02-03', 'https://example.org/b'],
    ])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Articles')
    const buffer = XLSX.write(workbook, {
      type: 'array',
      bookType: 'xlsx',
    }) as ArrayBuffer

    const { rows, parseErrors } = parseSpreadsheetArrayBuffer(buffer)
    expect(parseErrors).toEqual([])
    expect(rows).toEqual([
      {
        title: 'Sheet story',
        author: 'Kofi Mensah',
        date: '2026-02-03',
        url: 'https://example.org/b',
      },
    ])
  })
})

/**
 * GOAL-326 — the summary is no longer accumulated as the batch runs; it is
 * recomputed from the durable per-row outcomes every time it is read, so a job
 * that was interrupted and resumed reports the same numbers as one that ran
 * straight through. These tests pin that derivation.
 */
describe('summarizeArticleOutcomes', () => {
  const outcome = (
    overrides: Partial<PersistedArticleRowOutcome> = {}
  ): PersistedArticleRowOutcome => ({
    row: 2,
    title: 'A row',
    status: 'created',
    message: 'Created.',
    ...overrides,
  })

  it('counts each outcome status into its own bucket', () => {
    const summary = summarizeArticleOutcomes(
      [
        outcome({ row: 2, status: 'created' }),
        outcome({ row: 3, status: 'skipped_existing' }),
        outcome({ row: 4, status: 'failed' }),
        outcome({ row: 5, status: 'created' }),
      ],
      10
    )

    expect(summary).toEqual({
      totalRows: 10,
      created: 2,
      skippedExisting: 1,
      failed: 1,
      createdPeople: 0,
      matchedPeople: 0,
      articlesRead: 0,
      articlesUnread: 0,
      createdFromArticles: 0,
    })
  })

  it('counts article reads and what they added from the extraction field (GOAL-344)', () => {
    const summary = summarizeArticleOutcomes(
      [
        outcome({
          row: 2,
          extraction: {
            status: 'extracted',
            message: null,
            created: 3,
            updated: 1,
          },
        }),
        outcome({
          row: 3,
          extraction: {
            status: 'nothing_extracted',
            message: null,
            created: 0,
            updated: 1,
          },
        }),
        outcome({
          row: 4,
          extraction: {
            status: 'fetch_failed',
            message: 'The site could not be reached.',
            created: 0,
            updated: 0,
          },
        }),
        outcome({
          row: 5,
          extraction: {
            status: 'extraction_failed',
            message: 'x',
            created: 0,
            updated: 0,
          },
        }),
        // An earlier import already read this one — neither read nor unread this run.
        outcome({
          row: 6,
          extraction: {
            status: 'already_extracted',
            message: 'y',
            created: 0,
            updated: 0,
          },
        }),
        // A row that failed before its article was attempted carries no extraction.
        outcome({ row: 7, status: 'failed' }),
      ],
      6
    )

    expect(summary.articlesRead).toBe(2)
    expect(summary.articlesUnread).toBe(2)
    expect(summary.createdFromArticles).toBe(3)
  })

  it('counts people from personEvent, not from the row status', () => {
    const summary = summarizeArticleOutcomes(
      [
        outcome({ row: 2, personEvent: 'created' }),
        // A row whose pulse write failed can still have created its author.
        outcome({ row: 3, status: 'failed', personEvent: 'created' }),
        outcome({ row: 4, personEvent: 'matched' }),
        // Cached author on a later row for the same person — counted once.
        outcome({ row: 5 }),
      ],
      4
    )

    expect(summary.createdPeople).toBe(2)
    expect(summary.matchedPeople).toBe(1)
  })

  it('reports totalRows even when nothing has been processed yet', () => {
    expect(summarizeArticleOutcomes([], 300)).toEqual({
      totalRows: 300,
      created: 0,
      skippedExisting: 0,
      failed: 0,
      createdPeople: 0,
      matchedPeople: 0,
      articlesRead: 0,
      articlesUnread: 0,
      createdFromArticles: 0,
    })
  })

  it('keeps every ROW count stable across a resume', () => {
    // Three rows by one author. Straight through, the author is resolved once
    // and cached, so rows 3 and 4 carry no personEvent.
    const straightThrough: PersistedArticleRowOutcome[] = [
      outcome({ row: 2, personEvent: 'created' }),
      outcome({ row: 3 }),
      outcome({ row: 4, status: 'failed' }),
    ]
    // Crash after row 2. The resumed tick starts with a COLD author cache, so
    // it re-resolves the same author and sees them already existing.
    const resumed: PersistedArticleRowOutcome[] = [
      outcome({ row: 2, personEvent: 'created' }),
      outcome({ row: 3, personEvent: 'matched' }),
      outcome({ row: 4, status: 'failed' }),
    ]

    const a = summarizeArticleOutcomes(straightThrough, 3)
    const b = summarizeArticleOutcomes(resumed, 3)
    expect(b.created).toBe(a.created)
    expect(b.skippedExisting).toBe(a.skippedExisting)
    expect(b.failed).toBe(a.failed)
    expect(b.totalRows).toBe(a.totalRows)
  })

  it('reports PEOPLE counts per run, so a resume can double-count one author', () => {
    // The documented trade-off (see summarizeArticleOutcomes): making this
    // exact would mean persisting an author identity on every row, which is
    // more member PII in the job node than the count is worth. Pinned so the
    // behaviour is a decision rather than a surprise.
    const resumed: PersistedArticleRowOutcome[] = [
      outcome({ row: 2, personEvent: 'created' }),
      outcome({ row: 3, personEvent: 'matched' }),
    ]
    const summary = summarizeArticleOutcomes(resumed, 2)

    expect(summary.createdPeople).toBe(1)
    expect(summary.matchedPeople).toBe(1)
  })
})

describe('buildArticleImportMessage', () => {
  const summary = (
    overrides: Partial<ArticleImportSummary> = {}
  ): ArticleImportSummary => ({
    totalRows: 3,
    created: 3,
    skippedExisting: 0,
    failed: 0,
    createdPeople: 0,
    matchedPeople: 0,
    articlesRead: 0,
    articlesUnread: 0,
    createdFromArticles: 0,
    ...overrides,
  })

  it('leads with what landed', () => {
    expect(buildArticleImportMessage(summary())).toBe('Imported 3 of 3 rows.')
  })

  it('appends what reading the articles yielded (GOAL-344)', () => {
    expect(
      buildArticleImportMessage(
        summary({ articlesRead: 2, createdFromArticles: 9, articlesUnread: 1 })
      )
    ).toBe(
      "Imported 3 of 3 rows. Read 2 articles and added 9 entries from them; 1 article couldn't be read, so that row was imported from the sheet details only."
    )
  })

  it('reads articles without claiming additions when nothing new came of them', () => {
    expect(
      buildArticleImportMessage(
        summary({ articlesRead: 1, createdFromArticles: 0 })
      )
    ).toBe('Imported 3 of 3 rows. Read 1 article.')
  })

  it('says nothing about articles when none were read this run', () => {
    expect(
      buildArticleImportMessage(summary({ skippedExisting: 3, created: 0 }))
    ).toBe('Imported 0 of 3 rows, 3 already existed.')
  })

  it('names skipped and failed rows when there are any', () => {
    expect(
      buildArticleImportMessage(
        summary({ created: 1, skippedExisting: 1, failed: 1 })
      )
    ).toBe('Imported 1 of 3 rows, 1 already existed, 1 failed.')
  })

  it('acknowledges people created even when no pulse landed', () => {
    expect(
      buildArticleImportMessage(
        summary({ created: 0, failed: 3, createdPeople: 1 })
      )
    ).toBe(
      'No pulses were imported, though 1 new person was added. Fix the errors below and upload again.'
    )
  })

  it('falls back to the bare failure line when nothing at all happened', () => {
    expect(buildArticleImportMessage(summary({ created: 0, failed: 3 }))).toBe(
      'No rows were imported. Fix the errors below and upload again.'
    )
  })
})
