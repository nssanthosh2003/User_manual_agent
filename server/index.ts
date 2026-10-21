import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import mammoth from 'mammoth'
import multer from 'multer'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import PizZip from 'pizzip'
import XLSX from 'xlsx'
import {
  analyzeScreenshot,
  planEdits,
  planReleaseNotesEdits,
  requireClient,
  retrieveRelevantChunks,
} from './agent-workflow.js'
import type { EditOperation, ManualChunk, ParagraphRecord } from './agent-workflow.js'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? 8787)
const appRoot = process.cwd()
const workspaceRoot = path.resolve(appRoot, '..')
const storageRoot = path.join(appRoot, 'storage')
const knowledgeBaseDir = path.join(storageRoot, 'knowledge-base')
const releaseNotesKnowledgeBaseDir = path.join(storageRoot, 'release-notes')
const updatedManualsDir = path.join(storageRoot, 'updated-manuals')
const updatedReleaseNotesDir = path.join(storageRoot, 'updated-release-notes')
const uploadsDir = path.join(storageRoot, 'uploads')

type ManualFile = {
  name: string
  path: string
  url: string
  createdAt: string
  sizeKb: number
}

const upload = multer({ dest: uploadsDir })
const parser = new DOMParser()
const serializer = new XMLSerializer()
const execFileAsync = promisify(execFile)

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use('/downloads', express.static(storageRoot))

function describeWorkflowError(error: unknown) {
  if (!(error instanceof Error)) {
    return new Error('Unexpected server failure.')
  }

  const cause = error.cause as { message?: string } | undefined
  if (error.message === 'Connection error.' || cause?.message === 'fetch failed') {
    return new Error(
      `Azure AI connection failed. Verify network access to ${process.env.OPENAI_BASE_URL ?? 'the configured endpoint'} and your proxy settings.`,
      { cause: error },
    )
  }

  return error
}

async function ensureStorage() {
  await fs.mkdir(knowledgeBaseDir, { recursive: true })
  await fs.mkdir(releaseNotesKnowledgeBaseDir, { recursive: true })
  await fs.mkdir(updatedManualsDir, { recursive: true })
  await fs.mkdir(updatedReleaseNotesDir, { recursive: true })
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

function paragraphMatchKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeDocumentXml(value: string) {
  return value.replace(/^\uFEFF?\s*(?=<\?xml)/, '')
}

function trimForPreview(value: string, length = 220) {
  const compact = normalizeWhitespace(value)
  return compact.length > length ? `${compact.slice(0, length)}...` : compact
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

type RenderedPage = {
  page: number
  contentKey: string
}

const renderedLocationCache = new Map<
  string,
  { modifiedTime: number; pages: RenderedPage[] }
>()

async function extractRenderedLocations(filePath: string) {
  if (process.platform !== 'win32') {
    return []
  }

  const stats = await fs.stat(filePath)
  const cached = renderedLocationCache.get(filePath)
  if (cached?.modifiedTime === stats.mtimeMs) {
    return cached.pages
  }

  const cachePath = `${filePath}.pages.json`
  try {
    const stored = JSON.parse(await fs.readFile(cachePath, 'utf8')) as {
      modifiedTime: number
      pages: RenderedPage[]
    }
    if (stored.modifiedTime === stats.mtimeMs && Array.isArray(stored.pages)) {
      renderedLocationCache.set(filePath, stored)
      return stored.pages
    }
  } catch {
    // Build the rendered-page cache when it is missing or stale.
  }

  const script = `
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $document = $word.Documents.Open($env:DOCX_PATH, $false, $true)
  $pageCount = $document.ComputeStatistics(2)
  $pageStarts = @(1..$pageCount | ForEach-Object { $document.GoTo(1, 1, $_).Start })
  $items = for ($page = 1; $page -le $pageCount; $page++) {
    $start = $pageStarts[$page - 1]
    $end = if ($page -lt $pageCount) { $pageStarts[$page] } else { $document.Content.End }
    $text = $document.Range($start, $end).Text
    [PSCustomObject]@{ page = $page; text = $text }
  }
  @($items) | ConvertTo-Json -Compress
} finally {
  if ($document) { $document.Close($false) }
  if ($word) { $word.Quit() }
}
`

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, DOCX_PATH: filePath },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000,
      },
    )
    const records = JSON.parse(stdout.trim()) as Array<{ text: string; page: number }>
    const pages = records.map((record) => ({
      page: record.page,
      contentKey: paragraphMatchKey(record.text),
    }))
    renderedLocationCache.set(filePath, {
      modifiedTime: stats.mtimeMs,
      pages,
    })
    await fs.writeFile(cachePath, JSON.stringify({ modifiedTime: stats.mtimeMs, pages }))
    return pages
  } catch (error) {
    console.warn('Microsoft Word pagination was unavailable; using stored page breaks.', error)
    return []
  }
}

