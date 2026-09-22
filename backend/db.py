"""SQLite query layer — a derived cache over the sidecar files.

This database is *not* the source of truth. The durable state lives in plain
per-entity files under storage/ (see store.py); this file is rebuilt from them
on startup and can be deleted at any time without losing anything.

That is why it lives in cache/ rather than storage/: storage/ is the folder you
sync between machines, and a live SQLite database is the one thing that must
never be synced. Keeping it outside means there is no setting to get wrong.

Every function that mutates state flushes the affected entity back to its
sidecar, so the files and the cache cannot drift apart.
"""

import contextlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

# storage/ sits next to the project root (one level up from backend/)
BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
CACHE_DIR = BASE_DIR / "cache"
DB_PATH = CACHE_DIR / "papers.db"
LEGACY_DB_PATH = STORAGE_DIR / "papers.db"

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Move a pre-existing database out of the synced folder, once.
if LEGACY_DB_PATH.exists() and not DB_PATH.exists():
    os.replace(LEGACY_DB_PATH, DB_PATH)
    for suffix in ("-wal", "-shm"):
        side = LEGACY_DB_PATH.with_name(LEGACY_DB_PATH.name + suffix)
        if side.exists():
            os.replace(side, DB_PATH.with_name(DB_PATH.name + suffix))


# --------------------------------------------------------- sidecar flushing

# While importing, the files are the source and rewriting them would be both
# wasteful and circular, so flushes are suspended.
_suspend_flush = False


@contextlib.contextmanager
def suspended_flush():
    global _suspend_flush
    previous = _suspend_flush
    _suspend_flush = True
    try:
        yield
    finally:
        _suspend_flush = previous


def _flush_paper(paper_id):
    if _suspend_flush or paper_id is None:
        return
    import store  # deferred: store imports db

    store.write_paper(paper_id)


def _flush_folder(folder_id):
    if _suspend_flush or folder_id is None:
        return
    import store

    store.write_folder(folder_id)


def _flush_library_chat():
    if _suspend_flush:
        return
    import store

    store.write_library_chat()


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def now() -> float:
    return time.time()


