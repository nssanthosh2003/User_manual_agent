# TCS AgentAssist Manual Updater

This application keeps the approved TCS AgentAssist user manual as a fixed knowledge base, accepts a user story file plus a screenshot of the requested UI change, and produces an updated DOCX manual in a separate updated-manuals folder.

## What it does

- Uses the existing DOCX manual as the immutable source manual.
- Extracts change intent from the uploaded user story file, including Excel workbooks.
- Uses GPT-5 for screenshot analysis and change extraction.
- Builds a lightweight RAG flow over the manual paragraphs to retrieve only the relevant sections.
- Creates a DOCX copy with only the targeted paragraphs updated.
- Saves generated outputs under storage/updated-manuals.

## Setup

1. Create a .env file from .env.example.
2. Add your OpenAI API key.
3. Run npm install if dependencies are not already present.
4. Run npm run dev.

## Environment variables

OPENAI_API_KEY is required.

Optional values:

- OPENAI_MODEL defaults to gpt-5
- PORT defaults to 8787

## Folders

- storage/knowledge-base: fixed manual copies used for retrieval
- storage/updated-manuals: generated updated manuals
- storage/uploads: transient upload staging area

## Build

- npm run build compiles the React client and the Express server
- npm start runs the compiled server from dist-server
