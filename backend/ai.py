"""Gemini-powered AI features: summarization and Q&A over papers.

Calls Google's Gemini REST API directly using only the Python standard library
(urllib) — no third-party AI SDK, so nothing extra needs to compile on Windows.
The API key is read from the environment (GEMINI_API_KEY), never hardcoded.
The default model is gemini-2.5-flash, overridable via RPM_MODEL.
"""

import json
import os
import time
import urllib.error
import urllib.request

MODEL = os.environ.get("RPM_MODEL", "gemini-flash-latest")
# Embedding model for arXiv semantic search / recommendations. gemini-embedding-001
# is the GA text-embedding model (REST: models/<name>:batchEmbedContents).
EMBED_MODEL = os.environ.get("RPM_EMBED_MODEL", "gemini-embedding-001")
# Used for the small arXiv query-writing calls when MODEL is overloaded (503).
FALLBACK_MODEL = os.environ.get("RPM_FALLBACK_MODEL", "gemini-flash-lite-latest")
EMBED_DIM = 768  # Matryoshka-truncated; smaller cache, near-identical quality
API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def has_api_key():
    return bool(os.environ.get("GEMINI_API_KEY"))


class GeminiError(RuntimeError):
    """An error from the Gemini API. `code` is the HTTP status (None if the
    API was unreachable); `retry_after` is the server's suggested wait in
    seconds for 429s, when it gives one."""

    def __init__(self, message, code=None, retry_after=None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


def _api_error(code, raw):
    """Turn an error body into a readable GeminiError."""
    message, retry = raw.strip()[:300], None
    try:
        err = json.loads(raw).get("error", {})
        message = err.get("message") or message
        for det in err.get("details") or []:
            delay = det.get("retryDelay")
            if delay and delay.endswith("s"):
                retry = float(delay[:-1])
    except Exception:
        pass
    first = message.split("\n")[0][:240]
    return GeminiError(f"Gemini API error {code}: {first}", code, retry)


def _post(url, body, timeout=180):
    """POST JSON to the Gemini REST API and return the parsed response."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise GeminiError("GEMINI_API_KEY is not set.")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise _api_error(e.code, e.read().decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        raise GeminiError(f"Could not reach Gemini API: {e.reason}")


def _complete(system, messages, max_tokens=2000, json_mode=False, model=None):
    """messages: list of {"role": "user"|"assistant", "content": str}."""
    contents = []
    for m in messages:
        # Gemini uses "user" and "model" as the two roles.
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    # Gemini models "think" by default, and thinking tokens count against
    # maxOutputTokens. We add generous headroom so reasoning never crowds out
    # the actual answer. (We do NOT send thinkingConfig — Gemini 3.x rejects a
    # zero thinking budget with a 400, and letting the model think is fine here.)
    generation_config = {"maxOutputTokens": max_tokens + 8000}
    if json_mode:
        generation_config["responseMimeType"] = "application/json"

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": generation_config,
    }

    # _post surfaces the API's own message (bad key, quota, bad model name...).
    data = _post(f"{API_BASE}/models/{model or MODEL}:generateContent", body)

    candidates = data.get("candidates", [])
    if not candidates:
        feedback = data.get("promptFeedback", {})
        reason = feedback.get("blockReason", "no candidates returned")
        return f"(No response — {reason}.)"

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts).strip()
    return text or "(No response was generated.)"


# ------------------------------------------------------------- title detect

def detect_title(full_text):
    """Best-effort: ask the model for the paper's title from its opening text.

    Returns a cleaned single-line title, or "" if nothing usable came back.
    Callers should fall back to the filename when this returns empty.
    """
    head = (full_text or "")[:4000].strip()
    if not head:
        return ""
    system = (
        "You extract the exact title of an academic paper from its opening "
        "text. Reply with ONLY the title on a single line — no quotes, no "
        "prefix like 'Title:', no author names, nothing else."
    )
    user = f"What is the title of this paper?\n\n{head}"
    raw = _complete(system, [{"role": "user", "content": user}], max_tokens=120)
    # Take the first non-empty line and strip stray quotes / 'Title:' prefixes.
    line = next((l.strip() for l in raw.splitlines() if l.strip()), "")
    line = line.strip("\"'").strip()
    if line.lower().startswith("title:"):
        line = line[6:].strip().strip("\"'").strip()
    if line.startswith("(") and line.endswith(")"):  # e.g. "(No response…)"
        return ""
    return line[:300]


# --------------------------------------------------------------- summaries

def summarize_document(title, full_text):
    system = (
        "You are a meticulous research assistant. Summarize academic papers "
        "clearly and faithfully. Never invent findings that are not in the text."
    )
    # Keep the prompt within a sane size; Gemini handles large context but we
    # cap to avoid runaway cost on huge PDFs.
    text = full_text[:120_000]
    user = (
        f"Summarize the research paper titled \"{title}\". Provide:\n"
        "1. A 2-3 sentence overview.\n"
        "2. The key contributions / findings (bullet points).\n"
        "3. Methodology in brief.\n"
        "4. Limitations or open questions the authors mention.\n\n"
        f"Paper text:\n{text}"
    )
    return _complete_resilient(system, [{"role": "user", "content": user}])


def generate_prereading(title, full_text):
    """A 'prereading' guide: the prerequisite concepts to understand *before*
    reading the paper, explained — assuming the reader has a BSc in physics."""
    system = (
        "You are a physics tutor preparing a reader to understand a research "
        "paper. Assume the reader holds a bachelor's degree in physics, so "
        "standard undergraduate physics and mathematics are already known — do "
        "NOT explain those. Instead identify the concepts, techniques, and "
        "terminology BEYOND that level that they should grasp before reading, "
        "and explain each briefly and clearly. Do not summarize the paper's own "
        "results or findings; focus only on background and prerequisites."
    )
    text = full_text[:120_000]
    user = (
        f"Prepare a 'prereading' guide for the paper \"{title}\". Assuming a "
        "bachelor's degree in physics as the reader's current knowledge, list "
        "the core concepts, methods, and terms one should understand before "
        "reading it, and explain each in a few sentences. Organize with markdown "
        "headings and bullet points, ordered from most to least foundational.\n\n"
        f"Paper text:\n{text}"
    )
    return _complete_resilient(system, [{"role": "user", "content": user}])


def summarize_passage(title, passage):
    system = (
        "You are a research assistant. Explain and summarize the specific "
        "passage the user selected from a paper. Be concise and precise."
    )
    user = (
        f"This passage is from the paper \"{title}\". Summarize and explain it "
        f"in plain language:\n\n\"\"\"\n{passage}\n\"\"\""
    )
    return _complete_resilient(system, [{"role": "user", "content": user}], max_tokens=1200)


# ------------------------------------------------------------- document Q&A

def answer_about_document(title, question, retrieved_chunks, history, selection=None):
    """Answer a question about a single paper using retrieved context."""
    context_blocks = []
    for c in retrieved_chunks:
        context_blocks.append(f"[page {c['page']}] {c['text']}")
    context = "\n\n".join(context_blocks) if context_blocks else "(no excerpts found)"

    system = (
        f"You are a knowledgeable tutor helping a reader who is working through "
        f"the paper \"{title}\". Answer the question the user actually asked, "
        "on its own terms. If they ask about a general concept, term, method, "
        "or piece of math, explain that concept generally and thoroughly — the "
        "way a good textbook or lecturer would — rather than restating what the "
        "paper says about it or forcing the explanation into the paper's "
        "framing. Use your own reliable knowledge of the field for this. Then, "
        "only if it adds something, end with a short separate paragraph "
        "headed 'In this paper:' that explains how the concept matters or is "
        "used in this paper, citing pages like (p. 3) from the provided "
        "excerpts. If the question is specifically about the paper itself (its "
        "results, methods, claims), answer from the excerpts and cite pages. "
        "Never fabricate claims or citations; if you are unsure, say so."
    )

    messages = []
    # Include a little prior chat history for continuity.
    for m in history[-6:]:
        messages.append({"role": m["role"], "content": m["content"]})

    user_parts = []
    if selection:
        user_parts.append(
            "The user has highlighted this passage and it is the focus of the "
            f"question:\n\"\"\"\n{selection}\n\"\"\"\n"
        )
    user_parts.append(f"Relevant excerpts from the paper:\n{context}")
    user_parts.append(f"\nQuestion: {question}")
    messages.append({"role": "user", "content": "\n\n".join(user_parts)})

    return _complete_resilient(system, messages)


# ---------------------------------------------------------- cross-corpus Q&A

def answer_across_corpus(question, retrieved_chunks, history):
    """Answer a question across the whole library, citing papers."""
    context_blocks = []
    for c in retrieved_chunks:
        context_blocks.append(
            f"[Paper: {c['title']} | page {c['page']}]\n{c['text']}"
        )
    context = "\n\n".join(context_blocks) if context_blocks else "(no matches found)"

    system = (
        "You are a research librarian with access to the user's paper collection. "
        "Answer using only the provided excerpts. Cite the paper title and page "
        "for each claim, e.g. (\"Attention Is All You Need\", p. 4). If none of "
        "the excerpts are relevant, say the library does not appear to cover it."
    )

    messages = []
    for m in history[-6:]:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append(
        {
            "role": "user",
            "content": f"Excerpts from the library:\n{context}\n\nQuestion: {question}",
        }
    )
    return _complete_resilient(system, messages)


# ------------------------------------------------------------- embeddings

def embed_texts(texts, task_type="RETRIEVAL_DOCUMENT"):
    """Embed a list of strings; returns a list of float lists (same order).

    Uses batchEmbedContents (up to 100 texts per request). Callers cache the
    results, so this is only hit for text it hasn't seen before.
    """
    out = []
    url = f"{API_BASE}/models/{EMBED_MODEL}:batchEmbedContents"
    for i in range(0, len(texts), 100):
        batch = texts[i:i + 100]
        body = {
            "requests": [
                {
                    "model": f"models/{EMBED_MODEL}",
                    "content": {"parts": [{"text": (t or " ")[:8000]}]},
                    "taskType": task_type,
                    "outputDimensionality": EMBED_DIM,
                }
                for t in batch
            ]
        }
        data = _post(url, body, timeout=120)
        embs = data.get("embeddings") or []
        if len(embs) != len(batch):
            raise RuntimeError("Gemini returned an unexpected number of embeddings.")
        out.extend(e.get("values") or [] for e in embs)
    return out


# ------------------------------------------------------ arXiv query writing

_ARXIV_QUERY_RULES = (
    "You write search queries for the arXiv API (export.arxiv.org/api/query, "
    "the search_query parameter). Syntax: field prefixes ti: (title), abs: "
    "(abstract), all: (all fields), cat: (category, e.g. cat:cs.LG, "
    "cat:quant-ph, cat:cond-mat.str-el); boolean operators AND, OR, ANDNOT in "
    "UPPERCASE; parentheses for grouping; double quotes for phrases, e.g. "
    'abs:"graph neural network". Keep each query short (2-5 terms/phrases) so '
    "it actually returns results: prefer abs: phrases joined with AND, and use "
    "OR between synonyms. Do not use dates or any other parameters."
)


RETRY_BUDGET_S = 6.0  # how long to keep retrying MODEL before dropping down
RETRY_FIRST_DELAY_S = 0.5  # backoff doubles each attempt: 0.5, 1, 2, ...


def _complete_resilient(system, messages, **kw):
    """_complete that survives Gemini "high demand" errors.

    On a 500/503 it retries MODEL with a doubling delay; once RETRY_BUDGET_S
    has passed (or on a 429 quota error, which waiting won't fix) it falls
    back to the cheaper FALLBACK_MODEL, which gets one short retry of its own.
    """
    start = time.monotonic()
    delay = RETRY_FIRST_DELAY_S
    while True:
        try:
            return _complete(system, messages, **kw)
        except GeminiError as e:
            if e.code not in (429, 500, 503):
                raise
            last_err = e
            remaining = RETRY_BUDGET_S - (time.monotonic() - start)
            if e.code == 429 or remaining <= 0:
                break
            time.sleep(min(delay, remaining))
            delay *= 2
    if not FALLBACK_MODEL or FALLBACK_MODEL == MODEL:
        raise last_err
    try:
        return _complete(system, messages, model=FALLBACK_MODEL, **kw)
    except GeminiError as e2:
        if e2.code not in (500, 503):
            raise
        time.sleep(1.0)
        return _complete(system, messages, model=FALLBACK_MODEL, **kw)


def _parse_query_list(raw, limit):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if isinstance(data, dict):
        data = data.get("queries") or next(
            (v for v in data.values() if isinstance(v, list)), []
        )
    if not isinstance(data, list):
        return []
    out = []
    for q in data:
        if isinstance(q, str) and q.strip() and len(q) < 400:
            out.append(q.strip())
    return out[:limit]


def arxiv_queries_for_search(question, n=3):
    """Turn a natural-language search into a few arXiv boolean queries."""
    system = _ARXIV_QUERY_RULES + (
        " Given a natural-language description of what the user is looking "
        f"for, return a JSON array of {n} distinct queries, from most specific "
        "to broadest, that together would retrieve the relevant papers. Reply "
        "with ONLY the JSON array of strings."
    )
    raw = _complete_resilient(system, [{"role": "user", "content": question}], max_tokens=600, json_mode=True)
    return _parse_query_list(raw, n)


def arxiv_queries_for_interests(papers, n=4, interests=None):
    """papers: list of {"title", "snippet"}, most recent/important first.
    interests: research interests the user typed in themselves.
    Returns arXiv queries that would surface new work on the same topics."""
    sections = []
    if interests:
        sections.append(
            "Research interests the user stated explicitly:\n"
            + "\n".join(f"- {t}" for t in interests)
        )
    if papers:
        sections.append(
            "Papers the user has recently been reading (most recent first):\n\n"
            + "\n\n".join(
                f"{i + 1}. {p['title']}\n{p.get('snippet', '')[:600]}" for i, p in enumerate(papers)
            )
        )
    listing = "\n\n".join(sections)
    system = _ARXIV_QUERY_RULES + (
        " Below are the user's stated research interests and/or the papers "
        "they have recently been reading. Identify their main research "
        f"interests and return a JSON array of {n} distinct queries that would "
        "find related new papers. Every stated interest must be covered by at "
        "least one query; use any remaining queries for the topics of the "
        "papers, weighting the most recent ones most. Reply with ONLY the JSON "
        "array of strings."
    )
    raw = _complete_resilient(system, [{"role": "user", "content": listing}], max_tokens=600, json_mode=True)
    return _parse_query_list(raw, n)
