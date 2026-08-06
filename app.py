"""
app.py (Flask version)
Flask backend for the document-based RAG chatbot powered by Groq.
Uses Voyage embeddings for retrieval and Groq for answers.

Run with:
    python app.py
Then open http://localhost:5000
"""

import os
from flask import Flask, render_template, request, jsonify, session
from dotenv import load_dotenv

from rag_engine import extract_text, chunk_text, VectorStore, ask_groq

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or os.urandom(32)
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY")

# In-memory store keyed by session id: { session_id: {"store": VectorStore, "doc_name": str} }
# NOTE: simple in-memory approach — fine for local/single-user use.
# For multi-user production use, back this with redis or similar.
SESSIONS = {}

ALLOWED_EXTENSIONS = {"pdf", "docx", "txt"}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_session_id():
    if "sid" not in session:
        session["sid"] = os.urandom(16).hex()
    return session["sid"]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "Unsupported file type. Use PDF, DOCX, or TXT."}), 400

    if not GROQ_API_KEY or not VOYAGE_API_KEY:
        return jsonify({"error": "Server configuration is missing GROQ_API_KEY or VOYAGE_API_KEY."}), 500

    try:
        file_bytes = file.read()
        text = extract_text(file_bytes, file.filename)

        if not text:
            return jsonify({"error": "Couldn't extract any text from this file."}), 400

        chunks = chunk_text(text)
        store = VectorStore(api_key=VOYAGE_API_KEY)
        store.build(chunks)

        sid = get_session_id()
        SESSIONS[sid] = {
            "store": store,
            "doc_name": file.filename,
        }

        return jsonify({
            "message": f"Indexed '{file.filename}' — {len(chunks)} chunks.",
            "doc_name": file.filename,
            "chunk_count": len(chunks),
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json(silent=True) or {}
    question = data.get("question", "").strip()
    top_k = int(data.get("top_k", 4))
    model = data.get("model", "llama-3.3-70b-versatile")

    if not question:
        return jsonify({"error": "Question is required"}), 400

    sid = get_session_id()
    sess = SESSIONS.get(sid)

    if not sess:
        return jsonify({"error": "Please upload and process a document first."}), 400

    try:
        store: VectorStore = sess["store"]
        relevant_chunks = store.search(question, k=top_k)

        answer = ask_groq(
            question=question,
            context_chunks=relevant_chunks,
            api_key=GROQ_API_KEY,
            model=model,
        )

        return jsonify({
            "answer": answer,
            "sources": relevant_chunks,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/status", methods=["GET"])
def status():
    sid = get_session_id()
    sess = SESSIONS.get(sid)
    if sess:
        return jsonify({"active": True, "doc_name": sess["doc_name"]})
    return jsonify({"active": False})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
