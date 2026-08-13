const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const uploadWell = document.getElementById('upload-well');
const selectedFileEl = document.getElementById('selected-file');
const selectedFileName = document.getElementById('selected-file-name');
const clearFileBtn = document.getElementById('clear-file-btn');
const processBtn = document.getElementById('process-btn');
const docStatus = document.getElementById('doc-status');
const statusName = document.getElementById('status-name');
const statusDetail = document.getElementById('status-detail');
const uploadError = document.getElementById('upload-error');
const modelSelect = document.getElementById('model-select');
const topkRange = document.getElementById('topk-range');
const topkValue = document.getElementById('topk-value');
const feed = document.getElementById('feed');
const composer = document.getElementById('composer');
const questionInput = document.getElementById('question-input');
const askBtn = document.getElementById('ask-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menu-btn');
const sidebarClose = document.getElementById('sidebar-close');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function openMenu() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('visible'); }
function closeMenu() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('visible'); }
menuBtn.addEventListener('click', openMenu);
sidebarClose.addEventListener('click', closeMenu);
sidebarBackdrop.addEventListener('click', closeMenu);
newChatBtn.addEventListener('click', () => { resetChat(); closeMenu(); });

let selectedFile = null;
let diagramCount = 0;

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => fileInput.files[0] && setSelectedFile(fileInput.files[0]));
clearFileBtn.addEventListener('click', clearSelectedFile);
['dragover', 'dragenter'].forEach((eventName) => uploadWell.addEventListener(eventName, (event) => { event.preventDefault(); uploadWell.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach((eventName) => uploadWell.addEventListener(eventName, (event) => { event.preventDefault(); uploadWell.classList.remove('drag-over'); }));
uploadWell.addEventListener('drop', (event) => event.dataTransfer.files[0] && setSelectedFile(event.dataTransfer.files[0]));
topkRange.addEventListener('input', () => { topkValue.textContent = topkRange.value; });
newChatBtn.addEventListener('click', resetChat);
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { questionInput.value = button.dataset.prompt; resizeTextarea(); questionInput.focus(); }));

function setSelectedFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'txt'].includes(extension)) return showError('Use a PDF, DOCX, or TXT file.');
  selectedFile = file;
  selectedFileName.textContent = file.name;
  selectedFileEl.classList.remove('hidden');
  hideError();
  processBtn.disabled = false;
}

function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = '';
  selectedFileEl.classList.add('hidden');
  processBtn.disabled = true;
}

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  hideError(); processBtn.disabled = true; processBtn.textContent = 'Indexing...';
  const formData = new FormData(); formData.append('file', selectedFile);
  try {
    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed.');
    statusName.textContent = data.doc_name;
    statusDetail.textContent = `${data.chunk_count} sections ready`;
    docStatus.classList.remove('hidden');
    questionInput.disabled = false; askBtn.disabled = false;
    questionInput.placeholder = 'Ask anything about your document...';
    processBtn.textContent = 'Re-index document'; processBtn.disabled = false;
    questionInput.focus();
    closeMenu();
  } catch (error) { showError(error.message); processBtn.textContent = 'Index document'; processBtn.disabled = false; }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question || questionInput.disabled) return;
  removeWelcome(); addMessage('user', question); questionInput.value = ''; resizeTextarea();
  questionInput.disabled = true; askBtn.disabled = true;
  const thinking = addMessage('assistant', 'Reading your document...', true);
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, top_k: Number(topkRange.value), model: modelSelect.value }) });
    const data = await response.json(); thinking.remove();
    addMessage('assistant', response.ok ? data.answer : `Unable to answer: ${data.error || 'Something went wrong.'}`, false, response.ok ? question : '');
  } catch { thinking.remove(); addMessage('assistant', 'Unable to reach the server. Please try again.'); }
  questionInput.disabled = false; askBtn.disabled = false; questionInput.focus();
});

questionInput.addEventListener('input', resizeTextarea);
questionInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
function resizeTextarea() { questionInput.style.height = 'auto'; questionInput.style.height = `${Math.min(questionInput.scrollHeight, 160)}px`; }

function addMessage(role, text, thinking = false, diagramQuestion = '') {
  const message = document.createElement('article'); message.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'You' : 'D';
  const body = document.createElement('div'); body.className = `message-body${thinking ? ' thinking' : ''}`;
  if (thinking) body.textContent = text; else renderAnswer(body, text, diagramQuestion);
  message.append(avatar, body); feed.appendChild(message); scrollFeed(); return message;
}

