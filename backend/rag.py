"""Keyword-based retrieval over the paper corpus using BM25.

BM25 is a well-proven ranking function for search. It is pure Python
(rank-bm25) with no native build step and needs no embedding API or extra
API key, which keeps setup painless on Windows. The searchable index is
derived entirely from the `chunks` table in SQLite, so it is durable: on
startup we rebuild it from disk, and we refresh it whenever papers change.
"""

import re
import threading

from rank_bm25 import BM25Okapi

import db

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text):
    return _TOKEN_RE.findall(text.lower())


class CorpusIndex:
    """In-memory BM25 index over every chunk, rebuilt from SQLite on demand."""

    def __init__(self):
        self._lock = threading.Lock()
        self._bm25 = None
        self._chunks = []  # parallel list of chunk dicts

    def rebuild(self):
        chunks = db.all_chunks()
        tokenized = [_tokenize(c["text"]) for c in chunks]
        with self._lock:
            self._chunks = chunks
            # BM25Okapi needs at least one non-empty document.
            self._bm25 = BM25Okapi(tokenized) if any(tokenized) else None

    def search(self, query, top_k=6, paper_id=None):
        """Return the top matching chunks, optionally restricted to one paper."""
        with self._lock:
            bm25 = self._bm25
            chunks = list(self._chunks)
        if bm25 is None or not chunks:
            return []

        tokens = _tokenize(query)
        if not tokens:
            return []

        scores = bm25.get_scores(tokens)
        scored = list(zip(scores, chunks))
        if paper_id is not None:
            scored = [(s, c) for (s, c) in scored if c["paper_id"] == paper_id]
        scored.sort(key=lambda x: x[0], reverse=True)

        # BM25 IDF can be zero or negative for terms that appear in every
        # document (common with a tiny corpus), so we can't filter on score > 0.
        # Instead keep the top-ranked chunks that actually share a query term.
        query_terms = set(tokens)
        results = []
        for score, chunk in scored:
            if len(results) >= top_k:
                break
            chunk_terms = set(_tokenize(chunk["text"]))
            if not (query_terms & chunk_terms):
                continue
            item = dict(chunk)
            item["score"] = float(score)
            results.append(item)
        return results


# Single shared index for the running server.
index = CorpusIndex()
