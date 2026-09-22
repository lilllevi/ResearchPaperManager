"""arXiv discovery: semantic search and recommendations.

There is no way to index all of arXiv locally, so both features work the same
way, using only the standard library:

  1. Candidate queries.  Gemini turns the user's request (search) or their
     recently read papers (recommendations) into a few boolean arXiv queries.
     Without a Gemini key we build plain keyword queries instead.
  2. Candidate pool.     Each query is sent to the public arXiv API
     (export.arxiv.org/api/query, Atom XML) sorted by relevance, plus one
     combined query sorted by submission date so brand-new papers get in.
  3. Rerank.             Titles+abstracts are embedded with Gemini embeddings
     and scored by cosine similarity to the query (or reading profile). The
     similarity is then multiplied by a recency factor — see recency_factor(),
     the one place recency weighting is tuned.

arXiv asks for at most one request every ~3 seconds, so every call to arxiv.org
goes through one throttled, serialized helper. API responses, generated
queries, recommendation results and embeddings are all cached in the SQLite
cache (cache/papers.db — never synced, safe to delete).
"""

import array
import hashlib
import math
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import ai
import db
import store

# ------------------------------------------------------------ tunables

# Recency weighting (the single place to tune it): final = relevance × factor,
# factor = FLOOR + (1 - FLOOR) × 0.5 ** (age_days / HALF_LIFE). A brand-new
# paper gets 1.0, a 9-month-old one ~0.58, 18 months ~0.36, very old ~FLOOR.
RECENCY_HALF_LIFE_DAYS = 270
RECENCY_FLOOR = 0.15

# Interest profile for recommendations: the N most recently uploaded/viewed
# papers, the i-th most recent weighted PROFILE_DECAY ** i.
PROFILE_SIZE = 8
PROFILE_DECAY = 0.75
# Typed-in interests (storage/interests.json) join the profile at this weight,
# i.e. as strongly as the most recently opened paper.
INTEREST_WEIGHT = 1.0

# arXiv API etiquette and caching.
ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_MIN_INTERVAL = 3.1          # seconds between requests to arxiv.org
ARXIV_CACHE_TTL = 12 * 3600       # raw API responses
QUERY_CACHE_TTL = 7 * 24 * 3600   # Gemini-generated query lists
RECS_CACHE_TTL = 6 * 3600         # computed recommendation lists
SEARCH_PER_QUERY = 30             # relevance-sorted results per query
RECENT_POOL = 40                  # submittedDate-sorted results (one request)

# Embedding requests: texts per batchEmbedContents call, the longest 429
# retry-delay we'll wait out once, and the abstract length we embed.
EMBED_BATCH = 40
EMBED_MAX_WAIT = 45
EMBED_ABSTRACT_CHARS = 1200
# Gemini's free tier embeds at most 100 texts per minute, so each search or
# recommendation run embeds at most this many *new* candidates, picked by a
# cheap keyword x arXiv-rank x recency prefilter. Already-cached candidates are
# always kept. Raise it if you're on a paid tier.
EMBED_NEW_MAX = 45
USER_AGENT = "ResearchPaperManager/1.0 (local desktop app; arXiv API client)"

_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV = "{http://arxiv.org/schemas/atom}"


class DiscoverError(Exception):
    """A user-facing failure. `unreachable` marks network-level failures,
    where trying further queries would only waste the user's time."""

    def __init__(self, message, unreachable=False):
        super().__init__(message)
        self.unreachable = unreachable


# ------------------------------------------------------------ arXiv HTTP

# arXiv's CDN rejects TLS handshakes that don't offer ALPN (it answers 406 to
# Python's default client), so advertise http/1.1 like any browser or curl.
_SSL = ssl.create_default_context()
_SSL.set_alpn_protocols(["http/1.1"])

_arxiv_lock = threading.Lock()
_arxiv_last = 0.0


