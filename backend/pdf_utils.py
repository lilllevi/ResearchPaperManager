"""PDF text extraction and chunking (pure Python, no native build tools)."""

import re
from pypdf import PdfReader

# Roughly how many characters per retrieval chunk. Long pages are split so no
# single chunk dominates the search index.
CHUNK_TARGET = 1400
CHUNK_OVERLAP = 200


def extract_pages(pdf_path):
    """Return (list_of_page_texts, num_pages)."""
    reader = PdfReader(pdf_path)
    pages = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    return pages, len(reader.pages)


def _split_long(text):
    """Split a long block of text into overlapping windows on sentence-ish
    boundaries so chunks stay coherent."""
    text = text.strip()
    if len(text) <= CHUNK_TARGET:
        return [text] if text else []

    pieces = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + CHUNK_TARGET, n)
        # try to end on a paragraph/sentence boundary for readability
        window = text[start:end]
        boundary = max(window.rfind("\n\n"), window.rfind(". "))
        if end < n and boundary > CHUNK_TARGET // 2:
            end = start + boundary + 1
        piece = text[start:end].strip()
        if piece:
            pieces.append(piece)
        if end >= n:
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return pieces


def chunk_pages(pages):
    """Turn per-page text into (chunk_index, page_number, text) tuples.

    Page numbers are 1-indexed to match what the viewer shows the user.
    """
    chunks = []
    idx = 0
    for page_no, page_text in enumerate(pages, start=1):
        cleaned = re.sub(r"[ \t]+", " ", page_text)
        for piece in _split_long(cleaned):
            chunks.append((idx, page_no, piece))
            idx += 1
    return chunks