async function extractParagraphsFromDocx(filePath: string): Promise<ParagraphRecord[]> {
  const fileBuffer = await fs.readFile(filePath)
  const zip = new PizZip(fileBuffer)
  const documentXml = zip.file('word/document.xml')?.asText()

  if (!documentXml) {
    throw new Error('The DOCX manual does not contain word/document.xml.')
  }

  const document = parser.parseFromString(normalizeDocumentXml(documentXml), 'application/xml')
  const paragraphNodes = Array.from(document.getElementsByTagName('w:p'))
  const renderedPages = await extractRenderedLocations(filePath)
  let pageNumber = 1
  let sectionHeading = 'Document overview'

  return paragraphNodes.map((paragraphNode, index) => {
    const textNodes = Array.from(paragraphNode.getElementsByTagName('w:t'))
    const text = normalizeWhitespace(textNodes.map((node) => node.textContent ?? '').join(''))
    const styleNode = paragraphNode.getElementsByTagName('w:pStyle').item(0)
    const styleId = styleNode?.getAttribute('w:val') ?? null
    const renderedBreaks = paragraphNode.getElementsByTagName('w:lastRenderedPageBreak').length
    const explicitBreaks = Array.from(paragraphNode.getElementsByTagName('w:br')).filter(
      (node) => node.getAttribute('w:type') === 'page',
    ).length
    pageNumber += renderedBreaks + explicitBreaks
    if (text && styleId && (/^Heading\d+$/i.test(styleId) || /^PrefaceHeading\d+$/i.test(styleId))) {
      sectionHeading = text
    }

    const paragraphKey = paragraphMatchKey(text)
    const renderedPage =
      paragraphKey.length >= 12
        ? renderedPages.find((page) => page.contentKey.includes(paragraphKey))?.page
        : undefined
    if (renderedPage) {
      pageNumber = renderedPage
    }

    const hasImage = paragraphNode.getElementsByTagName('w:drawing').length > 0

    return {
      index,
      text,
      styleId,
      pageNumber,
      sectionHeading,
      hasImage,
    }
  })
}

function buildChunks(paragraphs: ParagraphRecord[]): ManualChunk[] {
  const nonEmpty = paragraphs.filter((paragraph) => paragraph.text || paragraph.hasImage)
  const chunks: ManualChunk[] = []
  let slice: ParagraphRecord[] = []

  function addChunk(records: ParagraphRecord[]) {
    if (records.length === 0) {
      return
    }
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      paragraphIndices: records.map((paragraph) => paragraph.index),
      pageNumbers: [...new Set(records.map((paragraph) => paragraph.pageNumber))],
      sectionHeadings: [...new Set(records.map((paragraph) => paragraph.sectionHeading))],
      content: records
        .map(
          (paragraph) =>
            `Page ${paragraph.pageNumber}, section "${paragraph.sectionHeading}": ${paragraph.text}`,
        )
        .join('\n'),
    })
  }

  for (const paragraph of nonEmpty) {
    const previous = slice.at(-1)
    const boundaryChanged =
      previous &&
      (previous.pageNumber !== paragraph.pageNumber ||
        previous.sectionHeading !== paragraph.sectionHeading)

    if (slice.length >= 5 || boundaryChanged) {
      addChunk(slice)
      slice = []
    }
    slice.push(paragraph)
  }

  addChunk(slice)

  return chunks
}

function findAncestorRun(node: any) {
  let current = node?.parentNode
  while (current && current.nodeName !== 'w:r') {
    current = current.parentNode
  }
  return current
}