def _arxiv_get(url, timeout=40):
    """GET a URL on arxiv.org, serialized and spaced ARXIV_MIN_INTERVAL apart.
    Retries twice on throttling/transient HTTP errors; fails fast when arXiv
    can't be reached at all (offline, DNS, timeout)."""
    global _arxiv_last
    last_err = None
    for attempt in range(3):
        with _arxiv_lock:
            wait = ARXIV_MIN_INTERVAL - (time.time() - _arxiv_last)
            if wait > 0:
                time.sleep(wait)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                if e.code not in (406, 429, 500, 502, 503, 504):
                    raise DiscoverError(f"arXiv returned an error ({last_err}).")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                raise DiscoverError(
                    f"Could not reach arXiv ({getattr(e, 'reason', e)}). "
                    "Check your internet connection and try again.",
                    unreachable=True,
                )
            finally:
                _arxiv_last = time.time()
        time.sleep(2 + 3 * attempt)
    raise DiscoverError(f"arXiv is busy or unavailable right now ({last_err}). Try again in a minute.")


def _collapse(s):
    return re.sub(r"\s+", " ", s or "").strip()


_ID_RE = re.compile(
    r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:\s*)?"
    r"(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?",
    re.IGNORECASE,
)


def normalize_arxiv_id(raw):
    """'arXiv:2201.00978v2', 'https://arxiv.org/abs/2201.00978' -> '2201.00978'."""
    m = _ID_RE.search((raw or "").strip())
    return m.group(1) if m else None


_STAMP_RE = re.compile(r"arXiv:\s*(\d{4}\.\d{4,5})")


def arxiv_id_in_text(first_page):
    """The id from the arXiv stamp in a PDF's page-1 margin
    ("arXiv:2201.00978v1 [cs.CV] ..."), or None."""
    m = _STAMP_RE.search((first_page or "")[:4000])
    return m.group(1) if m else None


def parse_atom(xml_bytes):
    """Parse an arXiv Atom feed into a list of paper dicts."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise DiscoverError(f"arXiv sent an unreadable response ({e}).")
    out = []
    for entry in root.findall(f"{_ATOM}entry"):
        raw_id = entry.findtext(f"{_ATOM}id") or ""
        if "/api/errors" in raw_id:  # malformed-query error entry
            continue
        aid = normalize_arxiv_id(raw_id)
        if not aid:
            continue
        pdf_url = None
        for link in entry.findall(f"{_ATOM}link"):
            if link.get("title") == "pdf" or link.get("type") == "application/pdf":
                pdf_url = link.get("href")
        prim = entry.find(f"{_ARXIV}primary_category")
        out.append(
            {
                "arxiv_id": aid,
                "title": _collapse(entry.findtext(f"{_ATOM}title")),
                "summary": _collapse(entry.findtext(f"{_ATOM}summary")),
                "authors": [
                    _collapse(a.findtext(f"{_ATOM}name"))
                    for a in entry.findall(f"{_ATOM}author")
                ],
                "published": entry.findtext(f"{_ATOM}published") or "",
                "updated": entry.findtext(f"{_ATOM}updated") or "",
                "primary_category": prim.get("term") if prim is not None else "",
                "abs_url": f"https://arxiv.org/abs/{aid}",
                "pdf_url": (pdf_url or f"https://arxiv.org/pdf/{aid}").replace("http://", "https://"),
            }
        )
    return out


def arxiv_query(search_query, sort="relevance", max_results=SEARCH_PER_QUERY):
    """Run one arXiv API query (cached)."""
    params = {
        "search_query": search_query,
        "start": 0,
        "max_results": max_results,
        "sortBy": sort,
        "sortOrder": "descending",
    }
    url = ARXIV_API + "?" + urllib.parse.urlencode(params)
    key = "arxiv:" + url
    cached = db.cache_get(key, ARXIV_CACHE_TTL)
    if cached is not None:
        return cached
    entries = parse_atom(_arxiv_get(url))
    db.cache_put(key, entries)
    return entries


def arxiv_lookup(arxiv_id):
    """Metadata for a single arXiv id, or None."""
    url = ARXIV_API + "?" + urllib.parse.urlencode({"id_list": arxiv_id, "max_results": 1})
    key = "arxiv:" + url
    cached = db.cache_get(key, ARXIV_CACHE_TTL)
    if cached is None:
        cached = parse_atom(_arxiv_get(url))
        db.cache_put(key, cached)
    return cached[0] if cached else None


def download_pdf(arxiv_id):
    """Fetch the PDF bytes for an arXiv paper."""
    data = _arxiv_get(f"https://arxiv.org/pdf/{arxiv_id}", timeout=120)
    if not data.startswith(b"%PDF"):
        raise DiscoverError("arXiv did not return a PDF for this paper (it may not have one yet).")
    return data


# ------------------------------------------------------------ ranking

def recency_factor(published_iso, now=None):
    """Multiplier in [RECENCY_FLOOR, 1] that decays exponentially with age."""
    try:
        pub = datetime.fromisoformat(published_iso.replace("Z", "+00:00"))
    except Exception:
        return RECENCY_FLOOR
    now = now or datetime.now(timezone.utc)
    age_days = max(0.0, (now - pub).total_seconds() / 86400)
    return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)


def _apply_scores(entries, sims):
    """Attach similarity/recency/score and sort. Similarities are min-max
    scaled within the pool first, so 'relevance' spans 0..1 and the recency
    factor has a consistent effect regardless of the embedding's raw range."""
    if not entries:
        return entries
    lo, hi = min(sims), max(sims)
    span = (hi - lo) or 1.0
    now = datetime.now(timezone.utc)
    for e, s in zip(entries, sims):
        rel = (s - lo) / span
        rec = recency_factor(e.get("published", ""), now)
        e["similarity"] = round(float(s), 4)
        e["relevance"] = round(rel, 4)
        e["recency"] = round(rec, 4)
        e["score"] = round(rel * rec, 4)
    entries.sort(key=lambda e: e["score"], reverse=True)
    return entries


