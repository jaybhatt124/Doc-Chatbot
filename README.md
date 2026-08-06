# Document Q&A Chatbot — Flask + HTML/CSS/JS version

Same RAG engine as the Streamlit app (`rag_engine.py` is unchanged), served through
a Flask backend with a custom HTML/CSS/JS front end called **Marginal**.

## How it works

- `rag_engine.py` — unchanged from the Streamlit version: text extraction (PDF/DOCX/TXT), chunking, FAISS + sentence-transformers vector search, and the Groq LLM call.
- `app.py` — Flask backend exposing three JSON endpoints:
  - `POST /api/upload` — accepts a file, extracts/chunks/indexes it, and stores the index in a per-browser-session dict.
  - `POST /api/ask` — accepts `{question, top_k, model}`, retrieves relevant chunks, asks Groq, returns `{answer, sources}`.
  - `GET /api/status` — reports whether a document is indexed for the current session.
- `templates/index.html` + `static/css/style.css` + `static/js/app.js` — the front end: upload panel on the left ("the shelf"), chat feed on the right ("the desk"). Each answer shows its retrieved excerpts as clickable "stub" cards so you can see exactly what grounded the answer.

## Setup

```bash
pip install -r requirements.txt
copy .env.example .env
python app.py
```

Set `GROQ_API_KEY` in `.env` before starting the app. The `.env` file is ignored by Git and is never sent to the browser.

Open **http://localhost:5000** in your browser.

## Usage

1. Add your Groq API key to `.env` (free at https://console.groq.com/keys).
2. Drag a PDF/DOCX/TXT file into the upload well, or click "browse".
3. Click **Index document**.
4. Ask questions in the chat box. Click any excerpt stub under an answer to expand it and see the full retrieved chunk.

## Notes

- Sessions are stored in-memory (Flask `session` cookie + a server-side dict). Restarting the server clears all indexed documents. For production/multi-user use, swap the in-memory `SESSIONS` dict in `app.py` for Redis or a database.
- Set `FLASK_SECRET_KEY` in `.env` for a stable session secret across server restarts.
- Everything else (chunk size, embedding model, Groq model choices) can be tuned in `rag_engine.py` / the model dropdown, same as the Streamlit version.
