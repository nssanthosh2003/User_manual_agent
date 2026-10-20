import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'

const CACHE_SCHEMA_VERSION = 1
const SCREENSHOT_PROMPT_VERSION = 'screenshot-analysis-v1'
const EDIT_PROMPT_VERSION = 'edit-planning-v1'
const RELEASE_NOTES_EDIT_PROMPT_VERSION = 'release-notes-edit-planning-v2'
const agentCacheDir = path.join(process.cwd(), 'storage', 'agent-cache')

/** A paragraph plus its human-readable location in the source manual. */
export type ParagraphRecord = {
  index: number
  text: string
  styleId: string | null
  pageNumber: number
  sectionHeading: string
}

/** A locally retrieved group of related manual paragraphs. */
export type ManualChunk = {
  id: string
  paragraphIndices: number[]
  pageNumbers: number[]
  sectionHeadings: string[]
  content: string
}

/** Structured output produced by the screenshot-analysis prompt. */
export type ScreenshotSummary = {
  summary: string
  visibleChanges: string[]
  extractedText: string[]
  impacts: string[]
}

/** A document change proposed by the edit-planning prompt. */
export type EditOperation = {
  type: 'replace' | 'insert_after'
  paragraphIndex: number
  replacementText: string
  reason: string
}

function normalizeReleaseNotesEdits(edits: EditOperation[]) {
  return edits
    .map((edit) => ({
      ...edit,
      replacementText: edit.replacementText
        .replace(/^\s*(?:[([]\s*new\s*:?\s*[)\]]\s*:?\s*|new\s*:\s*)/i, '')
        .trimStart(),
    }))
    .filter((edit) => Number.isInteger(edit.paragraphIndex) && !!edit.replacementText)
}

function getOpenAiModel() {
  return process.env.OPENAI_MODEL ?? 'gpt-5'
}

function isCacheEnabled() {
  return process.env.AGENT_CACHE_ENABLED !== 'false'
}

function createCacheKey(stage: string, input: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        stage,
        model: getOpenAiModel(),
        baseURL: process.env.OPENAI_BASE_URL ?? '',
        input,
      }),
    )
    .digest('hex')
}

async function readCache<T>(stage: string, key: string): Promise<T | null> {
  if (!isCacheEnabled()) {
    return null
  }

  const cachePath = path.join(agentCacheDir, `${stage}-${key}.json`)
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as {
      schemaVersion: number
      value: T
    }
    if (cached.schemaVersion === CACHE_SCHEMA_VERSION) {
      console.log(`Agent cache hit: ${stage} (${key.slice(0, 12)})`)
      return cached.value
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`Ignoring unreadable agent cache entry for ${stage}.`, error)
    }
  }

  console.log(`Agent cache miss: ${stage} (${key.slice(0, 12)})`)
  return null
}