_STOP = set(
    "a an the of for and or in on to with by from at as is are be via using use "
    "we our this that these those into over under about between towards toward "
    "new novel study paper approach method methods based analysis results "
    "i me my find papers recent work works looking want show "
    "abs all cat andnot you need its their can which also has have been such "
    "than more both each university department abstract institute email arxiv "
    "introduction however where when while here there them they".split()
)
_WORD = re.compile(r"[a-z0-9][a-z0-9\-]+")


def _terms(text, limit=8):
    seen, out = set(), []
    for w in _WORD.findall((text or "").lower()):
        if len(w) > 2 and w not in _STOP and w not in seen:
            seen.add(w)
            out.append(w)
    return out[:limit]


def _keyword_sims(entries, weighted_terms):
    """Fallback similarity without embeddings: weighted term overlap, titles
    counting more than abstracts. weighted_terms: {term: weight}."""
    total = sum(weighted_terms.values()) or 1.0
    sims = []
    for e in entries:
        title = e["title"].lower()
        abstract = e["summary"].lower()
        s = 0.0
        for t, w in weighted_terms.items():
            if t in title:
                s += w * 1.0
            elif t in abstract:
                s += w * 0.6
        sims.append(s / total)
    return sims


def _salient_terms(title, body, k=3):
    """Most characteristic words of a paper: frequent in its first page, with
    title words counting triple. Used for keyword-only recommendations."""
    body = (body or "").lower()
    cut = body.find("abstract")  # skip the author/affiliation block
    if 0 <= cut < len(body) // 2:
        body = body[cut:]
    counts = {}
    for w in _WORD.findall(body):
        if len(w) > 3 and w not in _STOP and not w[0].isdigit():
            counts[w] = counts.get(w, 0) + 1
    for w in _terms(title, 20):
        if not w[0].isdigit():
            counts[w] = counts.get(w, 0) + 3
    return [w for w, _ in sorted(counts.items(), key=lambda t: t[1], reverse=True)[:k]]


def _keyword_queries(text):
    terms = _terms(text, 6)
    if not terms:
        return []
    qs = []
    words = text.strip().split()
    if 2 <= len(words) <= 5:
        qs.append('all:"' + " ".join(_WORD.findall(text.lower())) + '"')
    qs.append(" AND ".join(f"all:{t}" for t in terms[:4]))
    if len(terms) > 1:
        qs.append(" OR ".join(f"ti:{t}" for t in terms[:4]))
    return qs


