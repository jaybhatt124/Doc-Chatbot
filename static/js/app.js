// app.js — Marginal front end logic

const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const uploadWell = document.getElementById('upload-well');
const wellText = document.querySelector('.well-text');
const processBtn = document.getElementById('process-btn');
const docStatus = document.getElementById('doc-status');
const statusName = document.getElementById('status-name');
const statusDetail = document.getElementById('status-detail');
const uploadError = document.getElementById('upload-error');

const modelSelect = document.getElementById('model-select');
const topkRange = document.getElementById('topk-range');
const topkValue = document.getElementById('topk-value');

const feed = document.getElementById('feed');
const emptyState = document.getElementById('empty-state');
const composer = document.getElementById('composer');
const questionInput = document.getElementById('question-input');
const askBtn = document.getElementById('ask-btn');

let selectedFile = null;

// ---------------- Upload well interactions ----------------

browseBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setSelectedFile(fileInput.files[0]);
});

['dragover', 'dragenter'].forEach(evt =>
  uploadWell.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadWell.classList.add('drag-over');
  })
);

['dragleave', 'drop'].forEach(evt =>
  uploadWell.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadWell.classList.remove('drag-over');
  })
);

uploadWell.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

function setSelectedFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'txt'].includes(ext)) {
    showError('Unsupported file type. Use PDF, DOCX, or TXT.');
    return;
  }
  selectedFile = file;
  hideError();
  wellText.innerHTML = `<strong>${escapeHtml(file.name)}</strong>`;
  uploadWell.classList.add('has-file');
  processBtn.disabled = false;
}

// ---------------- Process document ----------------

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  hideError();
  processBtn.disabled = true;
  processBtn.textContent = 'Indexing…';

  const formData = new FormData();
  formData.append('file', selectedFile);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Upload failed.');
      processBtn.disabled = false;
      processBtn.textContent = 'Index document';
      return;
    }

    statusName.textContent = data.doc_name;
    statusDetail.textContent = `${data.chunk_count} chunks indexed`;
    docStatus.classList.remove('hidden');

    questionInput.disabled = false;
    askBtn.disabled = false;
    questionInput.focus();

    processBtn.textContent = 'Re-index this file';
    processBtn.disabled = false;

  } catch (err) {
    showError('Could not reach the server. Is app.py running?');
    processBtn.disabled = false;
    processBtn.textContent = 'Index document';
  }
});

// ---------------- Top-k slider ----------------

topkRange.addEventListener('input', () => {
  topkValue.textContent = topkRange.value;
});

// ---------------- Chat ----------------

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  clearEmptyState();
  addUserMessage(question);
  questionInput.value = '';
  questionInput.disabled = true;
  askBtn.disabled = true;

  const thinkingEl = addThinkingMessage();

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        top_k: parseInt(topkRange.value, 10),
        model: modelSelect.value,
      }),
    });
    const data = await res.json();

    thinkingEl.remove();

    if (!res.ok) {
      addAssistantMessage(`⚠ ${data.error || 'Something went wrong.'}`, []);
    } else {
      addAssistantMessage(data.answer, data.sources || []);
    }
  } catch (err) {
    thinkingEl.remove();
    addAssistantMessage('⚠ Could not reach the server.', []);
  }

  questionInput.disabled = false;
  askBtn.disabled = false;
  questionInput.focus();
});

function clearEmptyState() {
  if (emptyState) emptyState.remove();
}

function addUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.textContent = text;
  feed.appendChild(div);
  scrollFeed();
}

function addThinkingMessage() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `<div class="msg-assistant-bubble thinking">reading the excerpts…</div>`;
  feed.appendChild(wrap);
  scrollFeed();
  return wrap;
}

function addAssistantMessage(text, sources) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  const bubble = document.createElement('div');
  bubble.className = 'msg-assistant-bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);

  if (sources.length) {
    const stubs = document.createElement('div');
    stubs.className = 'excerpts';
    sources.forEach((src, i) => {
      const stub = document.createElement('div');
      stub.className = 'excerpt-stub';
      stub.innerHTML = `<span class="stub-label">excerpt ${i + 1}</span><span class="stub-text">${escapeHtml(src)}</span>`;
      stub.addEventListener('click', () => stub.classList.toggle('expanded'));
      stubs.appendChild(stub);
    });
    wrap.appendChild(stubs);
  }

  feed.appendChild(wrap);
  scrollFeed();
}

function scrollFeed() {
  feed.scrollTop = feed.scrollHeight;
}

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove('hidden');
}

function hideError() {
  uploadError.classList.add('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
