import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import multer from 'multer'
import OpenAI from 'openai'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import PizZip from 'pizzip'
import * as XLSX from 'xlsx'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? 8787)
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-5'
const appRoot = process.cwd()
const workspaceRoot = path.resolve(appRoot, '..')
const storageRoot = path.join(appRoot, 'storage')
const knowledgeBaseDir = path.join(storageRoot, 'knowledge-base')
const updatedManualsDir = path.join(storageRoot, 'updated-manuals')
const uploadsDir = path.join(storageRoot, 'uploads')

type ManualFile = {
  name: string
  path: string
  url: string
  createdAt: string
  sizeKb: number
}

type ParagraphRecord = {
  index: number
  text: string
  styleId: string | null
}

type ManualChunk = {
  id: string
  paragraphIndices: number[]
  content: string
}

type ScreenshotSummary = {
  summary: string
  visibleChanges: string[]
  extractedText: string[]
  impacts: string[]
}

type EditOperation = {
  type: 'replace' | 'insert_after'
  paragraphIndex: number
  replacementText: string
  reason: string
}

const upload = multer({ dest: uploadsDir })
const parser = new DOMParser()
const serializer = new XMLSerializer()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use('/downloads', express.static(storageRoot))

function requireClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing. Add it to your .env file before running the workflow.')
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

async function ensureStorage() {
  await fs.mkdir(knowledgeBaseDir, { recursive: true })
  await fs.mkdir(updatedManualsDir, { recursive: true })
  await fs.mkdir(uploadsDir, { recursive: true })

  const gitkeepPath = path.join(uploadsDir, '.gitkeep')
  try {
    await fs.access(gitkeepPath)
  } catch {
    await fs.writeFile(gitkeepPath, '')
  }
}

async function bootstrapKnowledgeBase() {
  await ensureStorage()

  const existing = await listDocxFiles(knowledgeBaseDir, 'knowledge-base')
  if (existing.length > 0) {
    return existing[0]
  }

  const workspaceEntries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const sourceManual = workspaceEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.docx'))
    .map((entry) => entry.name)
    .sort()[0]

  if (!sourceManual) {
    return null
  }

  const sourcePath = path.join(workspaceRoot, sourceManual)
  const destinationPath = path.join(knowledgeBaseDir, sourceManual)
  await fs.copyFile(sourcePath, destinationPath)

  const refreshed = await listDocxFiles(knowledgeBaseDir, 'knowledge-base')
  return refreshed[0] ?? null
}

async function listDocxFiles(folderPath: string, routeFolder: string): Promise<ManualFile[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const documents = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.docx'))
      .map(async (entry) => {
        const fullPath = path.join(folderPath, entry.name)
        const stats = await fs.stat(fullPath)

        return {
          name: entry.name,
          path: fullPath,
          url: `/downloads/${routeFolder}/${encodeURIComponent(entry.name)}`,
          createdAt: stats.mtime.toISOString(),
          sizeKb: Math.max(1, Math.round(stats.size / 1024)),
        }
      }),
  )

  return documents.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function trimForPreview(value: string, length = 220) {
  const compact = normalizeWhitespace(value)
  return compact.length > length ? `${compact.slice(0, length)}...` : compact
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

async function extractStoryText(filePath: string, originalName: string) {
  const extension = path.extname(originalName).toLowerCase()

  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value.trim()
  }

  if (extension === '.xlsx' || extension === '.xls') {
    const workbook = XLSX.readFile(filePath)
    const sheetsAsText = workbook.SheetNames.map((sheetName) => {
      const worksheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(worksheet, {
        header: 1,
        blankrows: false,
        raw: false,
      })

      const rowText = rows
        .map((row) => row.map((cell) => String(cell ?? '').trim()).filter(Boolean).join(' | '))
        .filter(Boolean)
        .join('\n')

      return rowText ? `Sheet: ${sheetName}\n${rowText}` : ''
    })
      .filter(Boolean)
      .join('\n\n')

    return sheetsAsText.trim()
  }

  const raw = await fs.readFile(filePath, 'utf8')
  return raw.trim()
}

