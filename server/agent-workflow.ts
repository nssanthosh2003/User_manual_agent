import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'

const CACHE_SCHEMA_VERSION = 2
const SCREENSHOT_PROMPT_VERSION = 'screenshot-analysis-v2'
const EDIT_PROMPT_VERSION = 'edit-planning-v2'
const RELEASE_NOTES_EDIT_PROMPT_VERSION = 'release-notes-edit-planning-v3'
const agentCacheDir = path.join(process.cwd(), 'storage', 'agent-cache')

/** A paragraph plus its human-readable location in the source manual. */
export type ParagraphRecord = {
  index: number
  text: string
  styleId: string | null
  pageNumber: number
  sectionHeading: string
  hasImage?: boolean
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
  imageAttachment?: string // filename or identifier of an instruction image to insert
  imageCaption?: string
  replaceImage?: boolean // when true, replaces the existing image in this paragraph with the uploaded screenshot
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
            text: [
              'You are an expert technical writer and UI analyst specializing in software user manuals.',
              'Your job is to thoroughly analyze the provided UI screenshot alongside the user description to identify EXACTLY what changed, where it appears in the workflow, and which screens, sections, buttons, fields, or tabs are affected.',
              'Return JSON only with keys: summary, visibleChanges, extractedText, impacts.',
              'CRITICAL INSTRUCTIONS:',
              '1. Carefully examine and cross-reference the user description with the screenshot visual elements.',
              '2. In "summary": State clearly what screen/feature is shown, what changed, and where it lives in the application flow.',
              '3. In "visibleChanges": List specific UI differences, new or modified buttons, input fields, labels, headers, toggles, or layout changes.',
              '4. In "extractedText": Extract exact literal text labels, titles, button captions, dropdown options, and heading texts visible in the changed area of the screenshot.',
              '5. In "impacts": Identify the specific user actions, workflow steps, or operational manual sections affected by this change.',
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
              'Analyze this screenshot and match it with the user description for a precise manual update.',
              `User Description of Change: ${screenshotDescription || 'No description provided.'}`,
              'Return strictly valid JSON with keys: summary, visibleChanges, extractedText, impacts.',
            ].join('\n'),
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

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, ' ')
      .match(/[a-z0-9_\-]{2,}/g) ?? []
  )
}

/**
 * Enhanced retrieval step: scores manual chunks using BM25-style term frequency,
 * inverse document frequency, and section heading boosting.
 */
export async function retrieveRelevantChunks(
  _client: OpenAI,
  query: string,
  chunks: ManualChunk[],
) {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || chunks.length === 0) {
    return chunks.slice(0, 8)
  }

  const N = chunks.length
  // Document frequencies for query terms
  const docFrequencies = new Map<string, number>()
  const chunkTokenSets = chunks.map((c) => {
    const tokens = new Set(tokenize(c.content))
    for (const token of tokens) {
      docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1)
    }
    return tokens
  })

  // Average document length in tokens
  const chunkLengths = chunks.map((c) => tokenize(c.content).length)
  const avgDl = chunkLengths.reduce((a, b) => a + b, 0) / (N || 1)
  const k1 = 1.2
  const b = 0.75

  const scored = chunks.map((chunk, index) => {
    const chunkTokens = tokenize(chunk.content)
    const tokenCounts = new Map<string, number>()
    for (const t of chunkTokens) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1)
    }

    const headingTokens = new Set(tokenize(chunk.sectionHeadings.join(' ')))
    let bm25Score = 0

    for (const qTerm of queryTokens) {
      const f = tokenCounts.get(qTerm) ?? 0
      if (f > 0) {
        const df = docFrequencies.get(qTerm) ?? 1
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const tfComponent = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (chunkLengths[index] / (avgDl || 1))))
        let weight = idf * tfComponent

        // Boost matches occurring in section headings
        if (headingTokens.has(qTerm)) {
          weight *= 2.5
        }

        bm25Score += weight
      }
    }

    // Boost chunks that have image illustrations if screenshot replacement was requested or mentioned
    if (chunk.content.includes('[IMAGE / SCREENSHOT ILLUSTRATION]')) {
      bm25Score *= 1.25
    }

    return {
      chunk,
      index,
      score: bm25Score,
    }
  })

  // Return top 8 most relevant chunks to provide comprehensive context to GPT
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8)
    .map(({ chunk }) => chunk)
}

/**
 * Prompt-driven step 2: asks GPT-5 to turn the story, screenshot findings,
 * optional further instructions, and retrieved manual context into minimal structured edit operations.
 */
