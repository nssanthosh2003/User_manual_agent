import { startTransition, useDeferredValue, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type ManualFile = {
  name: string
  url: string
  createdAt: string
  sizeKb: number
}

type WorkspaceState = {
  knowledgeBaseManuals: ManualFile[]
  knowledgeBaseReleaseNotes: ManualFile[]
  updatedManuals: ManualFile[]
  updatedReleaseNotes: ManualFile[]
}

type RetrievedChunk = {
  id: string
  pageNumbers: number[]
  sectionHeadings: string[]
  preview: string
}

type AppliedEdit = {
  type: 'replace' | 'insert_after'
  pageNumber: number
  sectionHeading: string
  oldText: string
  newText: string
  reason: string
}

type ProcessResult = {
  outputFileName: string
  outputUrl: string
  generatedAt: string
  storyExcerpt: string
  screenshotSummary: {
    summary: string
    visibleChanges: string[]
    extractedText: string[]
    impacts: string[]
  }
  retrievedChunks: RetrievedChunk[]
  edits: AppliedEdit[]
  releaseNotesOutputFileName: string | null
  releaseNotesOutputUrl: string | null
  releaseNotesRetrievedChunks: RetrievedChunk[]
  releaseNotesEdits: AppliedEdit[]
  indexUpdateRequested: boolean
}

function App() {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({
    knowledgeBaseManuals: [],
    knowledgeBaseReleaseNotes: [],
    updatedManuals: [],
    updatedReleaseNotes: [],
  })
  const [storyFile, setStoryFile] = useState<File | null>(null)
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null)
  const [screenshotDescription, setScreenshotDescription] = useState('')
  const [updateIndex, setUpdateIndex] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletingManual, setDeletingManual] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [result, setResult] = useState<ProcessResult | null>(null)
  const deferredResult = useDeferredValue(result)

  async function loadWorkspaceState() {
    const response = await fetch('/api/manuals')

    if (!response.ok) {
      throw new Error('Unable to load the knowledge base manual list.')
    }

    const payload = (await response.json()) as WorkspaceState

    startTransition(() => {
      setWorkspaceState({
        knowledgeBaseManuals: payload.knowledgeBaseManuals ?? [],
        knowledgeBaseReleaseNotes: payload.knowledgeBaseReleaseNotes ?? [],
        updatedManuals: payload.updatedManuals ?? [],
        updatedReleaseNotes: payload.updatedReleaseNotes ?? [],
      })
    })
  }

  useEffect(() => {
    loadWorkspaceState().catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the workspace state.')
    })
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!storyFile || !screenshotFile) {
      setErrorMessage('Select both a user story file and a screenshot before processing.')
      return
    }

    const formData = new FormData()
    formData.append('userStory', storyFile)
    formData.append('screenshot', screenshotFile)
    formData.append('screenshotDescription', screenshotDescription)
    formData.append('updateIndex', String(updateIndex))

    setIsSubmitting(true)
    setErrorMessage('')

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        body: formData,
      })

      const payload = (await response.json()) as ProcessResult | { error: string }

      if (!response.ok) {
        throw new Error('error' in payload ? payload.error : 'The manual update workflow failed.')
      }

      setResult(payload as ProcessResult)
      await loadWorkspaceState()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The manual update workflow failed.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function deleteDocument(manual: ManualFile, documentType: 'manual' | 'release-notes') {
    if (!window.confirm(`Delete "${manual.name}" permanently?`)) {
      return
    }

    setDeletingManual(manual.name)
    setErrorMessage('')
    try {
      const route = documentType === 'manual' ? 'manuals' : 'release-notes'
      const response = await fetch(`/api/${route}/${encodeURIComponent(manual.name)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'Unable to delete the generated document.')
      }
      if (
        result?.outputFileName === manual.name ||
        result?.releaseNotesOutputFileName === manual.name
      ) {
        setResult(null)
      }
      await loadWorkspaceState()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to delete the generated document.')
    } finally {
      setDeletingManual('')
    }
  }

  return (
    <main className="shell">
      <section className="hero-panel">
        <h1>TCS AgentAssist Manual Updater</h1>
      </section>

      <section className="grid-layout">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <div>
              <p className="section-tag">Inputs</p>
              <h2>Submit change request</h2>
            </div>
            <span className="status-chip">React + Express</span>
          </div>

          <label className="input-card">
            <span>User story file</span>
            <input
              type="file"
              accept=".txt,.md,.json,.docx,.xlsx,.xls"
              onChange={(event) => setStoryFile(event.target.files?.[0] ?? null)}
            />
            <small>{storyFile ? storyFile.name : 'Upload the refined user story file in Excel or document format.'}</small>
          </label>

          <label className="input-card">
            <span>Change screenshot</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setScreenshotFile(event.target.files?.[0] ?? null)}
            />
            <small>{screenshotFile ? screenshotFile.name : 'Upload the screenshot that contains the UI change.'}</small>
          </label>

          <label className="input-card">
            <span>Screenshot change description</span>
            <textarea
              value={screenshotDescription}
              onChange={(event) => setScreenshotDescription(event.target.value)}
              placeholder="Describe what changed in the screenshot, what the new controls do, and any wording that should appear in the manual."
              rows={4}
            />
            <small>This context is combined with the screenshot analysis to produce a precise update.</small>
          </label>

          <label className="index-option">
            <input
              type="checkbox"
              checked={updateIndex}
              onChange={(event) => setUpdateIndex(event.target.checked)}
            />
            <span>
              <strong>Update document indexes</strong>
              <small>Refresh available tables of contents and page references before the generated documents are saved.</small>
            </span>
          </label>

          <div className="workflow-strip">
            <article>
              <strong>1</strong>
              <p>Analyze inputs.</p>
            </article>
            <article>
              <strong>2</strong>
              <p>Find relevant sections.</p>
            </article>
            <article>
              <strong>3</strong>
              <p>Generate both documents.</p>
            </article>
          </div>

          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

          <button className="submit-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Updating documents...' : 'Generate updated documents'}
          </button>
        </form>

        <aside className="panel side-panel">
          <div className="panel-heading">
            <div>
              <p className="section-tag">Fixed knowledge base</p>
              <h2>Source manual</h2>
            </div>
          </div>

          <div className="manual-list compact">
            {workspaceState.knowledgeBaseManuals.length ? (
              workspaceState.knowledgeBaseManuals.map((manual) => (
                <article className="manual-card" key={manual.url}>
                  <div>
                    <h3>{manual.name}</h3>
                    <p>{manual.sizeKb} KB</p>
                  </div>
                  <a href={manual.url} target="_blank" rel="noreferrer">
                    Open source manual
                  </a>
                </article>
              ))
            ) : (
              <p className="empty-state">No DOCX knowledge base manual is available yet.</p>
            )}
          </div>

          <div className="knowledge-group">
            <div className="panel-heading compact-heading">
              <div>
                <p className="section-tag">Fixed knowledge base</p>
                <h2>Source release notes</h2>
              </div>
            </div>
            <div className="manual-list compact">
              {workspaceState.knowledgeBaseReleaseNotes.length ? (
                workspaceState.knowledgeBaseReleaseNotes.map((document) => (
                  <article className="manual-card" key={document.url}>
                    <div>
                      <h3>{document.name}</h3>
                      <p>{document.sizeKb} KB</p>
                    </div>
                    <a href={document.url} target="_blank" rel="noreferrer">
                      Open source release notes
                    </a>
                  </article>
                ))
              ) : (
                <p className="empty-state">
                  Add a DOCX release notes file to storage/release-notes.
                </p>
              )}
            </div>
          </div>
        </aside>
      </section>

      <section className="grid-layout secondary-grid">
        <section className="panel result-panel">
          <div className="panel-heading">
            <div>
              <p className="section-tag">Workflow result</p>
              <h2>Latest update run</h2>
            </div>
          </div>

          {deferredResult ? (
            <div className="result-stack">
              <article className="result-summary">
                <div>
                  <span className="result-label">Generated file</span>
                  <h3>{deferredResult.outputFileName}</h3>
                  <p>{new Date(deferredResult.generatedAt).toLocaleString()}</p>
                </div>
                <a className="download-link" href={deferredResult.outputUrl} target="_blank" rel="noreferrer">
                  Download updated manual
                </a>
              </article>

              {deferredResult.releaseNotesOutputFileName && deferredResult.releaseNotesOutputUrl ? (
                <article className="result-summary">
                  <div>
                    <span className="result-label">Generated release notes</span>
                    <h3>{deferredResult.releaseNotesOutputFileName}</h3>
                    <p>{new Date(deferredResult.generatedAt).toLocaleString()}</p>
                  </div>
                  <a
                    className="download-link"
                    href={deferredResult.releaseNotesOutputUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download updated release notes
                  </a>
                </article>
              ) : (
                <article className="result-card">
                  <h3>Release notes not generated</h3>
                  <p>Add a DOCX file to storage/release-notes, then run the workflow again.</p>
                </article>
              )}

              <article className="result-card">
                <h3>Change request</h3>
                <p>{deferredResult.storyExcerpt}</p>
              </article>

              <article className="result-card">
                <h3>Screenshot summary</h3>
                <p>{deferredResult.screenshotSummary.summary}</p>
                <ul className="summary-list">
                  {deferredResult.screenshotSummary.visibleChanges.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>

              <article className="result-card">
                <h3>Retrieved manual slices</h3>
                <div className="chunk-list">
                  {deferredResult.retrievedChunks.map((chunk) => (
                    <div key={chunk.id} className="chunk-card">
                      <div className="location-row">
                        <strong>{chunk.pageNumbers.length === 1 ? `Word page ${chunk.pageNumbers[0]}` : `Word pages ${chunk.pageNumbers.join(', ')}`}</strong>
                        <span>Section: {chunk.sectionHeadings.join(' · ')}</span>
                      </div>
                      <p>{chunk.preview}</p>
                    </div>
                  ))}
                </div>
              </article>

              <article className="result-card">
                <h3>Applied manual edits</h3>
                <div className="edit-list">
                  {deferredResult.edits.map((edit, index) => (
                    <div key={`${edit.pageNumber}-${edit.sectionHeading}-${index}`} className="edit-card">
                      <div className="location-row">
                        <strong>Word page {edit.pageNumber}</strong>
                        <span>Section: {edit.sectionHeading}</span>
                      </div>
                      <p className="edit-reason">{edit.reason}</p>
                      <div className="comparison-grid">
                        <div className="comparison-old">
                          <span>{edit.type === 'replace' ? 'Old text' : 'Insert after'}</span>
                          <p>{edit.oldText || `Existing content in ${edit.sectionHeading}`}</p>
                        </div>
                        <div className="comparison-new">
                          <span>New text</span>
                          <p>{edit.newText}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {deferredResult.indexUpdateRequested ? (
                  <p className="index-status">The manual index was refreshed before the document was saved.</p>
                ) : null}
              </article>

              {deferredResult.releaseNotesOutputFileName ? (
                <>
                  <article className="result-card">
                    <h3>Retrieved release notes slices</h3>
                    <div className="chunk-list">
                      {deferredResult.releaseNotesRetrievedChunks.map((chunk) => (
                        <div key={chunk.id} className="chunk-card">
                          <div className="location-row">
                            <strong>
                              {chunk.pageNumbers.length === 1
                                ? `Word page ${chunk.pageNumbers[0]}`
                                : `Word pages ${chunk.pageNumbers.join(', ')}`}
                            </strong>
                            <span>Section: {chunk.sectionHeadings.join(' · ')}</span>
                          </div>
                          <p>{chunk.preview}</p>
                        </div>
                      ))}
                    </div>
                  </article>

                  <article className="result-card">
                    <h3>Applied release notes edits</h3>
                    <div className="edit-list">
                      {deferredResult.releaseNotesEdits.length ? (
                        deferredResult.releaseNotesEdits.map((edit, index) => (
                          <div key={`${edit.pageNumber}-${edit.sectionHeading}-${index}`} className="edit-card">
                            <div className="location-row">
                              <strong>Word page {edit.pageNumber}</strong>
                              <span>Section: {edit.sectionHeading}</span>
                            </div>
                            <p className="edit-reason">{edit.reason}</p>
                            <div className="comparison-grid">
                              <div className="comparison-old">
                                <span>{edit.type === 'replace' ? 'Old text' : 'Insert after'}</span>
                                <p>{edit.oldText || `Existing content in ${edit.sectionHeading}`}</p>
                              </div>
                              <div className="comparison-new">
                                <span>New text</span>
                                <p>{edit.newText}</p>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="empty-state">No release notes text change was required.</p>
                      )}
                    </div>
                  </article>
                </>
              ) : null}
            </div>
          ) : (
            <p className="empty-state">
              Run the workflow once to inspect the extracted screenshot changes, retrieved manual
              sections, and the generated output file.
            </p>
          )}
        </section>

        <section className="panel outputs-panel">
          <div className="panel-heading">
            <div>
              <p className="section-tag">Updated manuals</p>
              <h2>Output section</h2>
            </div>
          </div>

          <div className="manual-list">
            {workspaceState.updatedManuals.length ? (
              workspaceState.updatedManuals.map((manual) => (
                <article className="manual-card" key={manual.url}>
                  <div>
                    <h3>{manual.name}</h3>
                    <p>
                      {manual.sizeKb} KB · {new Date(manual.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="manual-actions">
                    <a href={manual.url} target="_blank" rel="noreferrer">
                      Open output
                    </a>
                    <button
                      className="delete-button"
                      type="button"
                      onClick={() => deleteDocument(manual, 'manual')}
                      disabled={deletingManual === manual.name}
                    >
                      {deletingManual === manual.name ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-state">The updated-manuals folder will populate after the first run.</p>
            )}
          </div>

          <div className="knowledge-group output-group">
            <div className="panel-heading compact-heading">
              <div>
                <p className="section-tag">Updated release notes</p>
                <h2>Release notes outputs</h2>
              </div>
            </div>
            <div className="manual-list">
              {workspaceState.updatedReleaseNotes.length ? (
                workspaceState.updatedReleaseNotes.map((document) => (
                  <article className="manual-card" key={document.url}>
                    <div>
                      <h3>{document.name}</h3>
                      <p>
                        {document.sizeKb} KB · {new Date(document.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="manual-actions">
                      <a href={document.url} target="_blank" rel="noreferrer">
                        Open output
                      </a>
                      <button
                        className="delete-button"
                        type="button"
                        onClick={() => deleteDocument(document, 'release-notes')}
                        disabled={deletingManual === document.name}
                      >
                        {deletingManual === document.name ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty-state">Updated release notes will appear after the first run.</p>
              )}
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
