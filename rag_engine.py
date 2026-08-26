"""
rag_engine.py
Core logic for the document-based RAG chatbot:
- Extract text from PDF / DOCX / TXT / Images (OCR)
- Chunk text
- Build a lightweight TF-IDF index in memory
- Retrieve relevant chunks for a question
- Call Groq's LLM to answer using only the retrieved context
"""

import io
import re
from collections import Counter

import numpy as np
import httpx
from pypdf import PdfReader
from docx import Document as DocxDocument
from groq import Groq

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp", "tiff", "tif"}

_ocr_engine = None

def _get_ocr_engine():
    """Lazy-load RapidOCR engine (lightweight, fast, no GPU needed)."""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def extract_text_from_image(file_bytes: bytes) -> str:
    """Extract text from an image using RapidOCR (ONNX Runtime)."""
    import tempfile, os
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        tmp.write(file_bytes)
        tmp.close()
        engine = _get_ocr_engine()
        result, _ = engine(tmp.name)
        if result:
            return "\n".join(line[1] for line in result).strip()
        return ""
    finally:
        os.unlink(tmp.name)


# ---------------------------------------------------------------------------
# 1. Text extraction
# ---------------------------------------------------------------------------

def extract_text(file_bytes: bytes, filename: str) -> str:
    """Extract raw text from an uploaded PDF, DOCX, TXT, or image file."""
    ext = filename.lower().split(".")[-1]

    if ext == "pdf":
        reader = PdfReader(io.BytesIO(file_bytes))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)

    elif ext == "docx":
        doc = DocxDocument(io.BytesIO(file_bytes))
        text = "\n".join(p.text for p in doc.paragraphs)

    elif ext == "txt":
        text = file_bytes.decode("utf-8", errors="ignore")

    elif ext in IMAGE_EXTENSIONS:
        text = extract_text_from_image(file_bytes)

    else:
        raise ValueError(f"Unsupported file type: .{ext}")

    if not text or not text.strip():
        raise ValueError(
            "Could not extract any text from this file. "
            "For images, ensure the image contains readable printed text."
        )

    return text.strip()


# ---------------------------------------------------------------------------
# 2. Chunking
# ---------------------------------------------------------------------------

def chunk_text(text: str, chunk_size: int = 800, overlap: int = 150) -> list[str]:
    """
    Split text into overlapping chunks (by characters).
    Overlap keeps context from being cut off mid-idea between chunks.
    """
    if not text:
        return []

    chunks = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += chunk_size - overlap

    return chunks


# ---------------------------------------------------------------------------
# 3. TF-IDF + in-memory vector store
# ---------------------------------------------------------------------------

class VectorStore:
    """Stores TF-IDF vectors in memory and searches them with cosine similarity."""

    def __init__(self):
        self.chunks: list[str] = []
        self.vocabulary: dict[str, int] = {}
        self.idf: np.ndarray | None = None
        self.vectors: np.ndarray | None = None

    @staticmethod
    def _normalize(vectors: np.ndarray) -> np.ndarray:
        """L2-normalize rows so a dot product equals cosine similarity."""
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        return vectors / np.maximum(norms, 1e-12)

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """Normalize text into simple word tokens for lexical retrieval."""
        return re.findall(r"[a-z0-9]+", text.lower())

    def build(self, chunks: list[str]):
        """Create normalized TF-IDF vectors for the document chunks."""
        if not chunks:
            self.chunks = []
            self.vocabulary = {}
            self.idf = None
            self.vectors = None
            return

        self.chunks = chunks
        tokenized_chunks = [self._tokenize(chunk) for chunk in chunks]
        document_frequency = Counter(
            token for tokens in tokenized_chunks for token in set(tokens)
        )
        self.vocabulary = {
            token: index for index, token in enumerate(sorted(document_frequency))
        }
        document_count = len(chunks)
        self.idf = np.asarray(
            [
                np.log((1 + document_count) / (1 + document_frequency[token])) + 1
                for token in self.vocabulary
            ],
            dtype=np.float32,
        )

        vectors = np.zeros((document_count, len(self.vocabulary)), dtype=np.float32)
        for row, tokens in enumerate(tokenized_chunks):
            token_counts = Counter(tokens)
            token_total = len(tokens) or 1
            for token, count in token_counts.items():
                column = self.vocabulary.get(token)
                if column is not None:
                    vectors[row, column] = (count / token_total) * self.idf[column]

        self.vectors = self._normalize(vectors)

    def search(self, query: str, k: int = 4, neighbor_count: int = 0) -> list[str]:
        """Return relevant chunks, optionally including neighboring document sections."""
        if self.vectors is None or self.idf is None or not self.chunks:
            return []

        k = min(k, len(self.chunks))
        query_vector = np.zeros(len(self.vocabulary), dtype=np.float32)
        query_tokens = self._tokenize(query)
        token_counts = Counter(query_tokens)
        token_total = len(query_tokens) or 1
        for token, count in token_counts.items():
            column = self.vocabulary.get(token)
            if column is not None:
                query_vector[column] = (count / token_total) * self.idf[column]

        query_vector = self._normalize(query_vector.reshape(1, -1))[0]
        scores = self.vectors @ query_vector
        ranked_indices = np.argsort(scores)[::-1]
        if not neighbor_count:
            return [self.chunks[index] for index in ranked_indices[:k]]

        selected_indices = []
        selected_set = set()
        for index in ranked_indices:
            for candidate in range(index - neighbor_count, index + neighbor_count + 1):
                if 0 <= candidate < len(self.chunks) and candidate not in selected_set:
                    selected_indices.append(candidate)
                    selected_set.add(candidate)
                    if len(selected_indices) == k:
                        return [self.chunks[candidate] for candidate in sorted(selected_indices)]

        return [self.chunks[candidate] for candidate in sorted(selected_indices)]