# ------------------------------------------------------------ embeddings

def _emb_key(text, task):
    raw = f"{ai.EMBED_MODEL}|{ai.EMBED_DIM}|{task}|{text}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _normalize(vec):
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def embed(texts, task):
    """Unit-length embeddings for texts, served from the disk cache when
    possible; only unseen texts go to Gemini."""
    keys = [_emb_key(t, task) for t in texts]
    cached = db.embeddings_get(set(keys))
    missing = [i for i, k in enumerate(keys) if k not in cached]
    # Modest batches, each cached as soon as it lands: the free tier allows
    # 100 embedded texts per minute, and a 429 halfway through shouldn't waste
    # the batches that already succeeded.
    for start in range(0, len(missing), EMBED_BATCH):
        idx = missing[start:start + EMBED_BATCH]
        try:
            vecs = ai.embed_texts([texts[i] for i in idx], task)
        except ai.GeminiError as ex:
            if ex.code != 429 or (ex.retry_after or 0) > EMBED_MAX_WAIT:
                raise
            time.sleep((ex.retry_after or 10) + 1)
            vecs = ai.embed_texts([texts[i] for i in idx], task)
        new = {keys[i]: array.array("f", _normalize(v)).tobytes() for i, v in zip(idx, vecs)}
        db.embeddings_put(new)
        cached.update(new)
    out = []
    for k in keys:
        a = array.array("f")
        a.frombytes(cached[k])
        out.append(a)
    return out


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _doc_text(e):
    return f"{e['title']}\n\n{e['summary'][:EMBED_ABSTRACT_CHARS]}"


# ------------------------------------------------------------ library

def _norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def library_index():
    """arxiv_id -> paper_id and normalized title -> paper_id for the library.

    Papers uploaded by hand have no arxiv_id, so we also look for the arXiv
    stamp arXiv puts in the margin of page 1 ("arXiv:2201.00978v1 [cs.CV]").
    """
    by_id, by_title = {}, {}
    for p in db.list_papers():
        aid = p.get("arxiv_id")
        if not aid:
            row = db.get_paper(p["id"]) or {}
            pages = store.read_pages(row.get("uid")) if row.get("uid") else []
            aid = arxiv_id_in_text(pages[0] if pages else "")
        if aid:
            by_id[aid] = p["id"]
        nt = _norm_title(p["title"])
        if nt:
            by_title[nt] = p["id"]
    return by_id, by_title


def find_in_library(entry, index=None):
    by_id, by_title = index or library_index()
    return by_id.get(entry["arxiv_id"]) or by_title.get(_norm_title(entry["title"]))


def annotate(entries, index=None):
    """Mark which entries are already in the library (by id or title)."""
    index = index or library_index()
    for e in entries:
        pid = find_in_library(e, index)
        e["in_library"] = pid is not None
        e["paper_id"] = pid
    return entries


# ------------------------------------------------------------ pool building

def _gather(queries, recent_queries=None, per_query=SEARCH_PER_QUERY):
    """Run queries (relevance-sorted) plus one combined date-sorted query over
    recent_queries (default: all of them), so the newest papers make the pool.
    Returns (entries deduped by id, list of error strings)."""
    pool, errors = {}, []
    jobs = [(q, "relevance", per_query) for q in queries]
    recent = recent_queries if recent_queries is not None else queries
    if recent and RECENT_POOL:
        combined = recent[0] if len(recent) == 1 else " OR ".join(f"({q})" for q in recent)
        jobs.append((combined, "submittedDate", RECENT_POOL))
    for q, sort, n in jobs:
        try:
            for pos, e in enumerate(arxiv_query(q, sort, n)):
                kept = pool.setdefault(e["arxiv_id"], e)
                kept["_rank"] = min(kept.get("_rank", pos), pos)
        except DiscoverError as ex:
            errors.append(str(ex))
            if ex.unreachable:
                break
    return list(pool.values()), errors


def _cached_queries(key, make, refresh=False):
    hit = None if refresh else db.cache_get(key, QUERY_CACHE_TTL)
    if hit:
        return hit
    qs = make()
    if qs:
        db.cache_put(key, qs)
    return qs