async function writeCache<T>(stage: string, key: string, value: T) {
  if (!isCacheEnabled()) {
    return
  }

  await fs.mkdir(agentCacheDir, { recursive: true })
  const cachePath = path.join(agentCacheDir, `${stage}-${key}.json`)
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`
  await fs.writeFile(
    temporaryPath,
    JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      value,
    }),
  )
  await fs.rename(temporaryPath, cachePath)
}

/** Creates the shared Azure AI/OpenAI client used by the prompt-driven steps. */
export function requireClient() {
  const baseURL = process.env.OPENAI_BASE_URL
  const apiKey = [process.env.AZURE_AI_ACCESS_TOKEN, process.env.OPENAI_API_KEY].find(
    (credential) =>
      credential && !credential.startsWith('replace_with_') && !credential.startsWith('your_'),
  )

  if (!apiKey) {
    throw new Error(
      'Azure AI authentication is missing. Set AZURE_AI_ACCESS_TOKEN to a current bearer token or OPENAI_API_KEY to an Azure AI API key in your .env file.',
    )
  }

  return new OpenAI({ apiKey, baseURL })
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
}

function parseJsonSafely<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(stripCodeFence(value)) as T
  } catch {
    return fallback
  }
}

function getResponseText(response: unknown) {
  const candidate = response as {
    output_text?: string
    output?: Array<{ content?: Array<{ text?: string }> }>
  }

  if (typeof candidate.output_text === 'string' && candidate.output_text.trim()) {
    return candidate.output_text.trim()
  }

  const collected: string[] = []
  for (const item of candidate.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') {
        collected.push(content.text)
      }
    }
  }

  return collected.join('\n').trim()
}

/**
 * Prompt-driven step 1: asks GPT-5 vision to convert the screenshot and the
 * user's description into concise, structured documentation requirements.
 */
export async function analyzeScreenshot(
  client: OpenAI,
  filePath: string,
  mimeType: string,
  screenshotDescription: string,
): Promise<ScreenshotSummary> {
  const fileBuffer = await fs.readFile(filePath)
  const cacheKey = createCacheKey('screenshot-analysis', {
    promptVersion: SCREENSHOT_PROMPT_VERSION,
    screenshotHash: createHash('sha256').update(fileBuffer).digest('hex'),
    mimeType: mimeType.toLowerCase(),
    screenshotDescription: screenshotDescription.replace(/\s+/g, ' ').trim(),
  })
  const cached = await readCache<ScreenshotSummary>('screenshot-analysis', cacheKey)
  if (cached) {
    return cached
  }

  const base64 = fileBuffer.toString('base64')
  const response = await client.responses.create({
    model: getOpenAiModel(),
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You extract UI change requirements from screenshots for a documentation update workflow. Return JSON only.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Analyze the screenshot and identify the UI changes that must be reflected in the user manual.',
              `User-provided screenshot description: ${screenshotDescription || 'No description provided.'}`,
              'Return JSON with keys: summary, visibleChanges, extractedText, impacts.',
              'The summary must be one short string. Each list should contain only short, necessary items.',
            ].join(' '),
          },
          {
            type: 'input_image',
            image_url: `data:${mimeType};base64,${base64}`,
          },
        ],
      },
    ],
  } as never)

  const fallback: ScreenshotSummary = {
    summary: 'Screenshot analysis was not available.',
    visibleChanges: [],
    extractedText: [],
    impacts: [],
  }

  const summary = parseJsonSafely<ScreenshotSummary>(getResponseText(response), fallback)
  await writeCache('screenshot-analysis', cacheKey, summary)
  return summary
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

function buildTermVector(value: string, vocabulary: string[]) {
  const terms = value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  const counts = new Map<string, number>()
  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  return vocabulary.map((term) => counts.get(term) ?? 0)
}

/**
 * Retrieval step: ranks manual chunks locally using term-frequency vectors.
 * The client parameter is retained to keep the workflow's existing interface.
 */
export async function retrieveRelevantChunks(
  _client: OpenAI,
  query: string,
  chunks: ManualChunk[],
) {
  const vocabulary = [
    ...new Set(
      [query, ...chunks.map((chunk) => chunk.content)]
        .join(' ')
        .toLowerCase()
        .match(/[a-z0-9]{2,}/g) ?? [],
    ),
  ]
  const queryVector = buildTermVector(query, vocabulary)
  const scored = chunks.map((chunk, order) => ({
    chunk,
    order,
    score: cosineSimilarity(queryVector, buildTermVector(chunk.content, vocabulary)),
  }))

  return scored
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 5)
    .map(({ chunk }) => chunk)
}

/**
 * Prompt-driven step 2: asks GPT-5 to turn the story, screenshot findings,
 * and retrieved manual context into minimal structured edit operations.
 */
export async function planEdits(
  client: OpenAI,
  storyText: string,
  screenshotSummary: ScreenshotSummary,
  relevantParagraphs: ParagraphRecord[],
): Promise<EditOperation[]> {
  const manualContext = relevantParagraphs
    .map(
      (paragraph) =>
        JSON.stringify({
          paragraphIndex: paragraph.index,
          pageNumber: paragraph.pageNumber,
          sectionHeading: paragraph.sectionHeading,
          styleId: paragraph.styleId,
          text: paragraph.text,
        }),
    )
    .join('\n')

  const cacheKey = createCacheKey('edit-planning', {
    promptVersion: EDIT_PROMPT_VERSION,
    storyText: storyText.replace(/\r\n/g, '\n').trim(),
    screenshotSummary,
    relevantParagraphs: relevantParagraphs.map((paragraph) => ({
      index: paragraph.index,
      text: paragraph.text,
      styleId: paragraph.styleId,
      pageNumber: paragraph.pageNumber,
      sectionHeading: paragraph.sectionHeading,
    })),
  })
  const cached = await readCache<EditOperation[]>('edit-planning', cacheKey)
  if (cached) {
    return cached
  }

  const response = await client.responses.create({
    model: getOpenAiModel(),
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              'You update a fixed-format user manual.',
              'Return JSON only with an edits array.',
              'Each edit must contain type, paragraphIndex, replacementText, and reason.',
              'Allowed types are replace and insert_after.',
              'Only propose minimal changes needed for the new story and screenshot.',
              'Target the operational manual section that describes the affected screen or workflow.',
              'Do not edit cover pages, document metadata, release notes, or table-of-contents entries unless the user explicitly requests that exact change.',
              'Do not mention JSON fences or markdown.',
            ].join(' '),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'User story input:',
              storyText.slice(0, 12000),
              '',
              'Screenshot summary:',
              JSON.stringify(screenshotSummary),
              '',
              'Relevant manual paragraphs:',
              manualContext,
              '',
              'Return JSON in the form {"edits":[...]} and keep unchanged paragraphs out of the result.',
            ].join('\n'),
          },
        ],
      },
    ],
  } as never)

  const payload = parseJsonSafely<{ edits?: EditOperation[] }>(getResponseText(response), {
    edits: [],
  })
  const edits = (payload.edits ?? []).filter(
    (edit) => Number.isInteger(edit.paragraphIndex) && !!edit.replacementText,
  )
  await writeCache('edit-planning', cacheKey, edits)
  return edits
}

/**
 * Prompt-driven release-notes step: records the same product change as a
 * concise release-note entry without rewriting historical entries.
 */
export async function planReleaseNotesEdits(
  client: OpenAI,
  storyText: string,
  screenshotSummary: ScreenshotSummary,
  relevantParagraphs: ParagraphRecord[],
): Promise<EditOperation[]> {
  const releaseNotesContext = relevantParagraphs
    .map(
      (paragraph) =>
        JSON.stringify({
          paragraphIndex: paragraph.index,
          pageNumber: paragraph.pageNumber,
          sectionHeading: paragraph.sectionHeading,
          styleId: paragraph.styleId,
          text: paragraph.text,
        }),
    )
    .join('\n')

  const cacheKey = createCacheKey('release-notes-edit-planning', {
    promptVersion: RELEASE_NOTES_EDIT_PROMPT_VERSION,
    storyText: storyText.replace(/\r\n/g, '\n').trim(),
    screenshotSummary,
    relevantParagraphs: relevantParagraphs.map((paragraph) => ({
      index: paragraph.index,
      text: paragraph.text,
      styleId: paragraph.styleId,
      pageNumber: paragraph.pageNumber,
      sectionHeading: paragraph.sectionHeading,
    })),
  })
  const cached = await readCache<EditOperation[]>('release-notes-edit-planning', cacheKey)
  if (cached) {
    return normalizeReleaseNotesEdits(cached)
  }

  const response = await client.responses.create({
    model: getOpenAiModel(),
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              'You update a fixed-format release notes document.',
              'Return JSON only with an edits array.',
              'Each edit must contain type, paragraphIndex, replacementText, and reason.',
              'Allowed types are replace and insert_after.',
              'Add a concise user-facing release note for the supplied change.',
              'Prefer insert_after near the newest relevant version, feature, or change section.',
              'When surrounding entries are bullet points, insert the new entry beside a bullet paragraph so its bullet formatting is reused.',
              'Write only the release-note content; never prefix it with New:, (New:), (New), or a similar label.',
              'Preserve historical entries, cover pages, document metadata, and table-of-contents entries.',
              'Do not add implementation details that are not supported by the inputs.',
              'Do not mention JSON fences or markdown.',
            ].join(' '),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'User story input:',
              storyText.slice(0, 12000),
              '',
              'Screenshot summary:',
              JSON.stringify(screenshotSummary),
              '',
              'Relevant release notes paragraphs:',
              releaseNotesContext,
              '',
              'Return JSON in the form {"edits":[...]} and keep unchanged paragraphs out of the result.',
            ].join('\n'),
          },
        ],
      },
    ],
  } as never)

  const payload = parseJsonSafely<{ edits?: EditOperation[] }>(getResponseText(response), {
    edits: [],
  })
  const edits = normalizeReleaseNotesEdits(payload.edits ?? [])
  await writeCache('release-notes-edit-planning', cacheKey, edits)
  return edits
}