function forceNormalWeight(runNode: any) {
  if (!runNode) {
    return
  }

  const document = runNode.ownerDocument
  let runProperties = Array.from(runNode.childNodes as ArrayLike<any>).find(
    (child) => child.nodeName === 'w:rPr',
  )
  if (!runProperties) {
    runProperties = document.createElement('w:rPr')
    runNode.insertBefore(runProperties, runNode.firstChild)
  }

  for (const elementName of ['w:b', 'w:bCs']) {
    let boldSetting = runProperties.getElementsByTagName(elementName).item(0)
    if (!boldSetting) {
      boldSetting = document.createElement(elementName)
      runProperties.appendChild(boldSetting)
    }
    boldSetting.setAttribute('w:val', '0')
  }
}

function replaceParagraphText(
  paragraphNode: any,
  replacementText: string,
  preserveRunFormatting = false,
) {
  const textNodes = Array.from(paragraphNode.getElementsByTagName('w:t')) as any[]

  if (textNodes.length === 0) {
    const document = paragraphNode.ownerDocument
    const runNode = document.createElement('w:r')
    const textNode = document.createElement('w:t')
    textNode.setAttribute('xml:space', 'preserve')
    textNode.appendChild(document.createTextNode(replacementText))
    if (!preserveRunFormatting) {
      forceNormalWeight(runNode)
    }
    runNode.appendChild(textNode)
    paragraphNode.appendChild(runNode)
    return
  }

  const destination = preserveRunFormatting
    ? textNodes[0]
    : (textNodes.find((textNode) => {
        const run = findAncestorRun(textNode)
        const bold = run?.getElementsByTagName('w:b').item(0)
        return !bold || bold.getAttribute('w:val') === '0' || bold.getAttribute('w:val') === 'false'
      }) ?? textNodes[0])

  destination.textContent = replacementText
  destination.setAttribute('xml:space', 'preserve')
  if (!preserveRunFormatting) {
    forceNormalWeight(findAncestorRun(destination))
  }

  for (const textNode of textNodes) {
    if (textNode !== destination) {
      textNode.textContent = ''
    }
  }
}

function paragraphText(paragraphNode: any) {
  return normalizeWhitespace(
    Array.from(paragraphNode.getElementsByTagName('w:t') as ArrayLike<any>)
      .map((node) => node.textContent ?? '')
      .join(''),
  )
}

function paragraphStyleId(paragraphNode: any) {
  return paragraphNode.getElementsByTagName('w:pStyle').item(0)?.getAttribute('w:val') ?? ''
}

function isNormalBodyParagraph(paragraphNode: any) {
  const styleId = paragraphStyleId(paragraphNode)
  return (
    !!paragraphText(paragraphNode) &&
    !/^(Heading|Title|TOC|PrefaceHeading|Caption|CSTemplate-TableHeading)/i.test(styleId)
  )
}

function findBodyParagraphTemplate(paragraphNodes: any[], targetIndex: number, target: any) {
  if (isNormalBodyParagraph(target)) {
    return target
  }

  for (let distance = 1; distance <= 12; distance += 1) {
    const candidates = [paragraphNodes[targetIndex + distance], paragraphNodes[targetIndex - distance]]
    const sameContainer = candidates.find(
      (candidate) => candidate?.parentNode === target.parentNode && isNormalBodyParagraph(candidate),
    )
    if (sameContainer) {
      return sameContainer
    }

    const bodyParagraph = candidates.find((candidate) => candidate && isNormalBodyParagraph(candidate))
    if (bodyParagraph) {
      return bodyParagraph
    }
  }

  return target
}

function createBodyParagraph(
  template: any,
  replacementText: string,
  preserveRunFormatting = false,
) {
  const document = template.ownerDocument
  const paragraph = document.createElement('w:p')
  const paragraphProperties = Array.from(template.childNodes as ArrayLike<any>).find(
    (child) => child.nodeName === 'w:pPr',
  )
  if (paragraphProperties) {
    paragraph.appendChild(paragraphProperties.cloneNode(true))
  }

  const templateText = Array.from(template.getElementsByTagName('w:t') as ArrayLike<any>)[0]
  const templateRun = findAncestorRun(templateText)
  const run = document.createElement('w:r')
  const runProperties = templateRun
    ? Array.from(templateRun.childNodes as ArrayLike<any>).find((child) => child.nodeName === 'w:rPr')
    : null
  if (runProperties) {
    run.appendChild(runProperties.cloneNode(true))
  }
  if (!preserveRunFormatting) {
    forceNormalWeight(run)
  }

  const text = document.createElement('w:t')
  text.setAttribute('xml:space', 'preserve')
  text.appendChild(document.createTextNode(replacementText))
  run.appendChild(text)
  paragraph.appendChild(run)
  return paragraph
}