# ------------------------------------------------------------ search

def search(query, limit=25):
    query = _collapse(query)
    if not query:
        raise DiscoverError("Type something to search for.")
    notices = []
    semantic = ai.has_api_key()

    queries, recent = [], None
    if semantic:
        try:
            queries = _cached_queries(
                "qgen:search:" + query.lower(), lambda: ai.arxiv_queries_for_search(query)
            )
        except Exception as ex:
            notices.append(f"Gemini could not write queries ({_short(ex)}); used keywords.")
    if not queries:
        queries = _keyword_queries(query)
        # The last keyword query is a broad title-OR; sorted by date alone it
        # would flood the pool with unrelated new papers.
        recent = queries[:-1] or queries
    if not queries:
        raise DiscoverError("Couldn't find any searchable words in that query.")

    pool, errors = _gather(queries, recent)
    if not pool:
        if errors:
            raise DiscoverError(errors[0])
        return _result([], queries, "semantic" if semantic else "keyword", notices + ["No matches on arXiv."])
    if errors:
        notices.append(f"{len(errors)} arXiv request(s) failed; results may be incomplete.")

    weighted = {t: 1.0 for t in _terms(query, 12)}
    for q in queries:  # Gemini's queries often name the field's own terms
        for t in _terms(q, 12):
            weighted.setdefault(t, 0.5)

    mode = "keyword"
    if semantic:
        try:
            pool = _prefilter(pool, weighted)
            qv = embed([query], "RETRIEVAL_QUERY")[0]
            dvs = embed([_doc_text(e) for e in pool], "RETRIEVAL_DOCUMENT")
            sims = [_dot(qv, d) for d in dvs]
            mode = "semantic"
        except Exception as ex:
            notices.append(f"Embeddings unavailable ({_short(ex)}); ranked by keywords.")
    if mode == "keyword":
        sims = _keyword_sims(pool, weighted)

    ranked = _clean(_apply_scores(pool, sims)[:limit])
    if not ai.has_api_key():
        notices.append("No Gemini key: plain keyword search with recency boost.")
    return _result(annotate(ranked), queries, mode, notices)


def _prefilter(pool, weighted_terms):
    """Keep every candidate whose embedding is already cached, plus the
    EMBED_NEW_MAX most promising uncached ones (keyword overlap and arXiv rank,
    times recency). Keeps each run inside the embedding rate limit."""
    keys = [_emb_key(_doc_text(e), "RETRIEVAL_DOCUMENT") for e in pool]
    have = db.embeddings_get(set(keys))
    kw = _keyword_sims(pool, weighted_terms)
    now = datetime.now(timezone.utc)
    cached, fresh = [], []
    for e, k, s in zip(pool, keys, kw):
        if k in have:
            cached.append(e)
        else:
            prior = (s + 0.3 / (1 + e.get("_rank", 50) / 10)) * recency_factor(e.get("published", ""), now)
            fresh.append((prior, e))
    fresh.sort(key=lambda t: t[0], reverse=True)
    return cached + [e for _, e in fresh[:EMBED_NEW_MAX]]


def _clean(entries):
    for e in entries:
        e.pop("_rank", None)
    return entries


def _result(items, queries, mode, notices, **extra):
    return {"items": items, "queries": queries, "mode": mode, "notices": notices, **extra}


def _short(ex):
    s = str(ex)
    return s if len(s) < 120 else s[:117] + "..."


# ------------------------------------------------------------ recommendations

def _profile():
    """The PROFILE_SIZE most recently uploaded-or-viewed papers, newest first,
    each with a weight and the text used to represent it."""
    papers = db.list_papers()
    papers.sort(key=lambda p: max(p["uploaded_at"] or 0, p.get("last_viewed") or 0), reverse=True)
    out = []
    for i, p in enumerate(papers[:PROFILE_SIZE]):
        row = db.get_paper(p["id"]) or {}
        pages = store.read_pages(row["uid"]) if row.get("uid") else []
        first = _collapse(pages[0] if pages else "")[:1500]
        out.append(
            {
                "id": p["id"],
                "uid": row.get("uid"),
                "title": p["title"],
                "snippet": first,
                "text": f"{p['title']}\n\n{first}",
                "weight": PROFILE_DECAY ** i,
            }
        )
    return out


