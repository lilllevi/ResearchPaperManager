"""Sidecar file store — the durable, sync-friendly source of truth.

SQLite is a single binary file that changes on nearly every action, which makes
it hopeless to sync between machines: a file-sync service (OneDrive, Dropbox)
can only replace it wholesale, so two machines that both made changes produce a
conflict whose only resolutions destroy one side's work.

So the database is demoted to a *derived cache*. The real state lives in plain
files that sync safely:

    storage/uploads/<uid>.pdf     the PDF            immutable, written once
    storage/papers/<uid>.txt      extracted text     immutable, written once
    storage/papers/<uid>.json     metadata, highlights, chat   small, mergeable
    storage/folders/<uid>.json    one folder         tiny, mergeable
    storage/library-chat.json     cross-corpus chat  append-mostly
    cache/papers.db               derived — NOT in storage/, never synced

Everything that changes is small, per-entity, and text. Two machines editing
different papers never touch the same file, so there is nothing to conflict
over. Editing the *same* paper on two machines gives you a readable JSON
conflict instead of a corrupt database.

`uid` is a uuid4 hex string and is the stable cross-machine identity. The
integer ids the API speaks are local surrogates: they are reused when free, but
a machine is free to assign a different one, so nothing durable refers to them.

The DB can be deleted at any time and is rebuilt from these files on startup.
"""

import hashlib
import json
import os
import uuid
from pathlib import Path

import db
import pdf_utils

STORAGE_DIR = db.STORAGE_DIR
PAPERS_DIR = STORAGE_DIR / "papers"
FOLDERS_DIR = STORAGE_DIR / "folders"
LIBRARY_CHAT_PATH = STORAGE_DIR / "library-chat.json"

# Page boundaries inside the .txt sidecar. Form feed is the conventional page
# break and is stripped from extracted text so it can't appear in the content.
PAGE_SEP = "\f"


def ensure_dirs():
    PAPERS_DIR.mkdir(parents=True, exist_ok=True)
    FOLDERS_DIR.mkdir(parents=True, exist_ok=True)


def new_uid():
    return uuid.uuid4().hex


# ------------------------------------------------------------ atomic writes

def _write_atomic(path: Path, data: bytes) -> str:
    """Write bytes to `path` atomically and return their hash.

    A sync client may read this file at any moment, so we never leave a
    half-written file at the real path: write a temp file alongside, then
    os.replace() it, which is atomic on both Windows and POSIX.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return hashlib.sha1(data).hexdigest()


def _dump(obj) -> bytes:
    # sort_keys keeps the byte output stable so unchanged data hashes the same
    # and produces no spurious diff/sync churn.
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")


def _read_json(path: Path):
    """Return (data, hash) or (None, None) if unreadable."""
    try:
        raw = path.read_bytes()
        return json.loads(raw.decode("utf-8")), hashlib.sha1(raw).hexdigest()
    except Exception:
        return None, None


# ----------------------------------------------------------- text sidecars

def write_text(uid, pages):
    """Store extracted page text. Immutable: written once, at upload."""
    cleaned = [p.replace(PAGE_SEP, " ") for p in pages]
    _write_atomic(PAPERS_DIR / f"{uid}.txt", PAGE_SEP.join(cleaned).encode("utf-8"))


def read_pages(uid):
    """Return the page list for a paper, re-extracting from the PDF if the text
    sidecar is missing (e.g. it predates this layout)."""
    path = PAPERS_DIR / f"{uid}.txt"
    if path.exists():
        try:
            return path.read_text(encoding="utf-8").split(PAGE_SEP)
        except Exception:
            pass
    pdf = db.UPLOADS_DIR / f"{uid}.pdf"
    if pdf.exists():
        try:
            pages, _ = pdf_utils.extract_pages(pdf)
            write_text(uid, pages)
            return pages
        except Exception:
            return []
    return []


# ---------------------------------------------------------- writing (DB -> files)

def write_paper(paper_id):
    """Flush one paper's mutable state to its JSON sidecar."""
    paper = db.get_paper(paper_id)
    if not paper or not paper.get("uid"):
        return
    uid = paper["uid"]

    folder_uid = None
    if paper.get("folder_id") is not None:
        folder = db.get_folder(paper["folder_id"])
        if folder:
            folder_uid = folder.get("uid")

    highlights = []
    for h in db.list_highlights(paper_id):
        highlights.append(
            {
                "uid": h["uid"] or new_uid(),
                "page": h["page"],
                "text": h["text"],
                "rects": json.loads(h["rects_json"] or "[]"),
                "color": h["color"],
                "note": h["note"],
                "created_at": h["created_at"],
            }
        )

    data = {
        "uid": uid,
        "id": paper["id"],  # a hint; reused only if that integer is free here
        "title": paper["title"],
        "filename": paper["filename"],
        "num_pages": paper["num_pages"],
        "uploaded_at": paper["uploaded_at"],
        "folder_uid": folder_uid,
        "highlights": highlights,
        "chat": db.get_messages("doc", paper_id),
    }
    digest = _write_atomic(PAPERS_DIR / f"{uid}.json", _dump(data))
    db.set_sidecar_hash(paper_id, digest)


def write_folder(folder_id):
    folder = db.get_folder(folder_id)
    if not folder or not folder.get("uid"):
        return
    parent_uid = None
    if folder.get("parent_id") is not None:
        parent = db.get_folder(folder["parent_id"])
        if parent:
            parent_uid = parent.get("uid")
    data = {
        "uid": folder["uid"],
        "id": folder["id"],
        "name": folder["name"],
        "parent_uid": parent_uid,
        "created_at": folder["created_at"],
    }
    _write_atomic(FOLDERS_DIR / f"{folder['uid']}.json", _dump(data))


