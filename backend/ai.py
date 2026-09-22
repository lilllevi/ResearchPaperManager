"""Gemini-powered AI features: summarization and Q&A over papers.

Calls Google's Gemini REST API directly using only the Python standard library
(urllib) — no third-party AI SDK, so nothing extra needs to compile on Windows.
The API key is read from the environment (GEMINI_API_KEY), never hardcoded.
The default model is gemini-2.5-flash, overridable via RPM_MODEL.
"""

import json
import os
import urllib.error
import urllib.request

MODEL = os.environ.get("RPM_MODEL", "gemini-flash-latest")
API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def has_api_key():
    return bool(os.environ.get("GEMINI_API_KEY"))


def _complete(system, messages, max_tokens=2000):
    """messages: list of {"role": "user"|"assistant", "content": str}."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set.")

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

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": generation_config,
    }

    url = f"{API_BASE}/models/{MODEL}:generateContent"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        # Surface the API's own message (bad key, quota, bad model name, etc.).
        raise RuntimeError(f"Gemini API error {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach Gemini API: {e.reason}")

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
    return _complete(system, [{"role": "user", "content": user}])


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
    return _complete(system, [{"role": "user", "content": user}])


def summarize_passage(title, passage):
    system = (
        "You are a research assistant. Explain and summarize the specific "
        "passage the user selected from a paper. Be concise and precise."
    )
    user = (
        f"This passage is from the paper \"{title}\". Summarize and explain it "
        f"in plain language:\n\n\"\"\"\n{passage}\n\"\"\""
    )
    return _complete(system, [{"role": "user", "content": user}], max_tokens=1200)


# ------------------------------------------------------------- document Q&A

def answer_about_document(title, question, retrieved_chunks, history, selection=None):
    """Answer a question about a single paper using retrieved context."""
    context_blocks = []
    for c in retrieved_chunks:
        context_blocks.append(f"[page {c['page']}] {c['text']}")
    context = "\n\n".join(context_blocks) if context_blocks else "(no excerpts found)"

    system = (
        f"You are a research assistant helping a reader understand the paper "
        f"\"{title}\". Prioritize and ground your answer in the provided "
        "excerpts, and cite the page like (p. 3) when you use one. If the "
        "excerpts don't fully cover the question, you may also draw on your own "
        "reliable knowledge of the field to give a complete, factually correct "
        "answer — just make clear which parts come from the paper versus general "
        "background knowledge (e.g. 'The paper doesn't say, but in general…'). "
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

    return _complete(system, messages)


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
    return _complete(system, messages)