function disableAutomaticFieldUpdates(zip: PizZip) {
  const settingsXml = zip.file('word/settings.xml')?.asText()
  if (!settingsXml) {
    return
  }

  const settings = parser.parseFromString(normalizeDocumentXml(settingsXml), 'application/xml')
  const root = settings.documentElement
  if (!root) {
    return
  }
  const updateFields = settings.getElementsByTagName('w:updateFields').item(0)
  if (updateFields) {
    updateFields.setAttribute('w:val', 'false')
    zip.file('word/settings.xml', serializer.serializeToString(settings))
  }
}

async function refreshTableOfContents(filePath: string) {
  if (process.platform !== 'win32') {
    return false
  }

  const script = `
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.Options.UpdateLinksAtOpen = $false
  $document = $word.Documents.Open($env:DOCX_PATH, $false, $false, $false)
  foreach ($tableOfContents in $document.TablesOfContents) {
    $tableOfContents.Update()
  }
  $document.Save()
} finally {
  if ($document) { $document.Close($false) }
  if ($word) { $word.Quit() }
}
`

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DOCX_PATH: filePath },
      timeout: 180000,
    })
    return true
  } catch (error) {
    console.warn('The table of contents could not be refreshed automatically.', error)
    return false
  }
}

function registerImageInDocx(
  zip: PizZip,
  imageBuffer: Buffer,
  originalFilename: string,
) {
  const extension = path.extname(originalFilename).toLowerCase().replace('.', '') || 'png'
  const contentType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png'

  // 1. Update [Content_Types].xml if the extension is not present
  const contentTypesXml = zip.file('[Content_Types].xml')?.asText()
  if (contentTypesXml) {
    const ctDoc = parser.parseFromString(normalizeDocumentXml(contentTypesXml), 'application/xml')
    const defaults = Array.from(ctDoc.getElementsByTagName('Default'))
    const exists = defaults.some(
      (node) => node.getAttribute('Extension')?.toLowerCase() === extension,
    )
    if (!exists) {
      const newDefault = ctDoc.createElement('Default')
      newDefault.setAttribute('Extension', extension)
      newDefault.setAttribute('ContentType', contentType)
      ctDoc.documentElement?.appendChild(newDefault)
      zip.file('[Content_Types].xml', serializer.serializeToString(ctDoc))
    }
  }

  // 2. Determine unique image name in word/media/
  const existingFiles = Object.keys(zip.files)
  let imageIndex = 1
  while (existingFiles.includes(`word/media/image_inst_${imageIndex}.${extension}`)) {
    imageIndex++
  }
  const mediaFileName = `image_inst_${imageIndex}.${extension}`
  const mediaPath = `word/media/${mediaFileName}`
  zip.file(mediaPath, imageBuffer)

  // 3. Register relationship in word/_rels/document.xml.rels
  const relsXml = zip.file('word/_rels/document.xml.rels')?.asText()
  if (!relsXml) {
    throw new Error('Could not find word/_rels/document.xml.rels in manual DOCX')
  }

  const relsDoc = parser.parseFromString(normalizeDocumentXml(relsXml), 'application/xml')
  const relationships = Array.from(relsDoc.getElementsByTagName('Relationship'))
  let maxRId = 1
  for (const rel of relationships) {
    const id = rel.getAttribute('Id') ?? ''
    const match = id.match(/rId(\d+)/i)
    if (match) {
      const num = parseInt(match[1], 10)
      if (num >= maxRId) maxRId = num + 1
    }
  }
  const relId = `rId${maxRId}`

  const newRel = relsDoc.createElement('Relationship')
  newRel.setAttribute('Id', relId)
  newRel.setAttribute(
    'Type',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  )
  newRel.setAttribute('Target', `media/${mediaFileName}`)
  relsDoc.documentElement?.appendChild(newRel)
  zip.file('word/_rels/document.xml.rels', serializer.serializeToString(relsDoc))

  return relId
}