function renderAnswer(container, text, diagramQuestion = '') {
  const diagramRequested = isDiagramRequest(diagramQuestion);
  const mermaidBlock = /```mermaid\s*([\s\S]*?)```/gi;
  let cursor = 0; let match; let renderedDiagram = false;
  while ((match = mermaidBlock.exec(text)) !== null) {
    appendPlainText(container, text.slice(cursor, match.index));
    renderDiagram(container, match[1].trim()); renderedDiagram = true; cursor = match.index + match[0].length;
  }
  const remainingText = text.slice(cursor);
  const predefinedSteps = diagramRequested && !renderedDiagram ? predefinedFlowchartSteps(diagramQuestion) : null;
  const fallbackSteps = predefinedSteps || (diagramRequested && !renderedDiagram ? extractProcessSteps(text) : []);
  const visibleText = predefinedSteps ? removeRawFlowchartBlock(remainingText) : removeStepList(remainingText, fallbackSteps);
  appendPlainText(container, fallbackSteps.length >= 2 ? visibleText : remainingText);
  if (diagramRequested && !renderedDiagram) {
    if (fallbackSteps.length >= 2) renderDiagram(container, stepsToFlowchart(fallbackSteps));
  }
}

function appendPlainText(container, text) {
  const compactText = text.replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, '\n\n').trim();
  if (!compactText) return;
  renderMarkdown(container, compactText);
}

function renderMarkdown(container, text) {
  const blocks = text.split(/\n{2,}/);
  blocks.forEach((block) => {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) return;
    const heading = lines.length === 1 && lines[0].match(/^#{1,3}\s+(.+)$/);
    if (heading) { const element = document.createElement('h3'); element.textContent = heading[1]; container.appendChild(element); return; }
    const ordered = lines.every((line) => /^\d+[.)]\s+/.test(line));
    const unordered = lines.every((line) => /^[-*]\s+/.test(line));
    if (ordered || unordered) {
      const list = document.createElement(ordered ? 'ol' : 'ul');
      lines.forEach((line) => { const item = document.createElement('li'); appendInlineText(item, line.replace(ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/, '')); list.appendChild(item); });
      container.appendChild(list); return;
    }
    const topic = lines[0].match(/^\*\*(.+)\*\*\s*$/);
    const rest = lines.slice(1);
    const restOrdered = rest.length && rest.every((line) => /^\d+[.)]\s+/.test(line));
    const restUnordered = rest.length && rest.every((line) => /^[-*]\s+/.test(line));
    if (topic && (restOrdered || restUnordered)) {
      const headingEl = document.createElement('p'); headingEl.className = 'bold-topic';
      const strong = document.createElement('strong'); strong.textContent = topic[1];
      headingEl.appendChild(strong); container.appendChild(headingEl);
      const list = document.createElement(restOrdered ? 'ol' : 'ul');
      rest.forEach((line) => { const item = document.createElement('li'); appendInlineText(item, line.replace(restOrdered ? /^\d+[.)]\s+/ : /^[-*]\s+/, '')); list.appendChild(item); });
      container.appendChild(list); return;
    }
    const paragraph = document.createElement('p'); appendInlineText(paragraph, lines.join(' ')); container.appendChild(paragraph);
  });
}

