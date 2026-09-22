"""FastAPI application: serves the frontend and the JSON API.

Run from the project root with run.ps1, or directly:
    uvicorn backend.main:app --host 127.0.0.1 --port 8000
"""

import json
import sys
from pathlib import Path

# Make the sibling modules (db, rag, ai, pdf_utils) importable whether the app
# is launched as "backend.main:app" from the project root or run directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv

# Load .env from the project root before anything reads os.environ.
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import rag
import ai
import pdf_utils
import store
import discover

FRONTEND_DIR = BASE_DIR / "frontend"


def _sync_from_disk():
    """Reconcile the cache with the sidecar files, then refresh the index."""
    with db.suspended_flush():
        result = store.bootstrap()
    rag.index.rebuild()
    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    db.backfill_uids()
    # storage/ is the source of truth; the DB in cache/ is rebuilt from it.
    result = _sync_from_disk()
    print(
        f"[store] {result['mode']}: {result['papers']} papers, "
        f"{result['folders']} folders"
        + (f", {result['imported']} updated" if result.get("imported") else "")
        + (f", {result['removed']} removed" if result.get("removed") else "")
    )
    for name in result.get("skipped") or []:
        print(f"[store] ignored unrecognized sidecar (sync conflict copy?): {name}")
    yield


app = FastAPI(title="Research Paper Manager", lifespan=lifespan)


# --------------------------------------------------------------- API models

class ChatRequest(BaseModel):
    question: str
    selection: str | None = None
    # Thread replies: the assistant message being replied to, and optionally
    # the part of it the user selected.
    parent_uid: str | None = None
    quote: str | None = None


class HighlightRequest(BaseModel):
    page: int
    text: str
    rects: list = []
    color: str = "#ffd54a"
    note: str = ""


class PaperUpdate(BaseModel):
    # All optional; we use model_fields_set to tell "omitted" from "set to null".
    title: str | None = None
    folder_id: int | None = None
    bookmarked: bool | None = None


class ArxivAdd(BaseModel):
    arxiv_id: str
    title: str | None = None


class InterestsUpdate(BaseModel):
    interests: list[str]


class FolderCreate(BaseModel):
    name: str
    parent_id: int | None = None


class FolderUpdate(BaseModel):
    # Both optional; model_fields_set distinguishes "omitted" from "set to null"
    # (setting parent_id to null moves the folder to the top level).
    name: str | None = None
    parent_id: int | None = None


# ------------------------------------------------------------------ status

@app.get("/api/status")
def status():
    return {"ai_enabled": ai.has_api_key(), "model": ai.MODEL}


@app.post("/api/sync/reload")
def sync_reload():
    """Re-read the sidecar files into the cache.

    Startup does this automatically; this endpoint exists for when a sync
    client drops in another machine's changes while the app is already open, so
    you can pick them up without restarting."""
    return _sync_from_disk()


@app.post("/api/sync/export")
def sync_export():
    """Rewrite every sidecar from the cache — a repair for files lost or
    damaged while the database is still intact."""
    with db.suspended_flush():
        db.backfill_uids()
        result = store.export_all()
    return result


# ------------------------------------------------------------------ papers

@app.get("/api/papers")
def get_papers():
    return db.list_papers()


def ingest_pdf(data, filename, title=None, arxiv_id=None):
    """Store, extract, index and persist a PDF. Shared by manual uploads and
    "Add to library" from arXiv, so both produce identical papers.
    Returns {"id", "title", "num_pages"}."""
    # The uid is this paper's stable identity everywhere: the PDF filename, the
    # text and JSON sidecars, and the row in the cache all key off it.
    uid = store.new_uid()
    stored_name = f"{uid}.pdf"
    dest = db.UPLOADS_DIR / stored_name
    dest.write_bytes(data)

    try:
        pages, num_pages = pdf_utils.extract_pages(dest)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read PDF: {e}")

    full_text = "\n".join(pages)
    # Prefer an explicit title; otherwise let the AI read the title off the
    # paper's opening text; fall back to the filename if that's unavailable.
    paper_title = (title or "").strip()
    if not paper_title and ai.has_api_key():
        try:
            paper_title = ai.detect_title(full_text)
        except Exception:
            paper_title = ""
    if not paper_title:
        paper_title = filename.rsplit(".", 1)[0]

    # A hand-uploaded arXiv PDF carries its id in the page-1 margin stamp.
    if not arxiv_id and pages:
        arxiv_id = discover.arxiv_id_in_text(pages[0])

    paper_id = db.insert_paper(
        paper_title, filename, stored_name, num_pages, full_text, uid, arxiv_id
    )
    chunks = pdf_utils.chunk_pages(pages)
    if chunks:
        db.insert_chunks(paper_id, chunks)
    # Page text goes to its own immutable sidecar so other machines can rebuild
    # the index without re-parsing the PDF.
    store.write_text(uid, pages)
    store.write_paper(paper_id)
    rag.index.rebuild()

    return {"id": paper_id, "title": paper_title, "num_pages": num_pages}