function createImageParagraph(
  document: any,
  relId: string,
  caption?: string,
) {
  const paragraph = document.createElement('w:p')

  // Center alignment
  const pPr = document.createElement('w:pPr')
  const jc = document.createElement('w:jc')
  jc.setAttribute('w:val', 'center')
  pPr.appendChild(jc)
  paragraph.appendChild(pPr)

  // Drawing run
  const run = document.createElement('w:r')
  const drawing = document.createElement('w:drawing')

  // Standard inline drawing (approx 5.5 inches wide, 3.5 inches tall in EMUs: 1 inch = 914400 EMUs)
  const cx = 5029200
  const cy = 3200400
  const docPrId = Math.floor(Math.random() * 1000000) + 1000

  const inlineXml = `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="${docPrId}" name="InstructionPicture"/>
    <wp:cNvGraphicFramePr>
      <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
    </wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr>
            <pic:cNvPr id="${docPrId}" name="InstructionImage"/>
            <pic:cNvPicPr/>
          </pic:nvPicPr>
          <pic:blipFill>
            <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/>
            <a:stretch><a:fillRect/></a:stretch>
          </pic:blipFill>
          <pic:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>`

  const inlineDoc = parser.parseFromString(inlineXml, 'application/xml')
  drawing.appendChild(document.importNode(inlineDoc.documentElement, true))
  run.appendChild(drawing)
  paragraph.appendChild(run)

  // Optional caption paragraph
  if (caption && caption.trim()) {
    const captionP = document.createElement('w:p')
    const capPPr = document.createElement('w:pPr')
    const capJc = document.createElement('w:jc')
    capJc.setAttribute('w:val', 'center')
    capPPr.appendChild(capJc)
    captionP.appendChild(capPPr)

    const capRun = document.createElement('w:r')
    const capRPr = document.createElement('w:rPr')
    const italic = document.createElement('w:i')
    capRPr.appendChild(italic)
    capRun.appendChild(capRPr)

    const capText = document.createElement('w:t')
    capText.setAttribute('xml:space', 'preserve')
    capText.appendChild(document.createTextNode(caption.trim()))
    capRun.appendChild(capText)
    captionP.appendChild(capRun)

    return [paragraph, captionP]
  }

  return [paragraph]
}