def init_db() -> None:
    conn = get_conn()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS papers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT NOT NULL,
                filename     TEXT NOT NULL,
                stored_name  TEXT NOT NULL,
                num_pages    INTEGER NOT NULL DEFAULT 0,
                full_text    TEXT NOT NULL DEFAULT '',
                uploaded_at  REAL NOT NULL
            );

            -- User-created folders for organizing papers. A paper's folder is
            -- tracked by papers.folder_id (added via migration below); NULL means
            -- "Uncategorized". We clear folder_id in delete_folder() rather than
            -- via an FK constraint, because SQLite can't ADD COLUMN with an FK.
            CREATE TABLE IF NOT EXISTS folders (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                created_at   REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id     INTEGER NOT NULL,
                chunk_index  INTEGER NOT NULL,
                page         INTEGER NOT NULL,
                text         TEXT NOT NULL,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS highlights (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id     INTEGER NOT NULL,
                page         INTEGER NOT NULL,
                text         TEXT NOT NULL,
                rects_json   TEXT NOT NULL DEFAULT '[]',
                color        TEXT NOT NULL DEFAULT '#ffd54a',
                note         TEXT NOT NULL DEFAULT '',
                created_at   REAL NOT NULL,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );

            -- Chat history. scope='doc' rows belong to one paper's side chat;
            -- scope='library' rows belong to the cross-corpus chatbot.
            CREATE TABLE IF NOT EXISTS messages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                scope        TEXT NOT NULL,
                paper_id     INTEGER,
                role         TEXT NOT NULL,
                content      TEXT NOT NULL,
                created_at   REAL NOT NULL,
                FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);
            CREATE INDEX IF NOT EXISTS idx_highlights_paper ON highlights(paper_id);
            CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope, paper_id);
            """
        )
        # Migration: add papers.folder_id to databases created before folders
        # existed. (SQLite ADD COLUMN can't carry an FK, so it's a plain INTEGER.)
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(papers)").fetchall()]
        if "folder_id" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN folder_id INTEGER")
        # Migration: folders.parent_id enables nesting (NULL = top level).
        fcols = [r["name"] for r in conn.execute("PRAGMA table_info(folders)").fetchall()]
        if "parent_id" not in fcols:
            conn.execute("ALTER TABLE folders ADD COLUMN parent_id INTEGER")

        # Migration: uid columns. A uid is the stable cross-machine identity of
        # a row; the integer ids are per-machine surrogates (see store.py).
        # sidecar_hash records what this machine last read or wrote for a paper,
        # so an unchanged sidecar can be skipped on import.
        if "uid" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN uid TEXT")
        if "sidecar_hash" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN sidecar_hash TEXT")
        if "uid" not in fcols:
            conn.execute("ALTER TABLE folders ADD COLUMN uid TEXT")
        hcols = [r["name"] for r in conn.execute("PRAGMA table_info(highlights)").fetchall()]
        if "uid" not in hcols:
            conn.execute("ALTER TABLE highlights ADD COLUMN uid TEXT")
        # Migration: bookmarked papers (the Bookmarks screen). Stored in the
        # sidecar too, so a bookmark set on one machine follows you to the other.
        if "bookmarked" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0")
        # Migration: arXiv discovery. arxiv_id (base id, no version) links a
        # paper to arXiv so search/recommendations can say "In library";
        # last_viewed is set whenever the paper is opened in the viewer and
        # feeds the recommendation profile. Both are mirrored in the sidecar.
        if "arxiv_id" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN arxiv_id TEXT")
        if "last_viewed" not in cols:
            conn.execute("ALTER TABLE papers ADD COLUMN last_viewed REAL")

        # Migration: chat threads. uid is a message's stable identity (mirrored
        # in sidecars); parent_uid links a thread reply to the assistant message
        # it branches from (NULL = main chat); quote is the part of that
        # message the user replied to, if they selected one.
        mcols = [r["name"] for r in conn.execute("PRAGMA table_info(messages)").fetchall()]
        for col in ("uid", "parent_uid", "quote"):
            if col not in mcols:
                conn.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT")
        conn.execute("UPDATE messages SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_uid)")

        # Disk caches for arXiv discovery (API responses, generated queries,
        # recommendation results, embeddings). Pure cache: safe to delete.
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS kv_cache (
                key          TEXT PRIMARY KEY,
                value        TEXT NOT NULL,
                created_at   REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS embeddings (
                key          TEXT PRIMARY KEY,
                vec          BLOB NOT NULL,
                created_at   REAL NOT NULL
            );
            """
        )
        conn.commit()

        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_uid ON papers(uid)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_uid ON folders(uid)")
        conn.commit()
    finally:
        conn.close()


def backfill_uids() -> None:
    """Give uids to rows created before they existed.

    A paper's stored_name is already "<uuid>.pdf", so its uid is that uuid —
    which keeps the PDF filename and the sidecar names in agreement.
    """
    conn = get_conn()
    try:
        for row in conn.execute("SELECT id, stored_name FROM papers WHERE uid IS NULL").fetchall():
            stem = Path(row["stored_name"]).stem or uuid.uuid4().hex
            conn.execute("UPDATE papers SET uid = ? WHERE id = ?", (stem, row["id"]))
        for row in conn.execute("SELECT id FROM folders WHERE uid IS NULL").fetchall():
            conn.execute(
                "UPDATE folders SET uid = ? WHERE id = ?", (uuid.uuid4().hex, row["id"])
            )
        for row in conn.execute("SELECT id FROM highlights WHERE uid IS NULL").fetchall():
            conn.execute(
                "UPDATE highlights SET uid = ? WHERE id = ?", (uuid.uuid4().hex, row["id"])
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------- papers

def insert_paper(title, filename, stored_name, num_pages, full_text, uid, arxiv_id=None):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO papers (uid, title, filename, stored_name, num_pages, full_text,"
            " uploaded_at, arxiv_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, title, filename, stored_name, num_pages, full_text, now(), arxiv_id),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_chunks(paper_id, chunks):
    """chunks: list of (chunk_index, page, text)."""
    conn = get_conn()
    try:
        conn.executemany(
            "INSERT INTO chunks (paper_id, chunk_index, page, text) VALUES (?, ?, ?, ?)",
            [(paper_id, ci, pg, txt) for (ci, pg, txt) in chunks],
        )
        conn.commit()
    finally:
        conn.close()


def replace_chunks(paper_id, chunks):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM chunks WHERE paper_id = ?", (paper_id,))
        conn.executemany(
            "INSERT INTO chunks (paper_id, chunk_index, page, text) VALUES (?, ?, ?, ?)",
            [(paper_id, ci, pg, txt) for (ci, pg, txt) in chunks],
        )
        conn.commit()
    finally:
        conn.close()


def list_papers():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, title, filename, num_pages, uploaded_at, folder_id, bookmarked,"
            " arxiv_id, last_viewed FROM papers ORDER BY uploaded_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def rename_paper(paper_id, title):
    conn = get_conn()
    try:
        conn.execute("UPDATE papers SET title = ? WHERE id = ?", (title, paper_id))
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


def set_paper_folder(paper_id, folder_id):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE papers SET folder_id = ? WHERE id = ?", (folder_id, paper_id)
        )
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


def set_paper_bookmarked(paper_id, value):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE papers SET bookmarked = ? WHERE id = ?", (1 if value else 0, paper_id)
        )
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


