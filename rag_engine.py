"""
rag_engine.py
Core logic for the document-based RAG chatbot:
- Extract text from PDF / DOCX / TXT
- Chunk text
- Generate embeddings with the Voyage AI Embedding API
- Retrieve relevant chunks for a question
- Call Groq's LLM to answer using only the retrieved context
"""

import io
import numpy as np
from pypdf import PdfReader
from docx import Document as DocxDocument
from groq import Groq
import voyageai


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
# 3. Voyage embeddings + in-memory vector store
# ---------------------------------------------------------------------------

class VectorStore:
    """Stores Voyage embeddings in memory and searches them with cosine similarity."""

    EMBEDDING_MODEL = "voyage-4-lite"
    EMBEDDING_BATCH_SIZE = 128

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("VOYAGE_API_KEY is required to create embeddings.")

        self.client = voyageai.Client(api_key=api_key)
        self.chunks: list[str] = []
        self.embeddings: np.ndarray | None = None

    @staticmethod
    def _normalize(vectors: np.ndarray) -> np.ndarray:
        """L2-normalize rows so a dot product equals cosine similarity."""
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        return vectors / np.maximum(norms, 1e-12)

    def _embed(self, texts: list[str], input_type: str) -> np.ndarray:
        """Embed text in API-sized batches and return a float32 matrix."""
        vectors = []
        for start in range(0, len(texts), self.EMBEDDING_BATCH_SIZE):
            batch = texts[start:start + self.EMBEDDING_BATCH_SIZE]
            response = self.client.embed(
                batch,
                model=self.EMBEDDING_MODEL,
                input_type=input_type,
            )
            vectors.extend(response.embeddings)

        if len(vectors) != len(texts):
            raise RuntimeError("Voyage returned an unexpected number of embeddings.")

        return np.asarray(vectors, dtype=np.float32)

    def build(self, chunks: list[str]):
        """Embed document chunks and retain the normalized vectors in memory."""
        if not chunks:
            self.chunks = []
            self.embeddings = None
            return

        self.chunks = chunks
        self.embeddings = self._normalize(
            self._embed(chunks, input_type="document")
        )

    def search(self, query: str, k: int = 4) -> list[str]:
        """Return the top-k chunks ranked by cosine similarity to the query."""
        if self.embeddings is None or not self.chunks:
            return []

        k = min(k, len(self.chunks))
        query_embedding = self._normalize(
            self._embed([query], input_type="query")
        )[0]
        scores = self.embeddings @ query_embedding
        top_indices = np.argsort(scores)[-k:][::-1]
        return [self.chunks[index] for index in top_indices]


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