async function applyEditsToDocx(
  baseManualPath: string,
  edits: EditOperation[],
  outputPath: string,
  updateIndex: boolean,
  preserveRunFormatting = false,
  attachedImagesMap: Map<string, { buffer: Buffer; originalFilename: string }> = new Map(),
  screenshotBuffer?: { buffer: Buffer; originalFilename: string },
) {
  const fileBuffer = await fs.readFile(baseManualPath)
  const zip = new PizZip(fileBuffer)
  const documentXml = zip.file('word/document.xml')?.asText()

  if (!documentXml) {
    throw new Error('The DOCX manual does not contain editable document XML.')
  }

  const document = parser.parseFromString(normalizeDocumentXml(documentXml), 'application/xml')
  const paragraphNodes = Array.from(document.getElementsByTagName('w:p'))
  const sortedEdits = [...edits].sort((left, right) => right.paragraphIndex - left.paragraphIndex)

  for (const edit of sortedEdits) {
    const target = paragraphNodes[edit.paragraphIndex]
    if (!target) {
      continue
    }

    if (edit.type === 'insert_after') {
      const template = findBodyParagraphTemplate(paragraphNodes, edit.paragraphIndex, target)
      let insertPoint: any = target

      if (edit.replacementText) {
        const paragraph = createBodyParagraph(
          template,
          edit.replacementText,
          preserveRunFormatting,
        )
        target.parentNode?.insertBefore(paragraph, insertPoint.nextSibling)
        insertPoint = paragraph
      }

      // Check if this edit operation has an attached image to insert
      if (edit.imageAttachment && attachedImagesMap.size > 0) {
        const matchingImgKey = Array.from(attachedImagesMap.keys()).find(
          (k) =>
            k.toLowerCase() === edit.imageAttachment!.toLowerCase() ||
            k.toLowerCase().includes(edit.imageAttachment!.toLowerCase()) ||
            edit.imageAttachment!.toLowerCase().includes(k.toLowerCase()),
        )
        const imgData = matchingImgKey ? attachedImagesMap.get(matchingImgKey) : undefined
        if (imgData) {
          const relId = registerImageInDocx(zip, imgData.buffer, imgData.originalFilename)
          const imgParagraphs = createImageParagraph(document, relId, edit.imageCaption)
          for (const imgP of imgParagraphs) {
            target.parentNode?.insertBefore(imgP, insertPoint.nextSibling)
            insertPoint = imgP
          }
        }
      }
      continue
    }

    // replace
    if (edit.replacementText) {
      replaceParagraphText(target, edit.replacementText, preserveRunFormatting)
    }

    // Replace existing screenshot/image in manual if requested
    if (edit.replaceImage && screenshotBuffer) {
      const blipNodes = Array.from(target.getElementsByTagName('a:blip'))
      if (blipNodes.length > 0) {
        // Paragraph already has an existing image drawing — register the new screenshot and update r:embed
        const relId = registerImageInDocx(zip, screenshotBuffer.buffer, screenshotBuffer.originalFilename)
        for (const blip of blipNodes) {
          blip.setAttribute('r:embed', relId)
        }
      } else {
        // If the target paragraph didn't have drawing XML itself, insert the screenshot right after it
        const relId = registerImageInDocx(zip, screenshotBuffer.buffer, screenshotBuffer.originalFilename)
        const imgParagraphs = createImageParagraph(document, relId, edit.imageCaption)
        let insertPoint: any = target
        for (const imgP of imgParagraphs) {
          target.parentNode?.insertBefore(imgP, insertPoint.nextSibling)
          insertPoint = imgP
        }
      }
    }

    // If replace also specified an image attachment
    if (edit.imageAttachment && attachedImagesMap.size > 0) {
      const matchingImgKey = Array.from(attachedImagesMap.keys()).find(
        (k) =>
          k.toLowerCase() === edit.imageAttachment!.toLowerCase() ||
          k.toLowerCase().includes(edit.imageAttachment!.toLowerCase()) ||
          edit.imageAttachment!.toLowerCase().includes(k.toLowerCase()),
      )
      const imgData = matchingImgKey ? attachedImagesMap.get(matchingImgKey) : undefined
      if (imgData) {
        const relId = registerImageInDocx(zip, imgData.buffer, imgData.originalFilename)
        const imgParagraphs = createImageParagraph(document, relId, edit.imageCaption)
        let insertPoint: any = target
        for (const imgP of imgParagraphs) {
          target.parentNode?.insertBefore(imgP, insertPoint.nextSibling)
          insertPoint = imgP
        }
      }
    }
  }

  zip.file('word/document.xml', serializer.serializeToString(document))
  disableAutomaticFieldUpdates(zip)
  const outputBuffer = zip.generate({ type: 'nodebuffer' })
  await fs.writeFile(outputPath, outputBuffer)

  if (updateIndex) {
    await refreshTableOfContents(outputPath)
  }
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
    const knowledgeBaseReleaseNotes = await listDocxFiles(releaseNotesKnowledgeBaseDir, 'release-notes')
    const updatedManuals = await listDocxFiles(updatedManualsDir, 'updated-manuals')
    const updatedReleaseNotes = await listDocxFiles(updatedReleaseNotesDir, 'updated-release-notes')

    response.json({
      knowledgeBaseManuals,
      knowledgeBaseReleaseNotes,
      updatedManuals,
      updatedReleaseNotes,
    })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/manuals/:fileName', async (request, response, next) => {
  try {
    const fileName = path.basename(request.params.fileName)
    if (!fileName.toLowerCase().endsWith('.docx')) {
      response.status(400).json({ error: 'Only generated DOCX manuals can be deleted.' })
      return
    }

    const filePath = path.join(updatedManualsDir, fileName)
    await fs.unlink(filePath)
    response.status(204).send()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      response.status(404).json({ error: 'The generated manual was not found.' })
      return
    }
    next(error)
  }
})