export async function planEdits(
  client: OpenAI,
  storyText: string,
  screenshotSummary: ScreenshotSummary,
  relevantParagraphs: ParagraphRecord[],
  additionalInstructions: string = '',
  attachedImageNames: string[] = [],
  replaceScreenshotInManual: boolean = false,
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
          ...(paragraph.hasImage ? { hasImage: true } : {}),
        }),
    )
    .join('\n')

  const cacheKey = createCacheKey('edit-planning', {
    promptVersion: EDIT_PROMPT_VERSION,
    storyText: storyText.replace(/\r\n/g, '\n').trim(),
    screenshotSummary,
    additionalInstructions: additionalInstructions.replace(/\r\n/g, '\n').trim(),
    attachedImageNames,
    replaceScreenshotInManual,
    relevantParagraphs: relevantParagraphs.map((paragraph) => ({
      index: paragraph.index,
      text: paragraph.text,
      styleId: paragraph.styleId,
      pageNumber: paragraph.pageNumber,
      sectionHeading: paragraph.sectionHeading,
      hasImage: paragraph.hasImage,
    })),
  })
  const cached = await readCache<EditOperation[]>('edit-planning', cacheKey)
  if (cached) {
    return cached
  }

  const promptUserLines = [
    'User story input:',
    storyText.slice(0, 12000),
    '',
    'Screenshot summary:',
    JSON.stringify(screenshotSummary),
  ]

  if (replaceScreenshotInManual) {
    promptUserLines.push(
      '',
      'IMAGE REPLACEMENT REQUESTED:',
      'The user has enabled the option to replace the existing image in the user manual with the uploaded screenshot.',
      'Identify the relevant paragraph in the affected manual section that represents the existing UI screenshot / illustration (paragraphs with hasImage: true, or immediately preceding/succeeding the changed feature steps).',
      'Include an edit targeting that paragraphIndex with "type": "replace", "replaceImage": true, and "reason": "Replace existing manual image with the uploaded updated screenshot".',
      'If the paragraph contains no text (e.g. it is just an image paragraph), replacementText can be empty or keep the caption.',
    )
  }

  if (additionalInstructions.trim()) {
    promptUserLines.push(
      '',
      'Additional instructions / manual changes requested by user:',
      additionalInstructions.trim(),
    )
  }

  if (attachedImageNames.length > 0) {
    promptUserLines.push(
      '',
      'Attached instruction images available to insert into the user manual:',
      attachedImageNames.map((name) => `- ${name}`).join('\n'),
      'If the user instructions indicate to include or place any of these images, set "imageAttachment": "<filename>" (and optional "imageCaption") on the relevant edit operation where it should be inserted or accompanied.',
    )
  }

  promptUserLines.push(
    '',
    'Relevant manual paragraphs:',
    manualContext,
    '',
    'Return JSON in the form {"edits":[...]} and keep unchanged paragraphs out of the result.',
  )

  const response = await client.responses.create({
    model: getOpenAiModel(),
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              'You are an expert technical documentation editor updating a fixed-format user manual DOCX.',
              'Your job is to update the manual at the EXACT correct place matching the user story, screenshot analysis, and user-provided description.',
              'Return JSON only with an edits array: {"edits": [...]}.',
              'Each edit must contain: type ("replace" | "insert_after"), paragraphIndex (number), replacementText (string), and reason (string).',
              'Optional fields: replaceImage (boolean - true when replacing the existing manual screenshot/illustration with the newly uploaded screenshot), imageAttachment (exact filename of attached image), imageCaption.',
              '',
              'CRITICAL RULES FOR SELECTING THE CORRECT EDIT LOCATION:',
              '1. TARGET OPERATIONAL SECTIONS: Carefully inspect the "sectionHeading" of the candidate paragraphs. The operational manual sections describe specific user workflows, feature screens, and UI steps (e.g. "Create Order", "Review Offers", "Passenger Details", "Payment", etc.).',
              '2. NEVER edit preface, document control, revision history tables, table of contents, executive summary, or document introduction unless the user explicitly requested changes to document metadata.',
              '3. MATCH SCREENSHOT & DESCRIPTION: Analyze the screenshotSummary (extracted UI elements, screen name, buttons, labels) and the user\'s screenshot description. Locate the exact paragraph(s) in the manual that describe this specific screen, form field, button, or procedure.',
              '4. PRESERVE SURROUNDING CONTEXT: Keep the voice, bullet style, numbering, and structure of the manual intact. Do not rewrite unaffected steps.',
              '5. IMAGE REPLACEMENT ACCURACY: If replaceScreenshotInManual is true, identify the EXACT illustration/image paragraph (hasImage: true) that belongs to this specific feature screen in the operational section. Propose an edit with type: "replace", replaceImage: true on that specific paragraphIndex.',
              '6. ATTACHED IMAGES: If the user specified instructions to place an attached image, insert it directly following the relevant explanatory paragraph.',
              '7. Keep unchanged paragraphs out of the edits array.',
              '8. Do not output markdown code fences or conversational text.',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: promptUserLines.join('\n'),
          },
        ],
      },
    ],
  } as never)

  const payload = parseJsonSafely<{ edits?: EditOperation[] }>(getResponseText(response), {
    edits: [],
  })
  const edits = (payload.edits ?? []).filter(
    (edit) =>
      Number.isInteger(edit.paragraphIndex) &&
      (!!edit.replacementText || !!edit.imageAttachment || !!edit.replaceImage),
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
  additionalInstructions: string = '',
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
    additionalInstructions: additionalInstructions.replace(/\r\n/g, '\n').trim(),
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

  const promptUserLines = [
    'User story input:',
    storyText.slice(0, 12000),
    '',
    'Screenshot summary:',
    JSON.stringify(screenshotSummary),
  ]

  if (additionalInstructions.trim()) {
    promptUserLines.push(
      '',
      'Additional instructions / changes requested by user:',
      additionalInstructions.trim(),
    )
  }

  promptUserLines.push(
    '',
    'Relevant release notes paragraphs:',
    releaseNotesContext,
    '',
    'Return JSON in the form {"edits":[...]} and keep unchanged paragraphs out of the result.',
  )

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
              'Add a concise user-facing release note for the supplied change, taking into account any additional user instructions.',
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
            text: promptUserLines.join('\n'),
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