function appendInlineText(container, text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((part) => { if (/^\*\*[^*]+\*\*$/.test(part)) { const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); container.appendChild(strong); } else { container.appendChild(document.createTextNode(part)); } });
}
function renderDiagram(container, definition) {
  const wrapper = document.createElement('div'); wrapper.className = 'flowchart-wrap'; container.appendChild(wrapper);
  const parsed = parseFlowchart(definition);
  if (!parsed) { const error = document.createElement('div'); error.className = 'flowchart-error'; error.textContent = 'The answer included a diagram format that could not be displayed.'; wrapper.appendChild(error); return; }
  const canvas = document.createElement('div'); canvas.className = 'flowchart-canvas'; wrapper.appendChild(canvas);
  const rankSizes = []; parsed.nodes.forEach((node) => { rankSizes[node.rank] = (rankSizes[node.rank] || 0) + 1; });
  const width = Math.max(520, Math.max(...rankSizes) * 210 + 70); const height = Math.max(170, (Math.max(...parsed.nodes.map((node) => node.rank)) + 1) * 112 + 35);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const positions = new Map(); const rankOffsets = [];
  parsed.nodes.forEach((node) => { const index = rankOffsets[node.rank] || 0; rankOffsets[node.rank] = index + 1; const count = rankSizes[node.rank]; positions.set(node.id, { x: width / 2 + (index - (count - 1) / 2) * 210, y: 58 + node.rank * 112 }); });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-label', 'Flowchart');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker'); marker.setAttribute('id', `arrow-${diagramCount}`); marker.setAttribute('markerWidth', '8'); marker.setAttribute('markerHeight', '8'); marker.setAttribute('refX', '7'); marker.setAttribute('refY', '3'); marker.setAttribute('orient', 'auto'); const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path'); arrow.setAttribute('d', 'M0,0 L0,6 L7,3 z'); arrow.setAttribute('fill', '#7f958f'); marker.appendChild(arrow); defs.appendChild(marker); svg.appendChild(defs);
  parsed.edges.forEach((edge) => { const from = positions.get(edge.from); const to = positions.get(edge.to); const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', `M ${from.x} ${from.y + 34} C ${from.x} ${from.y + 75}, ${to.x} ${to.y - 75}, ${to.x} ${to.y - 34}`); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#7f958f'); line.setAttribute('stroke-width', '1.5'); line.setAttribute('marker-end', `url(#arrow-${diagramCount})`); svg.appendChild(line); if (edge.label) { const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', String((from.x + to.x) / 2 + 8)); label.setAttribute('y', String((from.y + to.y) / 2 - 4)); label.setAttribute('class', 'flow-edge-label'); label.textContent = edge.label; svg.appendChild(label); } });
  canvas.appendChild(svg); diagramCount += 1;
  parsed.nodes.forEach((node) => { const position = positions.get(node.id); const element = document.createElement('div'); element.className = `flow-node ${node.type}`; element.style.left = `${position.x - 80}px`; element.style.top = `${position.y - 28}px`; const label = document.createElement('span'); label.textContent = node.label; element.appendChild(label); canvas.appendChild(element); });
}

function parseFlowchart(definition) {
  if (!/^\s*(flowchart|graph)\s+(TD|TB|BT)\b/im.test(definition)) return null;
  const nodes = new Map(); const edges = []; const nodePattern = /([A-Za-z][\w-]*)\s*(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\))?/g;
  const lines = definition.split('\n').map((line) => line.trim()).filter((line) => line && !/^(flowchart|graph)\b/i.test(line));
  lines.forEach((line) => { if (!line.includes('-->')) return; const [left, rightPart] = line.split('-->'); let label = ''; let right = rightPart.trim(); const labelMatch = right.match(/^\|([^|]+)\|\s*(.+)$/); if (labelMatch) { label = labelMatch[1].trim(); right = labelMatch[2]; } const leftMatch = [...left.matchAll(nodePattern)][0]; const rightMatch = [...right.matchAll(nodePattern)][0]; if (!leftMatch || !rightMatch) return; const addNode = (match) => { const id = match[1]; if (!nodes.has(id)) { const decision = match[3]; const rawLabel = (match[2] || decision || match[4] || id).replaceAll('"', ''); const nodeType = decision ? 'decision' : /^(start|stop|end)$/i.test(rawLabel) ? 'terminal' : /^(read|input|print|output|display|show)\b/i.test(rawLabel) ? 'io' : ''; nodes.set(id, { id, label: rawLabel, type: nodeType, rank: 0 }); } return id; }; const from = addNode(leftMatch); const to = addNode(rightMatch); edges.push({ from, to, label }); });
  if (!nodes.size || !edges.length) return null;
  for (let pass = 0; pass < nodes.size; pass += 1) edges.forEach((edge) => { nodes.get(edge.to).rank = Math.max(nodes.get(edge.to).rank, nodes.get(edge.from).rank + 1); });
  return { nodes: [...nodes.values()], edges };
}

function isDiagramRequest(question) {
  return /\b(flow\s*chart|flowchart|diagram|visuali[sz](e|ation)|graphical representation|process map)\b/i.test(question);
}

function predefinedFlowchartSteps(question) {
  if (/\baverage\b.*\b(three|3)\b|\b(three|3)\b.*\baverage\b/i.test(question)) {
    return ['Start', 'Read A, B, and C', 'Sum = A + B + C', 'Average = Sum / 3', 'Print Average', 'Stop'];
  }
  return null;
}

function extractProcessSteps(text) {
  const numbered = text.split('\n')
    .map((line) => line.match(/^\s*\d+[.)]\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].replace(/^[-*]\s*/, ''));
  if (numbered.length >= 2) return numbered.slice(0, 10);

  const processSection = text.split(/(?:flowchart|process)(?:\s+for[^:\n]*)?:?/i).pop();
  return processSection.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(start|stop|end|read|input|output|print|add|sum|divide|calculate|process)\b/i.test(line))
    .slice(0, 10);
}

function removeStepList(text, steps) {
  const stepSet = new Set(steps.map((step) => step.toLowerCase().trim()));
  return text.split('\n')
    .filter((line) => !stepSet.has(line.trim().toLowerCase()))
    .join('\n');
}

function removeRawFlowchartBlock(text) {
  return text.replace(/(?:here is|below is).*?(?:flowchart|diagram)[^\n]*[\n\s]*[\s\S]*$/i, '').trim();
}

function stepsToFlowchart(steps) {
  const nodes = steps.map((step, index) => {
    const id = `N${index}`;
    const label = step.replace(/[\[\]{}()]/g, '').slice(0, 70);
    return /^(start|stop|end)$/i.test(label) ? `${id}(${label})` : `${id}[${label}]`;
  });
  return `flowchart TD\n${nodes.slice(0, -1).map((node, index) => `${node} --> ${nodes[index + 1]}`).join('\n')}`;
}
function removeWelcome() { document.getElementById('empty-state')?.remove(); }
function scrollFeed() { feed.scrollTop = feed.scrollHeight; }
function showError(message) { uploadError.textContent = message; uploadError.classList.remove('hidden'); }
function hideError() { uploadError.classList.add('hidden'); }
function resetChat() { feed.innerHTML = `<section class="welcome" id="empty-state"><div class="welcome-logo">D</div><h1>What would you like to know?</h1><p>Upload a document, then ask for explanations, summaries, or diagrams.</p></section>`; }