def set_last_viewed(paper_id, ts=None):
    """Record that the paper was just opened in the viewer."""
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE papers SET last_viewed = ? WHERE id = ?", (ts or now(), paper_id)
        )
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


def set_paper_arxiv_id(paper_id, arxiv_id):
    conn = get_conn()
    try:
        conn.execute("UPDATE papers SET arxiv_id = ? WHERE id = ?", (arxiv_id, paper_id))
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


def set_sidecar_hash(paper_id, digest):
    """Record the hash of the sidecar as it now stands on disk, so the next
    import can skip this paper if nothing has changed."""
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE papers SET sidecar_hash = ? WHERE id = ?", (digest, paper_id)
        )
        conn.commit()
    finally:
        conn.close()


def paper_uid_hashes():
    """uid -> (id, sidecar_hash) for every paper in the cache."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, uid, sidecar_hash FROM papers WHERE uid IS NOT NULL"
        ).fetchall()
        return {r["uid"]: (r["id"], r["sidecar_hash"]) for r in rows}
    finally:
        conn.close()


def _id_is_free(conn, table, wanted_id):
    if wanted_id is None:
        return False
    row = conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (wanted_id,)).fetchone()
    return row is None


def upsert_paper_from_sidecar(data, folder_id, digest):
    """Create or update a paper from its sidecar. Returns (paper_id, is_new).

    The sidecar's integer id is only a hint: it is honoured when that id is
    still free on this machine (so ids stay stable in the normal single-machine
    case) and quietly reassigned when two machines happened to pick the same
    number for different papers.
    """
    uid = data["uid"]
    conn = get_conn()
    try:
        row = conn.execute("SELECT id FROM papers WHERE uid = ?", (uid,)).fetchone()
        is_new = row is None
        if is_new:
            wanted = data.get("id")
            if _id_is_free(conn, "papers", wanted):
                cur = conn.execute(
                    "INSERT INTO papers (id, uid, title, filename, stored_name, num_pages,"
                    " full_text, uploaded_at, folder_id, bookmarked, sidecar_hash,"
                    " arxiv_id, last_viewed)"
                    " VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)",
                    (
                        wanted, uid, data.get("title") or "Untitled",
                        data.get("filename") or f"{uid}.pdf", f"{uid}.pdf",
                        data.get("num_pages") or 0, data.get("uploaded_at") or now(),
                        folder_id, 1 if data.get("bookmarked") else 0, digest,
                        data.get("arxiv_id"), data.get("last_viewed"),
                    ),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO papers (uid, title, filename, stored_name, num_pages,"
                    " full_text, uploaded_at, folder_id, bookmarked, sidecar_hash,"
                    " arxiv_id, last_viewed)"
                    " VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)",
                    (
                        uid, data.get("title") or "Untitled",
                        data.get("filename") or f"{uid}.pdf", f"{uid}.pdf",
                        data.get("num_pages") or 0, data.get("uploaded_at") or now(),
                        folder_id, 1 if data.get("bookmarked") else 0, digest,
                        data.get("arxiv_id"), data.get("last_viewed"),
                    ),
                )
            paper_id = cur.lastrowid
        else:
            paper_id = row["id"]
            conn.execute(
                "UPDATE papers SET title = ?, filename = ?, num_pages = ?,"
                " uploaded_at = ?, folder_id = ?, bookmarked = ?, sidecar_hash = ?,"
                " arxiv_id = ?, last_viewed = ? WHERE id = ?",
                (
                    data.get("title") or "Untitled",
                    data.get("filename") or f"{uid}.pdf",
                    data.get("num_pages") or 0,
                    data.get("uploaded_at") or now(),
                    folder_id, 1 if data.get("bookmarked") else 0, digest,
                    data.get("arxiv_id"), data.get("last_viewed"), paper_id,
                ),
            )

        # Highlights and chat are replaced wholesale — the sidecar is the truth.
        conn.execute("DELETE FROM highlights WHERE paper_id = ?", (paper_id,))
        for h in data.get("highlights") or []:
            conn.execute(
                "INSERT INTO highlights (uid, paper_id, page, text, rects_json, color, note, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    h.get("uid") or uuid.uuid4().hex, paper_id, h.get("page") or 1,
                    h.get("text") or "", json.dumps(h.get("rects") or []),
                    h.get("color") or "#ffd54a", h.get("note") or "",
                    h.get("created_at") or now(),
                ),
            )
        conn.execute(
            "DELETE FROM messages WHERE scope = 'doc' AND paper_id = ?", (paper_id,)
        )
        for m in data.get("chat") or []:
            _insert_message(conn, "doc", paper_id, m)
        conn.commit()
        return paper_id, is_new
    finally:
        conn.close()


def replace_library_chat(messages):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM messages WHERE scope = 'library'")
        for m in messages:
            _insert_message(conn, "library", None, m)
        conn.commit()
    finally:
        conn.close()


# ----------------------------------------------------------------- folders

def list_folders():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, parent_id, created_at FROM folders ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def folder_uids():
    conn = get_conn()
    try:
        rows = conn.execute("SELECT id, uid FROM folders WHERE uid IS NOT NULL").fetchall()
        return {r["id"]: r["uid"] for r in rows}
    finally:
        conn.close()


def create_folder(name, parent_id=None, uid=None):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO folders (uid, name, parent_id, created_at) VALUES (?, ?, ?, ?)",
            (uid or uuid.uuid4().hex, name, parent_id, now()),
        )
        conn.commit()
        folder_id = cur.lastrowid
    finally:
        conn.close()
    _flush_folder(folder_id)
    return folder_id


def upsert_folder_from_sidecar(data):
    """Create or update a folder from its sidecar, returning its local id.
    Parents are wired up in a second pass by the caller."""
    uid = data["uid"]
    conn = get_conn()
    try:
        row = conn.execute("SELECT id FROM folders WHERE uid = ?", (uid,)).fetchone()
        if row:
            conn.execute(
                "UPDATE folders SET name = ?, created_at = ? WHERE id = ?",
                (data.get("name") or "Folder", data.get("created_at") or now(), row["id"]),
            )
            conn.commit()
            return row["id"]
        wanted = data.get("id")
        if _id_is_free(conn, "folders", wanted):
            cur = conn.execute(
                "INSERT INTO folders (id, uid, name, parent_id, created_at) VALUES (?, ?, ?, NULL, ?)",
                (wanted, uid, data.get("name") or "Folder", data.get("created_at") or now()),
            )
        else:
            cur = conn.execute(
                "INSERT INTO folders (uid, name, parent_id, created_at) VALUES (?, ?, NULL, ?)",
                (uid, data.get("name") or "Folder", data.get("created_at") or now()),
            )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def rename_folder(folder_id, name):
    conn = get_conn()
    try:
        conn.execute("UPDATE folders SET name = ? WHERE id = ?", (name, folder_id))
        conn.commit()
    finally:
        conn.close()
    _flush_folder(folder_id)


def set_folder_parent(folder_id, parent_id):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE folders SET parent_id = ? WHERE id = ?", (parent_id, folder_id)
        )
        conn.commit()
    finally:
        conn.close()
    _flush_folder(folder_id)


def get_folder(folder_id):
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, uid, name, parent_id, created_at FROM folders WHERE id = ?",
            (folder_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_folder(folder_id):
    """Delete a folder and promote its direct contents up to its parent: child
    folders reparent to the grandparent, and papers move to the parent folder
    (which is NULL/Uncategorized for a top-level folder)."""
    uid = (get_folder(folder_id) or {}).get("uid")
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT parent_id FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        parent = row["parent_id"] if row else None
        # Note which rows move, so their sidecars can be rewritten afterwards.
        moved_papers = [
            r["id"] for r in conn.execute(
                "SELECT id FROM papers WHERE folder_id = ?", (folder_id,)
            ).fetchall()
        ]
        moved_folders = [
            r["id"] for r in conn.execute(
                "SELECT id FROM folders WHERE parent_id = ?", (folder_id,)
            ).fetchall()
        ]
        conn.execute(
            "UPDATE papers SET folder_id = ? WHERE folder_id = ?", (parent, folder_id)
        )
        conn.execute(
            "UPDATE folders SET parent_id = ? WHERE parent_id = ?", (parent, folder_id)
        )
        conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        conn.commit()
    finally:
        conn.close()

    for pid in moved_papers:
        _flush_paper(pid)
    for fid in moved_folders:
        _flush_folder(fid)
    if uid and not _suspend_flush:
        import store

        store.delete_folder_file(uid)


def delete_folder_row(folder_id):
    """Drop a folder from the cache only — used during import, when another
    machine deleted it. Touches no files."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        conn.commit()
    finally:
        conn.close()


