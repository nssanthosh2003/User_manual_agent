# TCS AgentAssist Manual Updater

This application keeps the approved TCS AgentAssist user manual and release notes as fixed knowledge-base documents. It accepts a user story file plus a screenshot of the requested UI change and produces updated DOCX copies of both documents.

## What it does

- Uses the existing DOCX manual as the immutable source manual.
- Uses a DOCX release notes file as a second immutable knowledge-base source.
- Extracts change intent from the uploaded user story file, including Excel workbooks.
- Uses GPT-5 for screenshot analysis and change extraction.
- Builds separate lightweight RAG flows over the manual and release notes to retrieve relevant sections from each.
- Creates DOCX copies with only the targeted paragraphs updated.
- Shows old and new text for both documents in the dashboard.
- Saves generated outputs under storage/updated-manuals and storage/updated-release-notes.
- Caches GPT-5 screenshot analyses and edit plans so identical inputs return identical agent decisions.

## Setup

1. Create a .env file from .env.example.
2. Configure the Azure AI endpoint and authentication values.
3. Place the approved release notes DOCX file in storage/release-notes.
4. Run npm install if dependencies are not already present.
5. Run npm run dev.

## Environment variables

Required values:

- OPENAI_BASE_URL: Azure AI v1 endpoint, such as https://agentassist-1.services.ai.azure.com/openai/v1
- AZURE_AI_ACCESS_TOKEN: current Microsoft Entra bearer token, or OPENAI_API_KEY: Azure AI API key

Bearer tokens are short-lived and must be refreshed. The supplied Python DefaultAzureCredential example requires Azure Identity and an authenticated developer credential; this TypeScript app accepts the resulting token directly.

Optional values:

- OPENAI_MODEL defaults to gpt-5
- AGENT_CACHE_ENABLED defaults to true; set it to false to force new GPT-5 responses
- PORT defaults to 8787

## Folders

- storage/knowledge-base: fixed manual copies used for retrieval
- storage/release-notes: fixed release notes DOCX files used for retrieval
- storage/updated-manuals: generated updated manuals
- storage/updated-release-notes: generated updated release notes
- storage/uploads: transient upload staging area
- storage/agent-cache: persistent prompt results keyed by SHA-256 hashes of the inputs, model, endpoint, and prompt version

## Stable agent results

The first request for a unique set of inputs calls GPT-5 and stores its structured outputs locally. Repeating the same story, screenshot, screenshot description, source context, model, and prompt version reuses those cached outputs. Prompt-version changes automatically create new cache entries.

## Build

- npm run build compiles the React client and the Express server
- npm start runs the compiled server from dist-server