app.delete('/api/release-notes/:fileName', async (request, response, next) => {
  try {
    const fileName = path.basename(request.params.fileName)
    if (!fileName.toLowerCase().endsWith('.docx')) {
      response.status(400).json({ error: 'Only generated DOCX release notes can be deleted.' })
      return
    }

    await fs.unlink(path.join(updatedReleaseNotesDir, fileName))
    response.status(204).send()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      response.status(404).json({ error: 'The generated release notes were not found.' })
      return
    }
    next(error)
  }
})

app.post(
  '/api/process',
  upload.fields([
    { name: 'userStory', maxCount: 1 },
    { name: 'screenshot', maxCount: 1 },
    { name: 'instructionImages', maxCount: 10 },
  ]),
  async (request, response, next) => {
    const files = request.files as
      | {
          userStory?: Express.Multer.File[]
          screenshot?: Express.Multer.File[]
          instructionImages?: Express.Multer.File[]
        }
      | undefined

    const userStoryFile = files?.userStory?.[0]
    const screenshotFile = files?.screenshot?.[0]
    const instructionImageFiles = files?.instructionImages ?? []
    const screenshotDescription = String(request.body.screenshotDescription ?? '').trim()
    const additionalInstructions = String(request.body.additionalInstructions ?? '').trim()
    const replaceScreenshotInManual = request.body.replaceScreenshotInManual === 'true'
    const updateIndex = request.body.updateIndex === 'true'

    if (!userStoryFile || !screenshotFile) {
      response.status(400).json({ error: 'Upload both a user story file and a screenshot.' })
      return
    }

    const screenshotBuffer = {
      buffer: await fs.readFile(screenshotFile.path),
      originalFilename: screenshotFile.originalname,
    }

    // Build memory map of attached instruction images
    const attachedImagesMap = new Map<string, { buffer: Buffer; originalFilename: string }>()
    for (const imgFile of instructionImageFiles) {
      const buffer = await fs.readFile(imgFile.path)
      attachedImagesMap.set(imgFile.originalname, {
        buffer,
        originalFilename: imgFile.originalname,
      })
    }

    try {
      const client = requireClient()
      const baseManual = await bootstrapKnowledgeBase()

      if (!baseManual) {
        response.status(400).json({ error: 'No fixed DOCX manual was found in the workspace.' })
        return
      }

      const storyText = await extractStoryText(userStoryFile.path, userStoryFile.originalname)
      const screenshotSummary = await analyzeScreenshot(
        client,
        screenshotFile.path,
        screenshotFile.mimetype,
        screenshotDescription,
      )
      const paragraphs = await extractParagraphsFromDocx(baseManual.path)
      const chunks = buildChunks(paragraphs)
      const retrievalQuery = [
        storyText,
        screenshotDescription,
        additionalInstructions,
        ...instructionImageFiles.map((f) => f.originalname),
        screenshotSummary.summary,
        ...screenshotSummary.visibleChanges,
        ...screenshotSummary.impacts,
      ]
        .join('\n')
        .slice(0, 12000)
      const retrievedChunks = await retrieveRelevantChunks(client, retrievalQuery, chunks)
      const paragraphIndices = new Set(retrievedChunks.flatMap((chunk) => chunk.paragraphIndices))
      const relevantParagraphs = paragraphs.filter((paragraph) => paragraphIndices.has(paragraph.index))
      const attachedImageNames = instructionImageFiles.map((f) => f.originalname)
      const edits = await planEdits(
        client,
        storyText,
        screenshotSummary,
        relevantParagraphs,
        additionalInstructions,
        attachedImageNames,
        replaceScreenshotInManual,
      )
      const outputFileName = buildOutputFileName(baseManual.name)
      const outputPath = path.join(updatedManualsDir, outputFileName)

      if (edits.length > 0 || updateIndex) {
        await applyEditsToDocx(
          baseManual.path,
          edits,
          outputPath,
          updateIndex,
          false,
          attachedImagesMap,
          screenshotBuffer,
        )
      } else {
        await fs.copyFile(baseManual.path, outputPath)
      }

      const releaseNotesSource = (
        await listDocxFiles(releaseNotesKnowledgeBaseDir, 'release-notes')
      )[0] ?? null
      let releaseNotesOutputFileName: string | null = null
      let releaseNotesOutputUrl: string | null = null
      let releaseNotesRetrievedChunks: ManualChunk[] = []
      let releaseNotesParagraphs: ParagraphRecord[] = []
      let releaseNotesEdits: EditOperation[] = []

      if (releaseNotesSource) {
        releaseNotesParagraphs = await extractParagraphsFromDocx(releaseNotesSource.path)
        const releaseNotesChunks = buildChunks(releaseNotesParagraphs)
        releaseNotesRetrievedChunks = await retrieveRelevantChunks(
          client,
          retrievalQuery,
          releaseNotesChunks,
        )
        const releaseNotesParagraphIndices = new Set(
          releaseNotesRetrievedChunks.flatMap((chunk) => chunk.paragraphIndices),
        )
        const relevantReleaseNotesParagraphs = releaseNotesParagraphs.filter((paragraph) =>
          releaseNotesParagraphIndices.has(paragraph.index),
        )
        releaseNotesEdits = await planReleaseNotesEdits(
          client,
          storyText,
          screenshotSummary,
          relevantReleaseNotesParagraphs,
          additionalInstructions,
        )
        releaseNotesOutputFileName = buildOutputFileName(releaseNotesSource.name)
        const releaseNotesOutputPath = path.join(
          updatedReleaseNotesDir,
          releaseNotesOutputFileName,
        )

        if (releaseNotesEdits.length > 0 || updateIndex) {
          await applyEditsToDocx(
            releaseNotesSource.path,
            releaseNotesEdits,
            releaseNotesOutputPath,
            updateIndex,
            true,
          )
        } else {
          await fs.copyFile(releaseNotesSource.path, releaseNotesOutputPath)
        }
        releaseNotesOutputUrl = `/downloads/updated-release-notes/${encodeURIComponent(releaseNotesOutputFileName)}`
      }

      response.json({
        outputFileName,
        outputUrl: `/downloads/updated-manuals/${encodeURIComponent(outputFileName)}`,
        generatedAt: new Date().toISOString(),
        storyExcerpt: trimForPreview(storyText, 260),
        additionalInstructions: additionalInstructions || null,
        attachedImageCount: instructionImageFiles.length,
        replaceScreenshotRequested: replaceScreenshotInManual,
        screenshotSummary,
        indexUpdateRequested: updateIndex,
        retrievedChunks: retrievedChunks.map((chunk) => ({
          id: chunk.id,
          pageNumbers: chunk.pageNumbers,
          sectionHeadings: chunk.sectionHeadings,
          preview: trimForPreview(chunk.content),
        })),
        edits: edits.map(({ type, paragraphIndex, replacementText, reason, imageAttachment, imageCaption, replaceImage }) => {
          const target = paragraphs[paragraphIndex]
          return {
            type,
            pageNumber: target?.pageNumber ?? 1,
            sectionHeading: target?.sectionHeading ?? 'Document overview',
            oldText: target?.text ?? '',
            newText: replacementText,
            reason,
            imageAttachment,
            imageCaption,
            replaceImage,
          }
        }),
        releaseNotesOutputFileName,
        releaseNotesOutputUrl,
        releaseNotesRetrievedChunks: releaseNotesRetrievedChunks.map((chunk) => ({
          id: chunk.id,
          pageNumbers: chunk.pageNumbers,
          sectionHeadings: chunk.sectionHeadings,
          preview: trimForPreview(chunk.content),
        })),
        releaseNotesEdits: releaseNotesEdits.map(
          ({ type, paragraphIndex, replacementText, reason }) => {
            const target = releaseNotesParagraphs[paragraphIndex]
            return {
              type,
              pageNumber: target?.pageNumber ?? 1,
              sectionHeading: target?.sectionHeading ?? 'Release notes',
              oldText: target?.text ?? '',
              newText: replacementText,
              reason,
            }
          },
        ),
      })
    } catch (error) {
      next(error)
    } finally {
      await cleanupFiles([
        userStoryFile.path,
        screenshotFile.path,
        ...instructionImageFiles.map((f) => f.path),
      ])
    }
  },
)

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = describeWorkflowError(error).message
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