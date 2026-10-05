# Research Paper Manager

A local desktop app for reading, organizing, and asking AI about your research
papers. Runs entirely on your own machine (Windows Surface Book / Windows 11).

## What it does

- **Upload PDFs** and read them in an in-app viewer.
- **Highlight text** — select any passage; your highlights are saved and
  re-appear every time you reopen the paper.
- **Ask the AI about the open paper** — a side chat answers questions and cites
  the pages it used. Hover an answer and click **Reply** (or select part of it)
  to start a **thread**: a separate follow-up conversation about that answer,
  shown as a single "N replies" link so the main chat stays tidy.
- **Peter explains** — a parody audio clip of Peter Griffin explaining the
  paper's core ideas to Stewie. Gemini writes the dialogue and Gemini's
  text-to-speech performs it with two built-in voices directed to play the
  characters (not the real actors' voices). The first play takes ~1–2 minutes
  and uses TTS quota; the clip (~9 MB WAV) is then cached per paper in
  `storage/audio/`, and "New take" records a fresh one.
- **Summarize** the whole paper, or just a highlighted passage, with one click.
- **A searchable library** of everything you've uploaded, plus a **cross-corpus
  chatbot** that answers questions across your entire collection and cites which
  papers it drew from.
- **Semantic arXiv search** on the Dashboard (the landing screen): describe what
  you want in plain language. Gemini turns it into arXiv queries, results are
  reranked by meaning with Gemini embeddings, and recent papers rank higher.
- **Recommendations** from arXiv based on the papers you've most recently added
  and opened (cached for a few hours; **Refresh** recomputes them).
- **Add to library** from any search result or recommendation: the PDF is
  downloaded from arXiv and indexed like an upload, so you can highlight,
  summarize and chat with it. Cards already in your library show **Open**.
  Without a Gemini key, search falls back to plain arXiv keyword search (still
  recency-boosted).

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
| arXiv discovery | arXiv API (Atom, `urllib` + `xml.etree`) + Gemini embeddings (`gemini-embedding-001`, REST) | Stdlib only; responses and embeddings cached in `cache/papers.db` |

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

**Easiest:** double-click **Start Research Paper Manager.bat** in the project
folder (or a Desktop shortcut to it). It opens a small minimized window that
runs the server; your browser opens once the app is ready. Close that window to
stop the app. Double-clicking again while it's running just reopens the browser.

Or, from **PowerShell**, go to the project folder and run the launcher:

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

Two things travel separately, on purpose:

| What | How it syncs | Why |
| --- | --- | --- |
| The **code** (`backend/`, `frontend/`, `run.ps1`) | git | small, text, mergeable, and you want its history |
| Your **library** (`storage/`) | OneDrive | big binaries that git would bloat on forever |

Don't let both sync the same files: `storage/` is in `.gitignore`, and `cache/`
must never be synced by anything.

### Moving `storage/` into OneDrive (first computer, once)

Any file-sync service works — OneDrive, Dropbox, Syncthing, iCloud. Point it at
`storage/` and the app needs no configuration. On Windows, move the folder into
OneDrive and leave a directory junction behind. `$env:OneDriveConsumer` is your
personal OneDrive; use it rather than `$env:OneDrive`, which points to a school
or work account when one is signed in (those can be deleted when you leave):

```powershell
# from the project root, with the app closed
Move-Item storage "$env:OneDriveConsumer\ResearchPaperManager-storage"
New-Item -ItemType Junction -Path storage -Target "$env:OneDriveConsumer\ResearchPaperManager-storage"
```

### Setting up the second computer

```powershell
git clone <your repo url> ResearchPaperManager
cd ResearchPaperManager

# 1. Your API key is not in the repo - create .env from the template.
Copy-Item .env.example .env
notepad .env          # paste your GEMINI_API_KEY

# 2. Point storage/ at the OneDrive copy (which has already synced here).
New-Item -ItemType Junction -Path storage -Target "$env:OneDriveConsumer\ResearchPaperManager-storage"

# 3. Run it. The first launch rebuilds cache/papers.db from storage/.
.\run.ps1
```

From then on: `git pull` for code changes, and OneDrive handles the papers by
itself.


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
- `RPM_EMBED_MODEL` — embedding model for arXiv search/recommendations
  (default `gemini-embedding-001`).
- `RPM_FALLBACK_MODEL` — used to write arXiv queries when the main model is
  overloaded (default `gemini-flash-lite-latest`).
- `RPM_TTS_MODEL` / `RPM_TTS_FALLBACK_MODEL` — text-to-speech models for
  "Peter explains" (defaults `gemini-3.1-flash-tts-preview` /
  `gemini-2.5-flash-preview-tts`); `RPM_PETER_VOICE` / `RPM_STEWIE_VOICE` pick
  the built-in voices (defaults `Fenrir` / `Iapetus`).

### Custom voices for Peter and Stewie (optional, RVC)

Peter and Stewie can each speak in a voice model of your own, such as an RVC `.pth` trained
on **your own recordings** (use only voices you have permission to use).

1. Double-click **setup-rvc.bat** once. It builds `.rvc-env\` (about 5 GB,
   git-ignored): Python 3.12, Applio's RVC inference code, CUDA PyTorch, and
   the pitch/content models. It needs Anaconda or Miniconda and git. An NVIDIA
   GPU makes it much faster.
2. That's it for the voices in this repo: Peter's and Stewie's models are in
   `voices/PG` and `voices/SG` (stored with Git LFS, so run `git lfs install`
   before cloning), each with a `voice.json` holding its pitch. Once
   `.rvc-env\` exists they're used automatically. To use a different model,
   override them in `.env`:
   - `RPM_PETER_RVC_MODEL=C:\path\to\voice.pth`
   - `RPM_PETER_RVC_INDEX=C:\path\to\voice.index` (optional, improves timbre)
   - `RPM_PETER_RVC_PITCH=0`: semitones; raise or lower it until it sounds
     like your pitch range.
   - For Stewie, the same three with `RPM_STEWIE_RVC_…`. Either character
     can use a model on their own.
   - Advanced: `RPM_RVC_INDEX_RATE` (0.75), `RPM_RVC_PROTECT` (0.33),
     `RPM_RVC_F0_METHOD` (`rmvpe`)
3. Restart the app and press **New take** on a paper.

With a model set, Gemini records Peter's and Stewie's lines separately (2 TTS
requests per clip). The app splits them at the pauses, converts each modeled
character's lines with RVC, and interleaves the turns. RVC changes only the voice's timbre; the
timing and delivery still come from Gemini's read. You can test a model on
its own, without the app, with `.rvc-env\env\python.exe tools\rvc_worker.py`.
See the docstring for the job format.

While a clip plays, a muted background video from `videos/` plays alongside
it, starting at a random point (`videos/mc_parkour.mp4`, a 30-minute cut, is
included via Git LFS). Add any `.mp4`/`.webm` there, or point `RPM_VIDEOS_DIR`
in `.env` at another folder.

Ranking knobs (recency half-life, profile size, pool sizes, cache lifetimes)
are constants at the top of `backend/discover.py`. Gemini's free tier embeds
at most 100 texts per minute, so each search embeds at most `EMBED_NEW_MAX`
new abstracts; raise it on a paid tier.

## Troubleshooting

- **"AI disabled" in the sidebar** — your `GEMINI_API_KEY` isn't set. Edit
  `.env`, add the key, restart with `.\run.ps1`.
- **PDF won't display** — the viewer loads PDF.js from a CDN, so the first load
  needs an internet connection.
- **Port already in use** — change `RPM_PORT` in `.env` (e.g. to `8010`).
