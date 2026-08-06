"""
rag_engine.py
Core logic for the document-based RAG chatbot:
- Extract text from PDF / DOCX / TXT
- Chunk text
- Build a FAISS vector index using sentence-transformers embeddings
- Retrieve relevant chunks for a question
- Call Groq's LLM to answer using only the retrieved context
"""

import os
import io
import numpy as np
import faiss
from pypdf import PdfReader
from docx import Document as DocxDocument
from sentence_transformers import SentenceTransformer
from groq import Groq


# ---------------------------------------------------------------------------
# 1. Text extraction
# ---------------------------------------------------------------------------

def extract_text(file_bytes: bytes, filename: str) -> str:
    """Extract raw text from an uploaded PDF, DOCX, or TXT file."""
    ext = filename.lower().split(".")[-1]

    if ext == "pdf":
        reader = PdfReader(io.BytesIO(file_bytes))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)

    elif ext == "docx":
        doc = DocxDocument(io.BytesIO(file_bytes))
        text = "\n".join(p.text for p in doc.paragraphs)

    elif ext == "txt":
        text = file_bytes.decode("utf-8", errors="ignore")

    else:
        raise ValueError(f"Unsupported file type: .{ext}")

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
# 3. Embeddings + Vector store (FAISS)
# ---------------------------------------------------------------------------

class VectorStore:
    """Wraps a sentence-transformers embedder + FAISS index for similarity search."""

    _model_cache = None  # loaded once per process, reused across documents

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        if VectorStore._model_cache is None:
            VectorStore._model_cache = SentenceTransformer(model_name)
        self.model = VectorStore._model_cache
        self.index = None
        self.chunks: list[str] = []

    def build(self, chunks: list[str]):
        """Embed chunks and build a FAISS index over them."""
        self.chunks = chunks
        embeddings = self.model.encode(chunks, convert_to_numpy=True, show_progress_bar=False)
        embeddings = embeddings.astype("float32")
        faiss.normalize_L2(embeddings)  # so inner product == cosine similarity

        dim = embeddings.shape[1]
        self.index = faiss.IndexFlatIP(dim)
        self.index.add(embeddings)

    def search(self, query: str, k: int = 4) -> list[str]:
        """Return the top-k most relevant chunks for a query."""
        if self.index is None or not self.chunks:
            return []

        q_emb = self.model.encode([query], convert_to_numpy=True).astype("float32")
        faiss.normalize_L2(q_emb)

        k = min(k, len(self.chunks))
        scores, idxs = self.index.search(q_emb, k)
        return [self.chunks[i] for i in idxs[0] if i != -1]


# ---------------------------------------------------------------------------
# 4. Groq LLM call
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a helpful assistant that answers questions using ONLY the
provided document context. Follow these rules strictly:
- Answer using only the information in the context below.
- If the answer is not present in the context, say clearly that the document
  does not contain that information. Do not make anything up.
- Keep answers concise and directly relevant to the question.
- Quote or reference specific parts of the context when helpful.
"""


def ask_groq(question: str, context_chunks: list[str], api_key: str,
             model: str = "llama-3.3-70b-versatile") -> str:
    """Send the retrieved context + question to Groq's LLM and return the answer."""
    client = Groq(api_key=api_key)

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
        max_tokens=1024,
    )

    return response.choices[0].message.content