def get_paper(paper_id):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_paper(paper_id):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
        conn.commit()
    finally:
        conn.close()


def all_chunks():
    """Every chunk across the whole corpus, with its paper's title."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT c.id, c.paper_id, c.page, c.text, p.title "
            "FROM chunks c JOIN papers p ON p.id = c.paper_id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def chunks_for_paper(paper_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, paper_id, page, text FROM chunks WHERE paper_id = ? ORDER BY chunk_index",
            (paper_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ------------------------------------------------------------ highlights

def add_highlight(paper_id, page, text, rects_json, color, note):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO highlights (uid, paper_id, page, text, rects_json, color, note, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, paper_id, page, text, rects_json, color, note, now()),
        )
        conn.commit()
        highlight_id = cur.lastrowid
    finally:
        conn.close()
    _flush_paper(paper_id)
    return highlight_id


def list_highlights(paper_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM highlights WHERE paper_id = ? ORDER BY page, created_at",
            (paper_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_highlight(highlight_id):
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT paper_id FROM highlights WHERE id = ?", (highlight_id,)
        ).fetchone()
        paper_id = row["paper_id"] if row else None
        conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        conn.commit()
    finally:
        conn.close()
    _flush_paper(paper_id)


# -------------------------------------------------------------- messages

def _insert_message(conn, scope, paper_id, m):
    """Insert one message dict as stored in a sidecar."""
    conn.execute(
        "INSERT INTO messages (scope, paper_id, role, content, created_at, uid, parent_uid, quote)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            scope, paper_id, m.get("role") or "user", m.get("content") or "",
            m.get("created_at") or now(), m.get("uid") or uuid.uuid4().hex,
            m.get("parent_uid"), m.get("quote"),
        ),
    )


def add_message(scope, paper_id, role, content, parent_uid=None, quote=None):
    """Append a message; returns its uid. parent_uid puts it in the thread
    hanging off that assistant message instead of the main chat."""
    uid = uuid.uuid4().hex
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO messages (scope, paper_id, role, content, created_at, uid, parent_uid, quote)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (scope, paper_id, role, content, now(), uid, parent_uid, quote),
        )
        conn.commit()
    finally:
        conn.close()
    if scope == "doc":
        _flush_paper(paper_id)
    else:
        _flush_library_chat()
    return uid


def _message_dict(r):
    d = {"uid": r["uid"], "role": r["role"], "content": r["content"], "created_at": r["created_at"]}
    # Only thread replies carry these, so ordinary sidecar entries stay small.
    if r["parent_uid"]:
        d["parent_uid"] = r["parent_uid"]
    if r["quote"]:
        d["quote"] = r["quote"]
    return d


def _scope_where(scope, paper_id):
    if scope == "doc":
        return "scope = 'doc' AND paper_id = ?", (paper_id,)
    return "scope = 'library'", ()


def get_messages(scope, paper_id=None):
    """Every message in a chat, main chat and threads alike (for sidecars)."""
    where, args = _scope_where(scope, paper_id)
    conn = get_conn()
    try:
        rows = conn.execute(
            f"SELECT * FROM messages WHERE {where} ORDER BY id", args
        ).fetchall()
        return [_message_dict(r) for r in rows]
    finally:
        conn.close()


def get_main_messages(scope, paper_id=None):
    """The main chat (no thread replies), each with its thread's reply_count."""
    where, args = _scope_where(scope, paper_id)
    conn = get_conn()
    try:
        rows = conn.execute(
            f"SELECT m.*, (SELECT COUNT(*) FROM messages t WHERE t.parent_uid = m.uid) AS reply_count"
            f" FROM messages m WHERE {where.replace('scope', 'm.scope').replace('paper_id', 'm.paper_id')}"
            " AND m.parent_uid IS NULL ORDER BY m.id",
            args,
        ).fetchall()
        out = []
        for r in rows:
            d = _message_dict(r)
            d["reply_count"] = r["reply_count"]
            out.append(d)
        return out
    finally:
        conn.close()


