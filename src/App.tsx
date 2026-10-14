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
  updatedManuals: ManualFile[]
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
  retrievedChunks: Array<{
    id: string
    paragraphIndices: number[]
    preview: string
  }>
  edits: Array<{
    type: 'replace' | 'insert_after'
    paragraphIndex: number
    reason: string
  }>
}

function App() {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({
    knowledgeBaseManuals: [],
    updatedManuals: [],
  })
  const [storyFile, setStoryFile] = useState<File | null>(null)
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
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
      setWorkspaceState(payload)
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

  return (
    <main className="shell">
      <section className="hero-panel">
        <p className="eyebrow">Agentic workflow + RAG manual updater</p>
        <h1>TCS AgentAssist Manual Updater</h1>
        <p className="hero-copy">
          Keep the approved DOCX manual fixed as the knowledge base, submit a user story file and a
          screenshot, and generate an updated manual in a separate output folder without disturbing
          the original source manual.
        </p>

        <div className="hero-metrics">
          <article>
            <span>Vision model</span>
            <strong>GPT-5</strong>
          </article>
          <article>
            <span>Knowledge source</span>
            <strong>{workspaceState.knowledgeBaseManuals.length || 0} fixed manuals</strong>
          </article>
          <article>
            <span>Generated outputs</span>
            <strong>{workspaceState.updatedManuals.length || 0} manuals</strong>
          </article>
        </div>
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

          <div className="workflow-strip">
            <article>
              <strong>1</strong>
              <p>Extract story text and analyze the screenshot with GPT-5.</p>
            </article>
            <article>
              <strong>2</strong>
              <p>Retrieve only the relevant manual paragraphs through embeddings-based RAG.</p>
            </article>
            <article>
              <strong>3</strong>
              <p>Apply targeted DOCX edits and save the updated manual in the output section.</p>
            </article>
          </div>

          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

          <button className="submit-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Updating manual...' : 'Generate updated manual'}
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

              <article className="result-card">
                <h3>User story excerpt</h3>
                <p>{deferredResult.storyExcerpt}</p>
              </article>

              <article className="result-card">
                <h3>Screenshot summary</h3>
                <p>{deferredResult.screenshotSummary.summary}</p>
                <div className="tag-list">
                  {deferredResult.screenshotSummary.visibleChanges.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </article>

              <article className="result-card">
                <h3>Retrieved manual slices</h3>
                <div className="chunk-list">
                  {deferredResult.retrievedChunks.map((chunk) => (
                    <div key={chunk.id} className="chunk-card">
                      <span>Paragraphs {chunk.paragraphIndices.join(', ')}</span>
                      <p>{chunk.preview}</p>
                    </div>
                  ))}
                </div>
              </article>

              <article className="result-card">
                <h3>Applied edits</h3>
                <div className="edit-list">
                  {deferredResult.edits.map((edit, index) => (
                    <div key={`${edit.paragraphIndex}-${index}`} className="edit-card">
                      <strong>{edit.type === 'replace' ? 'Replace' : 'Insert after'} paragraph {edit.paragraphIndex}</strong>
                      <p>{edit.reason}</p>
                    </div>
                  ))}
                </div>
              </article>
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
                  <a href={manual.url} target="_blank" rel="noreferrer">
                    Open output
                  </a>
                </article>
              ))
            ) : (
              <p className="empty-state">The updated-manuals folder will populate after the first run.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