async function analyzeScreenshot(
  client: OpenAI,
  filePath: string,
  mimeType: string,
): Promise<ScreenshotSummary> {
  const fileBuffer = await fs.readFile(filePath)
  const base64 = fileBuffer.toString('base64')
  const response = await client.responses.create({
    model: openAiModel,
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
              'Return JSON with keys: summary, visibleChanges, extractedText, impacts.',
              'Each list should contain short strings.',
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

  return parseJsonSafely<ScreenshotSummary>(getResponseText(response), fallback)
}

async function extractParagraphsFromDocx(filePath: string): Promise<ParagraphRecord[]> {
  const fileBuffer = await fs.readFile(filePath)
  const zip = new PizZip(fileBuffer)
  const documentXml = zip.file('word/document.xml')?.asText()

  if (!documentXml) {
    throw new Error('The DOCX manual does not contain word/document.xml.')
  }

  const document = parser.parseFromString(documentXml, 'application/xml')
  const paragraphNodes = Array.from(document.getElementsByTagName('w:p'))

  return paragraphNodes.map((paragraphNode, index) => {
    const textNodes = Array.from(paragraphNode.getElementsByTagName('w:t'))
    const text = normalizeWhitespace(textNodes.map((node) => node.textContent ?? '').join(' '))
    const styleNode = paragraphNode.getElementsByTagName('w:pStyle').item(0)
    const styleId = styleNode?.getAttribute('w:val') ?? null

    return {
      index,
      text,
      styleId,
    }
  })
}

function buildChunks(paragraphs: ParagraphRecord[]): ManualChunk[] {
  const nonEmpty = paragraphs.filter((paragraph) => paragraph.text)
  const chunks: ManualChunk[] = []

  for (let cursor = 0; cursor < nonEmpty.length; cursor += 5) {
    const slice = nonEmpty.slice(cursor, cursor + 5)
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      paragraphIndices: slice.map((paragraph) => paragraph.index),
      content: slice
        .map((paragraph) => `Paragraph ${paragraph.index} (${paragraph.styleId ?? 'Body'}): ${paragraph.text}`)
        .join('\n'),
    })
  }

  return chunks
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

async function retrieveRelevantChunks(client: OpenAI, query: string, chunks: ManualChunk[]) {
  const batchInput = [query, ...chunks.map((chunk) => chunk.content)]
  const embeddings = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: batchInput,
  })

  const queryEmbedding = embeddings.data[0].embedding
  const scored = chunks.map((chunk, index) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, embeddings.data[index + 1].embedding),
  }))

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ chunk }) => chunk)
}