@app.post("/api/papers")
async def upload_paper(file: UploadFile = File(...), title: str = Form(None)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported.")
    data = await file.read()
    return ingest_pdf(data, file.filename, title)


@app.get("/api/papers/{paper_id}")
def paper_meta(paper_id: int):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    return {
        "id": paper["id"],
        "title": paper["title"],
        "filename": paper["filename"],
        "num_pages": paper["num_pages"],
        "uploaded_at": paper["uploaded_at"],
        "arxiv_id": paper.get("arxiv_id"),
        "last_viewed": paper.get("last_viewed"),
    }


@app.post("/api/papers/{paper_id}/view")
def mark_viewed(paper_id: int):
    """Called when a paper is opened in the viewer; feeds recommendations."""
    if not db.get_paper(paper_id):
        raise HTTPException(404, "Paper not found.")
    db.set_last_viewed(paper_id)
    return {"ok": True}


@app.patch("/api/papers/{paper_id}")
def update_paper(paper_id: int, req: PaperUpdate):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    fields = req.model_fields_set
    if "title" in fields:
        new_title = (req.title or "").strip()
        if not new_title:
            raise HTTPException(400, "Title cannot be empty.")
        db.rename_paper(paper_id, new_title)
        # Titles appear in cross-corpus source citations, so refresh the index.
        rag.index.rebuild()
    if "folder_id" in fields:
        if req.folder_id is not None and not db.get_folder(req.folder_id):
            raise HTTPException(404, "Folder not found.")
        db.set_paper_folder(paper_id, req.folder_id)
    if "bookmarked" in fields:
        db.set_paper_bookmarked(paper_id, bool(req.bookmarked))
    return {"ok": True}


@app.get("/api/papers/{paper_id}/file")
def paper_file(paper_id: int):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    path = db.UPLOADS_DIR / paper["stored_name"]
    if not path.exists():
        raise HTTPException(404, "PDF file missing on disk.")
    return FileResponse(path, media_type="application/pdf", filename=paper["filename"])


@app.delete("/api/papers/{paper_id}")
def remove_paper(paper_id: int):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    # Remove the PDF and its sidecars, then the DB rows (cascades to chunks).
    # Deleting the sidecar is what propagates this delete to other machines.
    if paper.get("uid"):
        store.delete_paper_files(paper["uid"])
    else:
        (db.UPLOADS_DIR / paper["stored_name"]).unlink(missing_ok=True)
    db.delete_paper(paper_id)
    rag.index.rebuild()
    return {"ok": True}


# -------------------------------------------------------------- summaries

@app.post("/api/papers/{paper_id}/summarize")
def summarize(paper_id: int):
    _require_ai()
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    summary = ai.summarize_document(paper["title"], paper["full_text"])
    # Persist the summary into the document chat so it survives restarts.
    db.add_message("doc", paper_id, "user", "Summarize this paper.")
    uid = db.add_message("doc", paper_id, "assistant", summary)
    return {"summary": summary, "message_uid": uid}


@app.post("/api/papers/{paper_id}/prereading")
def prereading(paper_id: int):
    _require_ai()
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    guide = ai.generate_prereading(paper["title"], paper["full_text"])
    # Persist into the document chat so it survives restarts, like summaries.
    db.add_message("doc", paper_id, "user", "Generate a prereading guide.")
    uid = db.add_message("doc", paper_id, "assistant", guide)
    return {"prereading": guide, "message_uid": uid}


@app.post("/api/papers/{paper_id}/summarize-selection")
def summarize_selection(paper_id: int, req: ChatRequest):
    _require_ai()
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    passage = (req.selection or req.question or "").strip()
    if not passage:
        raise HTTPException(400, "No passage provided.")
    summary = ai.summarize_passage(paper["title"], passage)
    db.add_message("doc", paper_id, "user", f"Summarize this passage:\n\n{passage}")
    uid = db.add_message("doc", paper_id, "assistant", summary)
    return {"summary": summary, "message_uid": uid}


# ------------------------------------------------------ "Peter explains" audio
# A parody audio explainer (Peter Griffin explains the paper to Stewie): a
# Gemini-written dialogue performed by Gemini multi-speaker TTS. One clip is
# cached per paper in storage/audio/; regenerate=true makes a new take. It is
# deliberately kept out of the chat history.

def _peter_response(paper_id, meta, cached):
    return {
        "transcript": meta["transcript"],
        "created_at": meta["created_at"],
        "audio_url": f"/api/papers/{paper_id}/peter/audio?v={int(meta['created_at'])}",
        "cached": cached,
    }


def _paper_or_404(paper_id):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    return paper


@app.get("/api/papers/{paper_id}/peter")
def peter_status(paper_id: int):
    meta = store.read_peter(_paper_or_404(paper_id)["uid"])
    if not meta:
        raise HTTPException(404, "No clip yet.")
    return _peter_response(paper_id, meta, True)


@app.post("/api/papers/{paper_id}/peter")
def peter_explains(paper_id: int, regenerate: bool = False):
    _require_ai()
    paper = _paper_or_404(paper_id)
    if not regenerate:
        meta = store.read_peter(paper["uid"])
        if meta:
            return _peter_response(paper_id, meta, True)
    # Papers rebuilt from sidecars can have an empty full_text in the cache;
    # the page-text sidecar always has it.
    text = paper.get("full_text") or "\n".join(store.read_pages(paper["uid"]))
    if not text.strip():
        raise HTTPException(400, "This paper has no extracted text to explain.")
    try:
        script = ai.peter_explains_script(paper["title"], text)
        wav = ai.speak_dialogue(script)
    except ai.GeminiError as e:
        raise HTTPException(502, str(e))
    meta = {"transcript": script, "created_at": db.now()}
    store.write_peter(paper["uid"], wav, script, meta["created_at"])
    return _peter_response(paper_id, meta, False)


@app.get("/api/papers/{paper_id}/peter/audio")
def peter_audio(paper_id: int):
    wav_path, _ = store.peter_paths(_paper_or_404(paper_id)["uid"])
    if not wav_path.exists():
        raise HTTPException(404, "No clip yet.")
    return FileResponse(wav_path, media_type="audio/wav")


# ------------------------------------------------------------ chat threads
# Any assistant message can have a thread: a separate conversation branching
# off it. Thread replies are stored with parent_uid and never appear in (or
# feed the AI history of) the main chat.

MAX_QUOTE_LEN = 4000


def _with_quote(content, quote):
    if not quote:
        return content
    return f'Regarding this part of your earlier answer:\n"""\n{quote}\n"""\n\n{content}'


def _chat_context(scope, paper_id, req):
    """(history, question for the AI, cleaned quote) for a main-chat or
    thread message. A thread's history is the exchange it branches from
    followed by the thread itself, so the AI knows what's being discussed."""
    question = req.question.strip()
    if not question:
        raise HTTPException(400, "Empty question.")
    quote = (req.quote or "").strip()[:MAX_QUOTE_LEN] or None
    if not req.parent_uid:
        return db.get_main_messages(scope, paper_id), question, None
    thread = db.get_thread(scope, paper_id, req.parent_uid)
    if not thread:
        raise HTTPException(404, "The message this thread replies to no longer exists.")
    parent, prompt, replies = thread
    # The AI sees the last 6 history messages; keep the anchor exchange in
    # view by trimming the thread, not the message it branches from.
    history = ([prompt] if prompt else []) + [parent]
    history += [
        {"role": r["role"], "content": _with_quote(r["content"], r.get("quote"))}
        for r in replies[-(6 - len(history)):]
    ]
    return history, _with_quote(question, quote), quote


def _thread_response(scope, paper_id, parent_uid):
    thread = db.get_thread(scope, paper_id, parent_uid)
    if not thread:
        raise HTTPException(404, "Thread not found.")
    parent, prompt, replies = thread
    return {"parent": parent, "prompt": prompt, "messages": replies}


# ------------------------------------------------------------ document chat

@app.get("/api/papers/{paper_id}/chat")
def doc_chat_history(paper_id: int):
    return db.get_main_messages("doc", paper_id)


@app.get("/api/papers/{paper_id}/chat/thread/{parent_uid}")
def doc_chat_thread(paper_id: int, parent_uid: str):
    return _thread_response("doc", paper_id, parent_uid)


@app.post("/api/papers/{paper_id}/chat")
def doc_chat(paper_id: int, req: ChatRequest):
    _require_ai()
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    history, question, quote = _chat_context("doc", paper_id, req)

    # Retrieve context from this paper. If a passage is selected (in the PDF,
    # or quoted from an earlier answer), bias the search toward it.
    extra = req.selection or quote
    search_query = question if not extra else f"{req.question.strip()}\n{extra}"
    hits = rag.index.search(search_query, top_k=6, paper_id=paper_id)

    answer = ai.answer_about_document(
        paper["title"], question, hits, history, selection=req.selection
    )

    user_content = req.question.strip()
    if req.selection:
        user_content = f"[Re: highlighted passage]\n{user_content}"
    user_uid = db.add_message("doc", paper_id, "user", user_content, req.parent_uid, quote)
    uid = db.add_message("doc", paper_id, "assistant", answer, req.parent_uid)
    return {
        "answer": answer,
        "sources": [{"page": h["page"]} for h in hits],
        "message_uid": uid,
        "user_uid": user_uid,
    }


# --------------------------------------------------------------- highlights

@app.get("/api/papers/{paper_id}/highlights")
def get_highlights(paper_id: int):
    rows = db.list_highlights(paper_id)
    for r in rows:
        r["rects"] = json.loads(r["rects_json"])
        del r["rects_json"]
    return rows


@app.post("/api/papers/{paper_id}/highlights")
def create_highlight(paper_id: int, req: HighlightRequest):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found.")
    hid = db.add_highlight(
        paper_id, req.page, req.text, json.dumps(req.rects), req.color, req.note
    )
    return {"id": hid}


@app.delete("/api/highlights/{highlight_id}")
def remove_highlight(highlight_id: int):
    db.delete_highlight(highlight_id)
    return {"ok": True}


# ------------------------------------------------------------- library chat

@app.get("/api/library/chat")
def library_chat_history():
    return db.get_main_messages("library")


@app.get("/api/library/chat/thread/{parent_uid}")
def library_chat_thread(parent_uid: str):
    return _thread_response("library", None, parent_uid)


@app.post("/api/library/chat")
def library_chat(req: ChatRequest):
    _require_ai()
    history, question, quote = _chat_context("library", None, req)
    search_query = question if not quote else f"{req.question.strip()}\n{quote}"
    hits = rag.index.search(search_query, top_k=8)
    answer = ai.answer_across_corpus(question, hits, history)

    user_uid = db.add_message("library", None, "user", req.question.strip(), req.parent_uid, quote)
    uid = db.add_message("library", None, "assistant", answer, req.parent_uid)
    sources = [{"paper_id": h["paper_id"], "title": h["title"], "page": h["page"]} for h in hits]
    return {"answer": answer, "sources": sources, "message_uid": uid, "user_uid": user_uid}


# ------------------------------------------------------------ arXiv discovery

@app.get("/api/arxiv/search")
def arxiv_search(q: str = "", limit: int = 25, mode: str = "semantic"):
    """Semantic search across arXiv (Gemini queries + embeddings rerank, with
    recency weighting; keyword fallback without a Gemini key), or with
    mode=exact, a live exact-text search."""
    limit = max(1, min(limit, 50))
    try:
        if mode == "exact":
            return discover.exact_search(q, limit=limit)
        return discover.search(q, limit=limit)
    except discover.DiscoverError as e:
        raise HTTPException(502 if q.strip() else 400, str(e))


MAX_INTERESTS = 20
MAX_INTEREST_LEN = 120


@app.get("/api/interests")
def get_interests():
    return {"interests": store.read_interests()}


@app.put("/api/interests")
def put_interests(req: InterestsUpdate):
    """Replace the typed-in research interests used for recommendations."""
    cleaned, seen = [], set()
    for raw in req.interests:
        text = " ".join(str(raw).split())[:MAX_INTEREST_LEN]
        if text and text.lower() not in seen:
            seen.add(text.lower())
            cleaned.append(text)
    cleaned = cleaned[:MAX_INTERESTS]
    store.write_interests(cleaned)
    return {"interests": cleaned}


@app.get("/api/arxiv/recommendations")
def arxiv_recommendations(refresh: bool = False, limit: int = 20):
    """arXiv papers related to what you've recently uploaded and viewed.
    Cached for a few hours; refresh=true recomputes."""
    try:
        return discover.recommendations(refresh=refresh, limit=max(1, min(limit, 50)))
    except discover.DiscoverError as e:
        raise HTTPException(502, str(e))


@app.post("/api/arxiv/add")
def arxiv_add(req: ArxivAdd):
    """Download an arXiv paper's PDF and run it through the normal ingest."""
    aid = discover.normalize_arxiv_id(req.arxiv_id)
    if not aid:
        raise HTTPException(400, "That doesn't look like an arXiv id.")
    title = (req.title or "").strip()
    existing = discover.find_in_library({"arxiv_id": aid, "title": title})
    if existing:
        paper = db.get_paper(existing)
        return {"id": existing, "title": paper["title"], "num_pages": paper["num_pages"],
                "arxiv_id": aid, "already": True}
    try:
        if not title:
            meta = discover.arxiv_lookup(aid)
            if not meta:
                raise HTTPException(404, f"arXiv has no paper {aid}.")
            title = meta["title"]
        data = discover.download_pdf(aid)
    except discover.DiscoverError as e:
        raise HTTPException(502, str(e))
    result = ingest_pdf(data, f"{aid}.pdf", title, arxiv_id=aid)
    return {**result, "arxiv_id": aid, "already": False}


# ----------------------------------------------------------------- folders

@app.get("/api/folders")
def get_folders():
    return db.list_folders()


@app.post("/api/folders")
def create_folder(req: FolderCreate):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Folder name cannot be empty.")
    if req.parent_id is not None and not db.get_folder(req.parent_id):
        raise HTTPException(404, "Parent folder not found.")
    fid = db.create_folder(name, req.parent_id)
    return {"id": fid, "name": name, "parent_id": req.parent_id}


@app.patch("/api/folders/{folder_id}")
def update_folder(folder_id: int, req: FolderUpdate):
    if not db.get_folder(folder_id):
        raise HTTPException(404, "Folder not found.")
    fields = req.model_fields_set
    if "name" in fields:
        name = (req.name or "").strip()
        if not name:
            raise HTTPException(400, "Folder name cannot be empty.")
        db.rename_folder(folder_id, name)
    if "parent_id" in fields:
        pid = req.parent_id
        if pid is not None:
            if pid == folder_id:
                raise HTTPException(400, "A folder can't be its own parent.")
            if not db.get_folder(pid):
                raise HTTPException(404, "Parent folder not found.")
            if _is_descendant(folder_id, pid):
                raise HTTPException(400, "Can't move a folder into its own subfolder.")
        db.set_folder_parent(folder_id, pid)
    return {"ok": True}


@app.delete("/api/folders/{folder_id}")
def remove_folder(folder_id: int):
    if not db.get_folder(folder_id):
        raise HTTPException(404, "Folder not found.")
    db.delete_folder(folder_id)  # papers inside fall back to Uncategorized
    return {"ok": True}


# --------------------------------------------------------------- helpers

def _is_descendant(folder_id, candidate):
    """True if `candidate` lies in the subtree rooted at `folder_id` (used to
    reject moves that would create a cycle)."""
    children = {}
    for f in db.list_folders():
        children.setdefault(f["parent_id"], []).append(f["id"])
    stack = list(children.get(folder_id, []))
    while stack:
        n = stack.pop()
        if n == candidate:
            return True
        stack.extend(children.get(n, []))
    return False


def _require_ai():
    if not ai.has_api_key():
        raise HTTPException(
            400,
            "AI features are disabled because GEMINI_API_KEY is not set. "
            "Add it to your .env file and restart.",
        )


# ------------------------------------------------------------ static files

# Mount the frontend last so /api/* routes take priority.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