def write_library_chat():
    _write_atomic(LIBRARY_CHAT_PATH, _dump({"chat": db.get_messages("library")}))


def delete_paper_files(uid, remove_pdf=True):
    """Remove a paper's sidecars — called only on a real user delete, never
    during import."""
    for path in (PAPERS_DIR / f"{uid}.json", PAPERS_DIR / f"{uid}.txt"):
        path.unlink(missing_ok=True)
    if remove_pdf:
        (db.UPLOADS_DIR / f"{uid}.pdf").unlink(missing_ok=True)


def delete_folder_file(uid):
    (FOLDERS_DIR / f"{uid}.json").unlink(missing_ok=True)


# ---------------------------------------------------------- reading (files -> DB)

def _load_sidecars(directory):
    """Read every valid sidecar in a directory as {uid: (data, hash)}.

    Files whose stem doesn't match the uid inside are skipped. That is exactly
    what a sync conflict copy looks like ("<uid>-DESKTOP-ABC.json"), so this
    quietly ignores them instead of importing a duplicate.
    """
    out = {}
    skipped = []
    if not directory.exists():
        return out, skipped
    for path in sorted(directory.glob("*.json")):
        data, digest = _read_json(path)
        if not isinstance(data, dict) or not data.get("uid"):
            skipped.append(path.name)
            continue
        if data["uid"] != path.stem:
            skipped.append(path.name)
            continue
        out[data["uid"]] = (data, digest)
    return out, skipped


def import_all():
    """Reconcile the database with the sidecar files on disk.

    The files win: anything they describe is created or updated, and DB rows
    with no sidecar are dropped (another machine deleted them). This only ever
    deletes *database rows* — never a PDF or a text sidecar — so a sidecar that
    reappears after a slow sync is simply re-imported, losing nothing.
    """
    ensure_dirs()
    folders, bad_folders = _load_sidecars(FOLDERS_DIR)
    papers, bad_papers = _load_sidecars(PAPERS_DIR)

    # --- folders. Insert every folder first, then wire up parents, so that a
    # parent appearing later in the iteration order still resolves.
    uid_to_fid = {}
    for uid, (data, _) in folders.items():
        uid_to_fid[uid] = db.upsert_folder_from_sidecar(data)
    for uid, (data, _) in folders.items():
        parent_uid = data.get("parent_uid")
        parent_id = uid_to_fid.get(parent_uid) if parent_uid else None
        db.set_folder_parent(uid_to_fid[uid], parent_id)

    for fid, uid in db.folder_uids().items():
        if uid not in folders:
            db.delete_folder_row(fid)

    # --- papers
    known = db.paper_uid_hashes()  # uid -> (id, sidecar_hash)
    imported = 0
    for uid, (data, digest) in papers.items():
        if uid in known and known[uid][1] == digest:
            continue  # unchanged since this machine last wrote or read it
        folder_uid = data.get("folder_uid")
        folder_id = uid_to_fid.get(folder_uid) if folder_uid else None
        paper_id, is_new = db.upsert_paper_from_sidecar(data, folder_id, digest)
        # Chunks derive from the immutable text sidecar, so they only need
        # building when the paper is new to this machine (or lost its chunks).
        if is_new or not db.chunks_for_paper(paper_id):
            pages = read_pages(uid)
            chunks = pdf_utils.chunk_pages(pages)
            if chunks:
                db.replace_chunks(paper_id, chunks)
        imported += 1

    # Guard against a not-yet-synced storage folder: if there are no paper
    # sidecars at all but the DB has papers, assume the files just haven't
    # arrived and leave the cache alone rather than wiping it.
    removed = 0
    if papers or not known:
        for uid, (pid, _) in known.items():
            if uid not in papers:
                db.delete_paper(pid)
                removed += 1

    # --- library chat
    data, _ = _read_json(LIBRARY_CHAT_PATH)
    if isinstance(data, dict):
        db.replace_library_chat(data.get("chat") or [])

    return {
        "papers": len(papers),
        "folders": len(folders),
        "imported": imported,
        "removed": removed,
        "skipped": bad_papers + bad_folders,
    }


# ------------------------------------------------------------------ export

def export_all():
    """Write the current database out to sidecar files.

    Used once, to migrate a database that predates this layout, and available
    as a repair if the files are ever lost but the DB survives.
    """
    ensure_dirs()
    db.backfill_uids()
    for folder in db.list_folders():
        write_folder(folder["id"])
    for paper in db.list_papers():
        row = db.get_paper(paper["id"])
        uid = row["uid"]
        if not (PAPERS_DIR / f"{uid}.txt").exists():
            # papers.full_text joined pages with "\n", which loses the page
            # boundaries chunking needs, so re-extract them from the PDF and
            # only fall back to the stored text if the file is gone.
            pages = None
            pdf = db.UPLOADS_DIR / f"{uid}.pdf"
            if pdf.exists():
                try:
                    pages, _n = pdf_utils.extract_pages(pdf)
                except Exception:
                    pages = None
            write_text(uid, pages if pages is not None else [row["full_text"] or ""])
        write_paper(paper["id"])
    write_library_chat()
    return {"papers": len(db.list_papers()), "folders": len(db.list_folders())}


def bootstrap():
    """Decide, at startup, whether to seed the files from the DB or the DB from
    the files."""
    ensure_dirs()
    has_files = any(PAPERS_DIR.glob("*.json")) or any(FOLDERS_DIR.glob("*.json"))
    has_rows = bool(db.list_papers() or db.list_folders())
    if not has_files and has_rows:
        return {"mode": "export", **export_all()}
    return {"mode": "import", **import_all()}