# ---------------------------------------------------------------------------
# 4. Groq LLM call
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant that answers questions using ONLY the
provided document context. Follow these rules strictly:
- Answer using only the information in the context below.
- If the answer is not present in the context, say clearly that the document
  does not contain that information. Do not make anything up.
- Give structured, detailed answers when the user asks for explanation, notes,
  summary, or contents of a topic, while staying directly relevant.
- Quote or reference specific parts of the context when helpful.
- Apply the point-wise, bold-topic format to EVERY answer about ANY topic,
  never only for one section. Convert every part of the document (definitions,
  advantages, disadvantages, types, symbols, steps, examples) into bullet
  points.
- Never write paragraphs. Always answer point-wise with bullet points ("- ")
  or numbered points. Each distinct fact goes on its own point. Convert any
  prose into points.
- Match the level of detail the user asks for. When the user requests
  "detail", "in detail", "detailed", or "summarize in detail", expand every
  point with the full information found in the document: specific examples,
  all listed items, every advantage/disadvantage, every symbol, and each
  step. Do not compress facts into vague one-line summaries.
- When asked to summarize or give an overview, cover the whole document
  section by section and give each topic detailed points that include the
  concrete facts and examples from the context.
- When the user asks to compare, differentiate, or wants a difference table,
  use a markdown table with | pipe | syntax. Include column headers and
  separator rows. Example:
  | Feature | Option A | Option B |
  |---------|----------|----------|
  | Speed | Fast | Slow |
- Put every topic name and subtopic name in bold with **asterisks**, e.g.
  **Linear Flowchart**. Place the bold topic name on its own line, then list
  its points below it. Never join a topic name and its points on the same
  line, and never wrap a topic name in markdown heading symbols if you can
  instead bold it.
- Example of the required format (only a sample; use the same style for every
  topic you answer about):
  **Types of Flowcharts**
  - Linear (Sequential) Flowchart: Steps are executed one after another in a straight line.
  - Decision (Selection / Branching) Flowchart: Contains one or more Decision diamonds.
  - Looping (Repetition / Iteration) Flowchart: A set of steps is repeated until a condition becomes false.
  - Nested Flowchart: Contains a decision inside another decision or a loop inside another loop.
- When asked for types, categories, or a complete list, inspect all supplied
  context and enumerate every distinct item you find. Do not stop after a few
  examples. If the document states a count, verify the answer contains that
  same number of items. Never guess missing types or present structures from
  another topic as types of flowcharts.
- When the user asks for a flowchart, diagram, process map, or graphical
  representation, first give a clear detailed explanation, then you MUST
  provide one valid Mermaid flowchart in a fenced ```mermaid code block.
  The code block must start with `flowchart TD` and contain nodes plus `-->`
  arrows; never provide only a list of diagram labels. Use only facts found
  in the context, keep node labels short, use square-bracket process nodes,
  and use curly-brace decision nodes only when needed. Make every node
  accurate and meaningful: include required inputs, the calculation, and the
  output. For an average-of-three-numbers chart, show: Start, read A/B/C,
  Sum = A + B + C, Average = Sum / 3, print Average, Stop.
"""


def ask_groq(question: str, context_chunks: list[str], api_key: str,
             model: str = "openai/gpt-oss-120b", max_tokens: int = 2048) -> str:
    """Send the retrieved context + question to Groq's LLM and return the answer."""
    # Connect directly to Groq instead of inheriting a broken system proxy.
    client = Groq(api_key=api_key, http_client=httpx.Client(trust_env=False))

    context = "\n\n---\n\n".join(context_chunks) if context_chunks else "No relevant context found."

    user_prompt = f"""Context from the document:
{context}

Question: {question}

Answer the question using only the context above."""

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=max_tokens,
    )

    return response.choices[0].message.content