def _interest_profile(interests):
    return [
        {"id": None, "uid": None, "title": t, "snippet": "", "text": t,
         "weight": INTEREST_WEIGHT, "interest": True}
        for t in interests
    ]


def recommendations(refresh=False, limit=20):
    papers = _profile()
    interests = store.read_interests()
    profile = _interest_profile(interests) + papers
    if not profile:
        return _result(
            [], [], "none",
            ["Add some interests above, or upload/add a few papers, and recommendations will appear here."],
            profile=[], interests=[],
        )

    semantic = ai.has_api_key()
    sig = hashlib.sha1(
        ("|".join(p["uid"] or str(p["id"]) for p in papers)
         + "|i:" + "|".join(i.lower() for i in interests)
         + f"|{semantic}").encode()
    ).hexdigest()
    cache_key = "recs:" + sig
    if not refresh:
        hit = db.cache_get(cache_key, RECS_CACHE_TTL)
        if hit:
            hit["items"] = annotate(hit["items"][:limit])
            hit["cached"] = True
            return hit

    notices = []
    queries = []
    if semantic:
        try:
            n = min(6, max(4, len(interests) + (2 if papers else 0)))
            queries = _cached_queries(
                "qgen:recs:" + sig,
                lambda: ai.arxiv_queries_for_interests(papers[:5], n=n, interests=interests),
                refresh=refresh,
            )
        except Exception as ex:
            notices.append(f"Gemini could not write queries ({_short(ex)}); used title keywords.")
    if not queries:
        for t in interests[:4]:
            queries.extend(_keyword_queries(t)[:1])
        for p in papers[:3]:
            terms = _salient_terms(p["title"], p["snippet"])
            if terms:
                queries.append(" AND ".join(f"all:{t}" for t in terms))

    pool, errors = _gather(queries)
    if not pool and errors:
        raise DiscoverError(errors[0])
    if errors:
        notices.append(f"{len(errors)} arXiv request(s) failed; results may be incomplete.")

    index = library_index()
    pool = [e for e in pool if find_in_library(e, index) is None]

    weighted = {}
    for p in profile:
        for t in _terms(p["title"], 8):
            weighted[t] = weighted.get(t, 0) + p["weight"]
    for q in queries:
        for t in _terms(q, 12):
            weighted.setdefault(t, 0.3)

    mode = "keyword"
    sims = []
    if pool and semantic:
        try:
            pool = _prefilter(pool, weighted)
            pvs = embed([p["text"] for p in profile], "RETRIEVAL_QUERY")
            dvs = embed([_doc_text(e) for e in pool], "RETRIEVAL_DOCUMENT")
            wsum = sum(p["weight"] for p in profile)
            for d in dvs:
                per = [_dot(d, pv) for pv in pvs]
                mean = sum(s * p["weight"] for s, p in zip(per, profile)) / wsum
                # Blend the weighted mean with the best single match so one
                # strong interest isn't averaged away by the others.
                best = max(s * (0.5 + 0.5 * p["weight"]) for s, p in zip(per, profile))
                sims.append(0.6 * mean + 0.4 * best)
            mode = "semantic"
        except Exception as ex:
            notices.append(f"Embeddings unavailable ({_short(ex)}); ranked by keywords.")
    if mode == "keyword" and pool:
        sims = _keyword_sims(pool, weighted)

    # Cache the whole ranked list (up to 50) so any `limit` can be served.
    ranked = _clean(_apply_scores(pool, sims)[:50])
    result = _result(
        ranked, queries, mode, notices,
        profile=[{"id": p["id"], "title": p["title"]} for p in papers],
        interests=interests,
        computed_at=time.time(),
    )
    # Don't pin a degraded (fallback) result for hours; retry next time.
    if mode == "semantic" or not semantic:
        db.cache_put(cache_key, result)
    result["items"] = annotate(result["items"][:limit], index)
    result["cached"] = False
    return result