def get_thread(scope, paper_id, parent_uid):
    """(parent, prompt, replies): the assistant message a thread hangs off,
    the user message that prompted it (or None), and the thread's messages.
    Returns None if the parent isn't in this chat."""
    where, args = _scope_where(scope, paper_id)
    conn = get_conn()
    try:
        parent = conn.execute(
            f"SELECT * FROM messages WHERE {where} AND uid = ? AND parent_uid IS NULL",
            (*args, parent_uid),
        ).fetchone()
        if not parent:
            return None
        prompt = conn.execute(
            f"SELECT * FROM messages WHERE {where} AND parent_uid IS NULL AND id < ?"
            " ORDER BY id DESC LIMIT 1",
            (*args, parent["id"]),
        ).fetchone()
        replies = conn.execute(
            f"SELECT * FROM messages WHERE {where} AND parent_uid = ? ORDER BY id",
            (*args, parent_uid),
        ).fetchall()
        return (
            _message_dict(parent),
            _message_dict(prompt) if prompt and prompt["role"] == "user" else None,
            [_message_dict(r) for r in replies],
        )
    finally:
        conn.close()


# ------------------------------------------------------ discovery caches
# Both tables live in this cache DB (never synced) and can be wiped freely.

def cache_get(key, max_age=None):
    """Return the cached JSON value for key, or None if absent/expired."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT value, created_at FROM kv_cache WHERE key = ?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    if max_age is not None and now() - row["created_at"] > max_age:
        return None
    try:
        return json.loads(row["value"])
    except Exception:
        return None


def cache_put(key, value):
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO kv_cache (key, value, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), now()),
        )
        conn.commit()
    finally:
        conn.close()


def embeddings_get(keys):
    """key -> raw vector bytes for the keys that are cached."""
    out = {}
    if not keys:
        return out
    conn = get_conn()
    try:
        keys = list(keys)
        for i in range(0, len(keys), 500):
            batch = keys[i:i + 500]
            marks = ",".join("?" * len(batch))
            for r in conn.execute(
                f"SELECT key, vec FROM embeddings WHERE key IN ({marks})", batch
            ).fetchall():
                out[r["key"]] = r["vec"]
        return out
    finally:
        conn.close()


def embeddings_put(items):
    """items: dict key -> vector bytes."""
    if not items:
        return
    conn = get_conn()
    try:
        ts = now()
        conn.executemany(
            "INSERT OR REPLACE INTO embeddings (key, vec, created_at) VALUES (?, ?, ?)",
            [(k, v, ts) for k, v in items.items()],
        )
        conn.commit()
    finally:
        conn.close()
