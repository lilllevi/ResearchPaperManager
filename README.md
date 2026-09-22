# Research Paper Manager

A local desktop app for reading, organizing, and asking AI about your research
papers. Runs entirely on your own machine (Windows Surface Book / Windows 11).

## What it does

- **Upload PDFs** and read them in an in-app viewer.
- **Highlight text** — select any passage; your highlights are saved and
  re-appear every time you reopen the paper.
- **Ask the AI about the open paper** — a side chat answers questions and cites
  the pages it used.
- **Summarize** the whole paper, or just a highlighted passage, with one click.
- **A searchable library** of everything you've uploaded, plus a **cross-corpus
  chatbot** that answers questions across your entire collection and cites which
  papers it drew from.

Everything you create — papers, extracted text, highlights, chat history, and
the search index — is stored on disk in `storage/` (a SQLite database plus the
PDF files). **Your data persists across restarts.**

## How it's built (and why it's Windows-friendly)

| Piece | Choice | Why |
|------|--------|-----|
| Backend | Python + FastAPI | Pure-Python wheels; no C/C++ build tools needed on Windows |
| PDF reading | `pypdf` | Pure Python, installs cleanly |
| PDF viewing/highlighting | PDF.js (in the browser) | No native dependency |
| Search / retrieval | BM25 (`rank-bm25`) | Pure Python; no embedding service or extra API key |
| Storage | SQLite (built into Python) + PDF files on disk | Durable, zero-setup, survives restarts |
| AI | Google Gemini (`gemini-2.5-flash`) | Fast, capable, large context window |

The app is a local web app: a small server runs on your machine and you use it
in your browser. Nothing is uploaded anywhere except the text sent to Google
Gemini for the AI features you trigger.

---

## Setup on your Surface Book (Windows 11)

### 1. Install Python (one time)

If you don't already have it, install **Python 3.10 or newer** from
<https://www.python.org/downloads/>. On the first installer screen, **check
"Add python.exe to PATH."**

### 2. Get a Gemini API key (for the AI features)

Create a key at <https://aistudio.google.com/apikey>. You'll paste it into a
`.env` file in the next step. (The app runs without a key, but the
summarize/chat features stay disabled until you add one.)

### 3. Start the app

Open **PowerShell**, go to the project folder, and run the launcher:

```powershell
cd "$HOME\Desktop\ResearchPaperManager"
.\run.ps1
```

The first run creates a virtual environment, installs dependencies, and creates
a `.env` file. Open `.env` in Notepad, paste your key after `GEMINI_API_KEY=`,
save, then run `.\run.ps1` again:

```powershell
notepad .env
.\run.ps1
```

Your browser opens automatically at <http://127.0.0.1:8000>.

> **If PowerShell blocks the script** with an execution-policy error, allow local
> scripts for your user account (one time), then re-run:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
> Alternatively, bypass it for a single run:
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\run.ps1
> ```

To stop the app, press **Ctrl+C** in the PowerShell window.

---

## Using it

1. Click **+ Upload PDF** and pick a paper. It's read, indexed, and opened.
2. Read in the middle pane. **Select text** to get a small toolbar:
   - **Highlight** — saves the highlight (persists across restarts).
   - **Summarize** — the AI summarizes just that passage in the side chat.
   - **Ask AI** — drops the passage into the chat box so you can ask about it.
3. Use the **Chat** tab on the right to ask questions about the open paper.
   Click **Summarize paper** in the header for a full-paper summary.
4. Click **💬 Chat across all papers** in the sidebar to ask questions spanning
   your whole library; answers cite the source papers.
5. The **Highlights** tab lists every highlight in the current paper; click
   **Go to** to jump to it.

---

## Where your data lives

Your library lives in `storage/`, as plain per-item files:

- `storage/uploads/<uid>.pdf` — the original PDF. Written once, never changes.
- `storage/papers/<uid>.txt` — extracted page text. Written once, never changes.
- `storage/papers/<uid>.json` — that paper's title, folder, highlights and chat.
- `storage/folders/<uid>.json` — one file per folder.
- `storage/library-chat.json` — the cross-corpus chat history.

The SQLite database is **not** your data. It sits in `cache/papers.db`, is
rebuilt from `storage/` every time the app starts, and can be deleted at any
time without losing anything.

To back up your library, copy `storage/`. To reset everything, delete it.

## Using it on more than one computer

Point any file-sync service — OneDrive, Dropbox, Syncthing, iCloud — at the
`storage/` folder, on each machine. That's the whole setup. There is nothing to
configure in the app.

**On Windows with OneDrive**, the simplest route is to keep the project inside
your OneDrive folder, or to move just `storage/` there and leave a directory
junction behind:

```powershell
# from the project root, with the app closed
Move-Item storage "$env:OneDrive\ResearchPaperManager-storage"
New-Item -ItemType Junction -Path storage -Target "$env:OneDrive\ResearchPaperManager-storage"
```

Do the same on the second machine (the junction, not the move — OneDrive will
have already synced the folder there).

Why this is safe: everything that changes is small, per-item and text, so two
machines editing different papers never write the same file. The one thing that
*must* never be synced is the live SQLite database — which is why it lives in
`cache/`, outside `storage/`, where no sync client will ever see it.

A few things worth knowing:

- **Don't run the app on two machines at the same time.** Each writes its own
  sidecars fine, but neither sees the other's changes until it re-reads them.
- **Picking up changes without restarting:** the app reads `storage/` at
  startup. If a sync lands while it's open, `POST /api/sync/reload` re-reads
  the files into the cache.
- **Conflicts:** if you do edit the same paper on two machines, your sync client
  leaves a second file next to the original (`<uid>-DESKTOP-ABC.json`). The app
  ignores it — it checks that the filename matches the id inside — and logs
  `ignored unrecognized sidecar` at startup. Open it, keep what you want,
  delete it. Nothing is silently lost.
- **Repair:** if the sidecars are ever damaged but the cache is intact,
  `POST /api/sync/export` rewrites every file from the database.

## Configuration

Settings live in `.env`:

- `GEMINI_API_KEY` — your key (required for AI features).
- `RPM_MODEL` — model to use (default `gemini-2.5-flash`; `gemini-2.5-pro` is
  more capable).
- `RPM_HOST` / `RPM_PORT` — where the local server listens (default
  `127.0.0.1:8000`).

## Troubleshooting

- **"AI disabled" in the sidebar** — your `GEMINI_API_KEY` isn't set. Edit
  `.env`, add the key, restart with `.\run.ps1`.
- **PDF won't display** — the viewer loads PDF.js from a CDN, so the first load
  needs an internet connection.
- **Port already in use** — change `RPM_PORT` in `.env` (e.g. to `8010`).