async function planEdits(
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
          styleId: paragraph.styleId,
          text: paragraph.text,
        }),
    )
    .join('\n')

  const response = await client.responses.create({
    model: openAiModel,
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

  const payload = parseJsonSafely<{ edits?: EditOperation[] }>(getResponseText(response), { edits: [] })
  return (payload.edits ?? []).filter((edit) => Number.isInteger(edit.paragraphIndex) && !!edit.replacementText)
}

function replaceParagraphText(paragraphNode: any, replacementText: string) {
  const textNodes = Array.from(paragraphNode.getElementsByTagName('w:t')) as any[]

  if (textNodes.length === 0) {
    const document = paragraphNode.ownerDocument
    const runNode = document.createElement('w:r')
    const textNode = document.createElement('w:t')
    textNode.setAttribute('xml:space', 'preserve')
    textNode.appendChild(document.createTextNode(replacementText))
    runNode.appendChild(textNode)
    paragraphNode.appendChild(runNode)
    return
  }

  textNodes[0].textContent = replacementText

  for (const textNode of textNodes.slice(1)) {
    textNode.textContent = ''
  }
}

async function applyEditsToDocx(baseManualPath: string, edits: EditOperation[], outputPath: string) {
  const fileBuffer = await fs.readFile(baseManualPath)
  const zip = new PizZip(fileBuffer)
  const documentXml = zip.file('word/document.xml')?.asText()

  if (!documentXml) {
    throw new Error('The DOCX manual does not contain editable document XML.')
  }

  const document = parser.parseFromString(documentXml, 'application/xml')
  const paragraphNodes = Array.from(document.getElementsByTagName('w:p'))
  const sortedEdits = [...edits].sort((left, right) => right.paragraphIndex - left.paragraphIndex)

  for (const edit of sortedEdits) {
    const target = paragraphNodes[edit.paragraphIndex]
    if (!target) {
      continue
    }

    if (edit.type === 'insert_after') {
      const clone = target.cloneNode(true)
      replaceParagraphText(clone, edit.replacementText)
      target.parentNode?.insertBefore(clone, target.nextSibling)
      continue
    }

    replaceParagraphText(target, edit.replacementText)
  }

  zip.file('word/document.xml', serializer.serializeToString(document))
  const outputBuffer = zip.generate({ type: 'nodebuffer' })
  await fs.writeFile(outputPath, outputBuffer)
}

function buildOutputFileName(baseManualName: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${path.parse(baseManualName).name}-updated-${timestamp}.docx`
}

async function cleanupFiles(paths: string[]) {
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        await fs.unlink(filePath)
      } catch {
        return
      }
    }),
  )
}

app.get('/api/manuals', async (_request, response, next) => {
  try {
    await bootstrapKnowledgeBase()

    const knowledgeBaseManuals = await listDocxFiles(knowledgeBaseDir, 'knowledge-base')
    const updatedManuals = await listDocxFiles(updatedManualsDir, 'updated-manuals')

    response.json({ knowledgeBaseManuals, updatedManuals })
  } catch (error) {
    next(error)
  }
})

app.post(
  '/api/process',
  upload.fields([
    { name: 'userStory', maxCount: 1 },
    { name: 'screenshot', maxCount: 1 },
  ]),
  async (request, response, next) => {
    const files = request.files as
      | {
          userStory?: Express.Multer.File[]
          screenshot?: Express.Multer.File[]
        }
      | undefined

    const userStoryFile = files?.userStory?.[0]
    const screenshotFile = files?.screenshot?.[0]

    if (!userStoryFile || !screenshotFile) {
      response.status(400).json({ error: 'Upload both a user story file and a screenshot.' })
      return
    }

    try {
      const client = requireClient()
      const baseManual = await bootstrapKnowledgeBase()

      if (!baseManual) {
        response.status(400).json({ error: 'No fixed DOCX manual was found in the workspace.' })
        return
      }

      const storyText = await extractStoryText(userStoryFile.path, userStoryFile.originalname)
      const screenshotSummary = await analyzeScreenshot(client, screenshotFile.path, screenshotFile.mimetype)
      const paragraphs = await extractParagraphsFromDocx(baseManual.path)
      const chunks = buildChunks(paragraphs)
      const retrievalQuery = [storyText, screenshotSummary.summary, ...screenshotSummary.visibleChanges, ...screenshotSummary.impacts]
        .join('\n')
        .slice(0, 12000)
      const retrievedChunks = await retrieveRelevantChunks(client, retrievalQuery, chunks)
      const paragraphIndices = new Set(retrievedChunks.flatMap((chunk) => chunk.paragraphIndices))
      const relevantParagraphs = paragraphs.filter((paragraph) => paragraphIndices.has(paragraph.index))
      const edits = await planEdits(client, storyText, screenshotSummary, relevantParagraphs)
      const outputFileName = buildOutputFileName(baseManual.name)
      const outputPath = path.join(updatedManualsDir, outputFileName)

      if (edits.length > 0) {
        await applyEditsToDocx(baseManual.path, edits, outputPath)
      } else {
        await fs.copyFile(baseManual.path, outputPath)
      }

      response.json({
        outputFileName,
        outputUrl: `/downloads/updated-manuals/${encodeURIComponent(outputFileName)}`,
        generatedAt: new Date().toISOString(),
        storyExcerpt: trimForPreview(storyText, 420),
        screenshotSummary,
        retrievedChunks: retrievedChunks.map((chunk) => ({
          id: chunk.id,
          paragraphIndices: chunk.paragraphIndices,
          preview: trimForPreview(chunk.content),
        })),
        edits: edits.map(({ type, paragraphIndex, reason }) => ({ type, paragraphIndex, reason })),
      })
    } catch (error) {
      next(error)
    } finally {
      await cleanupFiles([userStoryFile.path, screenshotFile.path])
    }
  },
)

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server failure.'
  response.status(500).json({ error: message })
})

ensureStorage()
  .then(() => bootstrapKnowledgeBase())
  .then(() => {
    app.listen(port, () => {
      console.log(`AgentAssist manual updater API is running on http://localhost:${port}`)
    })
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Startup failed.'
    console.error(message)
    process.exit(1)
  })