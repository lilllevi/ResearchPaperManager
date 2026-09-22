/* Research Paper Manager — frontend logic.
 *
 * Talks to the FastAPI backend over /api/*. PDF rendering, text selection,
 * and highlight overlays use PDF.js. All persistent data lives on the server
 * (SQLite); the frontend just reflects it.
 */

const pdfjsLib = window["pdfjsLib"];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ------------------------------------------------------------ icon glyphs
// Small inline SVGs used inside JS-built markup (folder rows, context-menu
// kebabs). 1.5px stroke, round caps, currentColor — matches the buttons
// already in index.html.
const ICONS = {
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.7c0-.9.7-1.6 1.6-1.6h4l1.7 2h7.1c.9 0 1.6.7 1.6 1.6v8.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V6.7Z"/></svg>',
  inbox:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12h4.5l1.7 2.9h4.6l1.7-2.9h4.5"/><path d="M5 5.5h14l1.5 6.5v6A1.8 1.8 0 0 1 18.7 20H5.3A1.8 1.8 0 0 1 3.5 18.2v-6L5 5.5Z"/></svg>',
  kebab:
    '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="4.5" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="10" cy="15.5" r="1.3"/></svg>',
};

// ------------------------------------------------------------- app state
const state = {
  papers: [],
  folders: [],
  collapsed: new Set(),   // folder keys the user has collapsed (persisted)
  libraryTab: "all",      // "all" (folder tree) or "recent" (flat, most-recent-first)
  currentPaperId: null,
  currentTitle: "",
  pdfDoc: null,
  scale: 1.4,          // pdf.js render resolution (canvas is rasterized at this)
  zoom: 1,             // live CSS zoom multiplier on top of `scale`
  pagesWrap: null,     // #pdfPages wrapper element (the thing we CSS-zoom)
  pageDivs: {},        // pageNum -> { container, highlightLayer }
  pageSizes: {},       // pageNum -> { w, h } once rendered
  defaultSize: null,   // placeholder size from page 1
  renderedPages: new Set(),
  highlights: [],      // for the current paper
  chatMode: "doc",     // "doc" or "library"
  pendingSelection: null, // {text, page, rects}
  aiEnabled: false,
};

// -------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ----------------------------------------------------------- initial load
async function init() {
  try {
    const status = await api("/api/status");
    state.aiEnabled = status.ai_enabled;
    const el = $("#aiStatus");
    if (status.ai_enabled) {
      el.textContent = `AI ready (${status.model})`;
    } else {
      el.textContent = "AI disabled — set GEMINI_API_KEY in .env and restart.";
      el.classList.add("warn");
    }
  } catch (e) { /* status is best-effort */ }

  try {
    state.collapsed = new Set(JSON.parse(localStorage.getItem("rpm.collapsed") || "[]"));
  } catch (e) { /* ignore bad/absent storage */ }

  await loadFolders();
  await loadPapers();
  renderMessages([]);  // show the chat placeholder instead of a blank panel
  wireEvents();
}

async function loadFolders() {
  try { state.folders = await api("/api/folders"); }
  catch (e) { state.folders = []; }
}

async function loadPapers() {
  state.papers = await api("/api/papers");
  renderPaperList();
}

// Papers are shown in a tree of folders (folders can nest arbitrarily), with an
// "Uncategorized" group at the end. A paper belongs to exactly one folder via
// p.folder_id (null = Uncategorized) and appears only there — not in ancestors.
function renderPaperList() {
  const term = $("#librarySearch").value.trim().toLowerCase();
  const list = $("#paperList");
  list.innerHTML = "";

  if (state.papers.length === 0) {
    list.innerHTML = '<li class="empty-note">No papers yet.</li>';
    return;
  }
  const filtered = state.papers.filter((p) => p.title.toLowerCase().includes(term));
  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty-note">No matches.</li>';
    return;
  }

  // "Recent" is a flat, most-recently-uploaded view (state.papers already
  // comes back ORDER BY uploaded_at DESC from the API) — no folders, no
  // fabricated status, just real upload order.
  if (state.libraryTab === "recent") {
    for (const p of filtered.slice(0, 12)) list.appendChild(renderPaperItem(p));
    return;
  }

  const searching = term.length > 0;
  const tree = buildFolderTree();
  for (const node of tree.roots) {
    const el = renderFolderNode(node, filtered, searching);
    if (el) list.appendChild(el);
  }
  const uncat = { id: null, name: "Uncategorized", parent_id: null, children: [] };
  const uncatEl = renderFolderNode(uncat, filtered, searching);
  if (uncatEl) list.appendChild(uncatEl);
}

// Build a nested tree from the flat state.folders list (each has parent_id).
function buildFolderTree() {
  const byId = new Map();
  state.folders.forEach((f) => byId.set(f.id, { ...f, children: [] }));
  const roots = [];
  for (const f of byId.values()) {
    if (f.parent_id != null && byId.has(f.parent_id)) byId.get(f.parent_id).children.push(f);
    else roots.push(f);
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return { roots };
}

// ids of every folder in the subtree below `id` (for cycle-prevention).
function folderDescendants(id) {
  const out = new Set();
  const walk = (pid) => {
    for (const f of state.folders) {
      if (f.parent_id === pid && !out.has(f.id)) { out.add(f.id); walk(f.id); }
    }
  };
  walk(id);
  return out;
}

// "Parent / Child / Grandchild" path label for a folder id.
function folderPath(f) {
  const byId = new Map(state.folders.map((x) => [x.id, x]));
  const names = [];
  let cur = f, guard = 0;
  while (cur && guard++ < 100) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(" / ");
}

// count of filtered papers directly in a node plus all its descendants
function subtreePaperCount(node, papers) {
  let n = papers.filter((p) => (node.id === null ? !p.folder_id : p.folder_id === node.id)).length;
  for (const c of node.children || []) n += subtreePaperCount(c, papers);
  return n;
}

function folderKey(id) { return id === null ? "none" : "f" + id; }

function saveCollapsed() {
  try { localStorage.setItem("rpm.collapsed", JSON.stringify([...state.collapsed])); }
  catch (e) { /* storage may be unavailable */ }
}

function renderFolderNode(node, filtered, searching) {
  const ownPapers = filtered.filter((p) =>
    node.id === null ? !p.folder_id : p.folder_id === node.id
  );
  const childEls = [];
  for (const c of node.children || []) {
    const el = renderFolderNode(c, filtered, searching);
    if (el) childEls.push(el);
  }
  // While searching, drop branches with no matching papers anywhere inside.
  if (searching && ownPapers.length === 0 && childEls.length === 0) return null;

  const wrap = document.createElement("li");
  wrap.className = "folder-group";
  addDropHandlers(wrap, node.id);

  const collapsed = !searching && state.collapsed.has(folderKey(node.id));
  const head = document.createElement("div");
  head.className = "folder-head";
  head.innerHTML =
    `<span class="folder-caret">${collapsed ? "▸" : "▾"}</span>` +
    `<span class="folder-icon">${node.id === null ? ICONS.inbox : ICONS.folder}</span>` +
    `<span class="folder-name">${escapeHtml(node.name)}</span>` +
    `<span class="folder-count">${subtreePaperCount(node, filtered)}</span>`;
  if (node.id !== null) {
    head.draggable = true;
    head.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", "folder:" + node.id);
      e.dataTransfer.effectAllowed = "move";
      closeMenu();
      e.stopPropagation();
    });
    head.addEventListener("dragend", clearAllDragOver);
    const menuBtn = document.createElement("button");
    menuBtn.className = "folder-menu";
    menuBtn.innerHTML = ICONS.kebab;
    menuBtn.title = "Folder options";
    menuBtn.onclick = (e) => { e.stopPropagation(); openFolderMenu(menuBtn, node); };
    head.appendChild(menuBtn);
  }
  head.onclick = () => {
    if (searching) return;
    const k = folderKey(node.id);
    if (state.collapsed.has(k)) state.collapsed.delete(k);
    else state.collapsed.add(k);
    saveCollapsed();
    renderPaperList();
  };
  wrap.appendChild(head);

  if (!collapsed) {
    const ul = document.createElement("ul");
    ul.className = "folder-children";
    for (const el of childEls) ul.appendChild(el);       // subfolders first
    for (const p of ownPapers) ul.appendChild(renderPaperItem(p));
    if (childEls.length === 0 && ownPapers.length === 0) {
      ul.innerHTML = '<li class="empty-note small">Empty</li>';
    }
    wrap.appendChild(ul);
  }
  return wrap;
}

// "15 Sep" style short date from a unix-seconds timestamp.
function formatShortDate(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (e) { return "—"; }
}

function renderPaperItem(p) {
  const isActive = p.id === state.currentPaperId;
  const li = document.createElement("li");
  li.className = "paper-item" + (isActive ? " active" : "");

  // Drag a paper onto a folder group to move it (see addDropHandlers).
  li.draggable = true;
  li.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", "paper:" + p.id);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("dragging");
    closeMenu();
  });
  li.addEventListener("dragend", () => { li.classList.remove("dragging"); clearAllDragOver(); });

  const main = document.createElement("div");
  main.className = "paper-main";
  // The open paper gets a lifted "card" treatment: a status badge and a real
  // metadata strip (only fields the API actually returns — no invented data).
  let extra = "";
  if (isActive) {
    const hlCount = state.highlights ? state.highlights.length : 0;
    extra =
      '<div class="paper-detail-strip">' +
        '<div class="paper-detail"><span class="paper-detail-label">Added</span><span class="paper-detail-value">' + formatShortDate(p.uploaded_at) + '</span></div>' +
        '<div class="paper-detail"><span class="paper-detail-label">Pages</span><span class="paper-detail-value">' + p.num_pages + '</span></div>' +
        '<div class="paper-detail"><span class="paper-detail-label">Highlights</span><span class="paper-detail-value">' + hlCount + '</span></div>' +
      '</div>';
  }
  main.innerHTML =
    '<div class="paper-row">' +
      `<span class="paper-title">${escapeHtml(p.title)}</span>` +
      (isActive ? '<span class="paper-badge">Reading</span>' : '') +
    '</div>' +
    `<span class="meta">${p.num_pages} pages</span>` +
    extra;
  main.onclick = () => openPaper(p.id);

  const menuBtn = document.createElement("button");
  menuBtn.className = "paper-menu";
  menuBtn.innerHTML = ICONS.kebab;
  menuBtn.title = "Options";
  menuBtn.onclick = (e) => { e.stopPropagation(); openPaperMenu(menuBtn, p); };

  li.appendChild(main);
  li.appendChild(menuBtn);
  return li;
}

// ------------------------------------------------------------ drag & drop
// Papers and folders both carry a "paper:ID" / "folder:ID" payload; a folder
// group is a drop target that moves the dragged item into it (node.id, or null
// for Uncategorized / top level). stopPropagation keeps the innermost group the
// target when groups are nested.
function dragHasItem(e) {
  return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("text/plain");
}
function clearAllDragOver() {
  document.querySelectorAll(".folder-group.drag-over").forEach((el) => el.classList.remove("drag-over"));
}
function addDropHandlers(wrap, targetId) {
  wrap.addEventListener("dragenter", (e) => {
    if (!dragHasItem(e)) return;
    e.preventDefault(); e.stopPropagation();
    clearAllDragOver();
    wrap.classList.add("drag-over");
  });
  wrap.addEventListener("dragover", (e) => {
    if (!dragHasItem(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    clearAllDragOver();
    const data = e.dataTransfer.getData("text/plain");
    if (data.startsWith("paper:")) {
      const paper = state.papers.find((x) => x.id === parseInt(data.slice(6), 10));
      if (paper && paper.folder_id !== targetId) movePaper(paper, targetId);
    } else if (data.startsWith("folder:")) {
      const folder = state.folders.find((x) => x.id === parseInt(data.slice(7), 10));
      if (folder) moveFolder(folder, targetId);
    }
  });
}

// -------------------------------------------------------- context menus
let activeMenu = null;

function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener("mousedown", closeMenuOnOutside, true);
  document.removeEventListener("keydown", closeMenuOnEsc, true);
}
function closeMenuOnOutside(e) { if (activeMenu && !activeMenu.contains(e.target)) closeMenu(); }
function closeMenuOnEsc(e) { if (e.key === "Escape") closeMenu(); }

// items: [{label, onClick, danger?, checked?, indent?} | {sep:true, label?}]
function openMenu(anchorEl, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (it.sep) {
      const d = document.createElement("div");
      d.className = it.label ? "ctx-label" : "ctx-sep";
      if (it.label) d.textContent = it.label;
      menu.appendChild(d);
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item" +
      (it.danger ? " danger" : "") +
      (it.checked ? " checked" : "") +
      (it.indent ? " indent" : "");
    b.textContent = it.label;
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.onClick(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = top + "px";

  activeMenu = menu;
  setTimeout(() => {
    document.addEventListener("mousedown", closeMenuOnOutside, true);
    document.addEventListener("keydown", closeMenuOnEsc, true);
  }, 0);
}

// folders sorted by their full path, for stable menu ordering
function foldersByPath() {
  return state.folders.slice().sort((a, b) =>
    folderPath(a).localeCompare(folderPath(b), undefined, { sensitivity: "base" })
  );
}

function openPaperMenu(anchor, p) {
  const items = [
    { label: "Rename", onClick: () => renamePaper(p) },
    { sep: true, label: "Move to" },
    { label: "Uncategorized", checked: !p.folder_id, indent: true, onClick: () => movePaper(p, null) },
    ...foldersByPath().map((f) => ({
      label: folderPath(f), checked: p.folder_id === f.id, indent: true,
      onClick: () => movePaper(p, f.id),
    })),
    { label: "+ New folder…", indent: true, onClick: () => moveToNewFolder(p) },
    { sep: true },
    { label: "Delete", danger: true, onClick: () => deletePaperById(p.id, p.title) },
  ];
  openMenu(anchor, items);
}

function openFolderMenu(anchor, node) {
  const banned = folderDescendants(node.id);
  banned.add(node.id); // can't move a folder into itself or its own subtree
  const moveItems = [
    { label: "Top level", checked: node.parent_id == null, indent: true, onClick: () => moveFolder(node, null) },
    ...foldersByPath().filter((f) => !banned.has(f.id)).map((f) => ({
      label: folderPath(f), checked: node.parent_id === f.id, indent: true,
      onClick: () => moveFolder(node, f.id),
    })),
  ];
  openMenu(anchor, [
    { label: "+ New subfolder…", onClick: () => newSubfolder(node) },
    { label: "Rename folder", onClick: () => renameFolder(node) },
    { sep: true, label: "Move folder to" },
    ...moveItems,
    { sep: true },
    { label: "Delete folder", danger: true, onClick: () => deleteFolder(node) },
  ]);
}

// ----------------------------------------------------- folder/paper actions
async function newFolder() {
  const name = prompt("New folder name:");
  if (name === null) return;
  if (!name.trim()) return;
  try {
    await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    await loadFolders();
    renderPaperList();
  } catch (e) { alert("Couldn't create folder: " + e.message); }
}

async function newSubfolder(parent) {
  const name = prompt(`New subfolder inside “${parent.name}”:`);
  if (name === null || !name.trim()) return;
  try {
    await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parent_id: parent.id }),
    });
    if (!state.collapsed.has(folderKey(parent.id))) { /* keep parent open */ }
    await loadFolders();
    renderPaperList();
  } catch (e) { alert("Couldn't create subfolder: " + e.message); }
}

async function renameFolder(g) {
  const name = prompt("Rename folder:", g.name);
  if (name === null || !name.trim()) return;
  await api(`/api/folders/${g.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadFolders();
  renderPaperList();
}

async function moveFolder(folder, newParentId) {
  if (newParentId === folder.id) return;
  if (folder.parent_id === newParentId) return; // no change
  if (newParentId !== null && folderDescendants(folder.id).has(newParentId)) {
    alert("Can't move a folder into one of its own subfolders.");
    return;
  }
  try {
    await api(`/api/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: newParentId }),
    });
    await loadFolders();
    renderPaperList();
  } catch (e) { alert("Couldn't move folder: " + e.message); }
}

async function deleteFolder(g) {
  if (!confirm(`Delete folder "${g.name}"? Its papers and subfolders move up to the parent folder.`)) return;
  await api(`/api/folders/${g.id}`, { method: "DELETE" });
  await loadFolders();
  await loadPapers();
}

async function renamePaper(p) {
  const name = prompt("Rename paper:", p.title);
  if (name === null || !name.trim()) return;
  await api(`/api/papers/${p.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: name.trim() }),
  });
  if (state.currentPaperId === p.id) {
    state.currentTitle = name.trim();
    $("#viewerTitle").textContent = state.currentTitle;
    if (state.chatMode === "doc") $("#chatTitle").textContent = state.currentTitle;
  }
  await loadPapers();
}

async function movePaper(p, folderId) {
  await api(`/api/papers/${p.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_id: folderId }),
  });
  await loadPapers();
}

async function moveToNewFolder(p) {
  const name = prompt("New folder name:");
  if (name === null || !name.trim()) return;
  const f = await api("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadFolders();
  await movePaper(p, f.id);
}

// -------------------------------------------------------------- upload
async function handleUpload(file) {
  const fd = new FormData();
  fd.append("file", file);
  const el = $("#aiStatus");
  const prev = el.textContent;
  el.textContent = "Uploading & indexing…";
  try {
    const result = await api("/api/papers", { method: "POST", body: fd });
    await loadPapers();
    el.textContent = prev;
    openPaper(result.id);
  } catch (e) {
    alert("Upload failed: " + e.message);
    el.textContent = prev;
  }
}

// ------------------------------------------------------------- open paper
async function openPaper(id) {
  state.currentPaperId = id;
  const meta = state.papers.find((p) => p.id === id);
  state.currentTitle = meta ? meta.title : "";
  $("#viewerTitle").textContent = state.currentTitle;
  $("#summarizeBtn").disabled = !state.aiEnabled;
  $("#prereadingBtn").disabled = !state.aiEnabled;
  $("#deletePaperBtn").disabled = false;
  $("#zoomIn").disabled = false;
  $("#zoomOut").disabled = false;
  $("#fullscreenBtn").disabled = false;
  renderPaperList();

  // Switch chat to this document. Load it now rather than after the PDF: the
  // two are independent, and a slow PDF shouldn't leave a stale chat panel.
  state.chatMode = "doc";
  $("#chatTitle").textContent = state.currentTitle;
  loadDocChat();

  state.highlights = await api(`/api/papers/${id}/highlights`);
  renderPaperList(); // refresh the active card's "Highlights" count now it's loaded

  const container = $("#pdfContainer");
  observer.disconnect();
  container.innerHTML = "";
  container.scrollTop = 0;
  state.pageDivs = {};
  state.pageSizes = {};
  state.renderedPages = new Set();
  state.pdfDoc = null;
  renderQueue = [];

  // Show a loading state so a slow/failed load isn't a silent blank page.
  showViewerNote(`<div class="spinner"></div>Loading “${escapeHtml(state.currentTitle)}”…`);

  try {
    const loadingTask = pdfjsLib.getDocument(`/api/papers/${id}/file`);
    state.pdfDoc = await loadingTask.promise;
  } catch (e) {
    showViewerNote(
      `Couldn't load this PDF.<br /><span class="muted">${escapeHtml(e.message || String(e))}</span>` +
      `<br /><br /><span class="muted">Make sure the server is running (\`.\\run.ps1\`) and you're online (PDF.js loads from a CDN).</span>`,
      true
    );
    return;
  }

  // Loaded — clear the note and build the zoomable pages wrapper.
  container.innerHTML = "";
  const pagesWrap = document.createElement("div");
  pagesWrap.id = "pdfPages";
  pagesWrap.style.zoom = state.zoom;
  container.appendChild(pagesWrap);
  state.pagesWrap = pagesWrap;

  // Size every placeholder from page 1 so the scrollbar is accurate and only
  // pages near the viewport get rendered (not the whole document at once).
  const first = await state.pdfDoc.getPage(1);
  const vp1 = first.getViewport({ scale: state.scale });
  state.defaultSize = { w: vp1.width, h: vp1.height };

  for (let n = 1; n <= state.pdfDoc.numPages; n++) {
    const pageWrap = document.createElement("div");
    pageWrap.className = "page";
    pageWrap.dataset.page = n;
    pageWrap.style.width = state.defaultSize.w + "px";
    pageWrap.style.height = state.defaultSize.h + "px";
    pagesWrap.appendChild(pageWrap);
    state.pageDivs[n] = { container: pageWrap, highlightLayer: null };
    observer.observe(pageWrap);
  }

  renderHighlightList();
}

// Lazy, virtualized rendering: render pages as they approach the viewport and
// tear down pages that scroll far away, so CPU/memory stay bounded even on big
// PDFs. Rendering is serialized (one page at a time) to avoid overwhelming the
// browser with many large canvases at once.
let renderQueue = [];
let rendering = false;

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const n = parseInt(entry.target.dataset.page, 10);
      if (entry.isIntersecting) queueRender(n);
      else unrenderPage(n);
    }
  },
  { root: $("#pdfContainer"), rootMargin: "400px" }
);

function queueRender(n) {
  if (state.renderedPages.has(n)) return;
  if (!renderQueue.includes(n)) renderQueue.push(n);
  pumpQueue();
}

async function pumpQueue() {
  if (rendering) return;
  rendering = true;
  while (renderQueue.length) {
    const n = renderQueue.shift();
    if (state.renderedPages.has(n) || !state.pageDivs[n]) continue;
    try {
      await renderPage(n);
    } catch (e) {
      state.renderedPages.delete(n);
    }
  }
  rendering = false;
}

function unrenderPage(n) {
  if (!state.renderedPages.has(n)) return;
  const info = state.pageDivs[n];
  if (!info) return;
  const size = state.pageSizes[n] || state.defaultSize;
  info.container.innerHTML = "";
  if (size) {
    info.container.style.width = size.w + "px";
    info.container.style.height = size.h + "px";
  }
  info.highlightLayer = null;
  state.renderedPages.delete(n);
}

// Render a page's canvas + text layer + highlight layer at `scale` into
// DETACHED elements (not yet in the DOM). Returning them lets callers swap the
// new content in atomically, so a page never shows its blank white background.
async function buildPageContent(n, scale) {
  const page = await state.pdfDoc.getPage(n);
  const viewport = page.getViewport({ scale });

  // Render at the device pixel ratio (capped at 2) so text is sharp on HiDPI
  // screens without creating enormous, slow canvases.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  const ctx = canvas.getContext("2d");
  const renderContext = { canvasContext: ctx, viewport };
  if (dpr !== 1) renderContext.transform = [dpr, 0, 0, dpr, 0, 0];
  await page.render(renderContext).promise;

  // text layer (selectable). PDF.js 3.x positions the (invisible) text spans
  // using the `--scale-factor` CSS variable; without it the spans are
  // mis-sized/offset from the canvas, which throws selections — and therefore
  // saved highlights — out of alignment.
  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));
  const textContent = await page.getTextContent();
  pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
    textDivs: [],
  });

  const hlLayer = document.createElement("div");
  hlLayer.className = "highlightLayer";

  return { viewport, canvas, textLayerDiv, hlLayer };
}

// Place freshly-built content into a page container, replacing whatever's there
// in a single operation (no intermediate empty/white state).
function commitPageContent(n, content) {
  const wrap = state.pageDivs[n].container;
  wrap.style.width = content.viewport.width + "px";
  wrap.style.height = content.viewport.height + "px";
  state.pageSizes[n] = { w: content.viewport.width, h: content.viewport.height };
  wrap.replaceChildren(content.canvas, content.textLayerDiv, content.hlLayer);
  state.pageDivs[n].highlightLayer = content.hlLayer;
  drawHighlightsForPage(n);
}

async function renderPage(n) {
  if (state.renderedPages.has(n)) return;
  state.renderedPages.add(n);
  try {
    const content = await buildPageContent(n, state.scale);
    if (!state.pageDivs[n]) return; // page torn down while we rendered
    commitPageContent(n, content);
  } catch (e) {
    state.renderedPages.delete(n);
    throw e;
  }
}

// --------------------------------------------------------- highlights draw
function drawHighlightsForPage(n) {
  const info = state.pageDivs[n];
  if (!info || !info.highlightLayer) return;
  info.highlightLayer.innerHTML = "";
  // Use the page's native render size (not clientWidth/Height, which reports
  // inconsistently under CSS `zoom`). The highlight layer sits inside the
  // zoomed wrapper, so positioning in native px stays correct at any zoom.
  const size = state.pageSizes[n] || state.defaultSize;
  if (!size) return;
  const w = size.w;
  const h = size.h;
  for (const hl of state.highlights) {
    if (hl.page !== n) continue;
    for (const r of hl.rects) {
      const div = document.createElement("div");
      div.className = "hl-rect";
      div.style.left = r.x * w + "px";
      div.style.top = r.y * h + "px";
      div.style.width = r.w * w + "px";
      div.style.height = r.h * h + "px";
      if (hl.color) div.style.background = hl.color;
      info.highlightLayer.appendChild(div);
    }
  }
}

// --------------------------------------------------------- text selection
function onSelection() {
  const sel = window.getSelection();
  const toolbar = $("#selectionToolbar");
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    toolbar.classList.add("hidden");
    return;
  }
  // Make sure the selection is inside a PDF page.
  const anchorPage = findPageOf(sel.anchorNode);
  if (!anchorPage) {
    toolbar.classList.add("hidden");
    return;
  }

  const range = sel.getRangeAt(0);
  const pageWrap = state.pageDivs[anchorPage].container;
  const pageRect = pageWrap.getBoundingClientRect();
  const clientRects = range.getClientRects();
  const rects = [];
  for (const cr of clientRects) {
    if (cr.width < 1 || cr.height < 1) continue;
    rects.push({
      x: (cr.left - pageRect.left) / pageRect.width,
      y: (cr.top - pageRect.top) / pageRect.height,
      w: cr.width / pageRect.width,
      h: cr.height / pageRect.height,
    });
  }

  state.pendingSelection = { text: sel.toString().trim(), page: anchorPage, rects };

  // position toolbar just above the selection
  const last = clientRects[clientRects.length - 1];
  toolbar.style.left = window.scrollX + last.left + "px";
  toolbar.style.top = window.scrollY + last.top - 44 + "px";
  toolbar.classList.remove("hidden");
}

function findPageOf(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== document.body) {
    if (el.classList && el.classList.contains("page")) {
      return parseInt(el.dataset.page, 10);
    }
    el = el.parentElement;
  }
  return null;
}

// ------------------------------------------------------- selection actions
async function saveHighlight() {
  const s = state.pendingSelection;
  if (!s || !state.currentPaperId) return;
  const body = { page: s.page, text: s.text, rects: s.rects, color: "#ffd54a" };
  const res = await api(`/api/papers/${state.currentPaperId}/highlights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  state.highlights.push({ id: res.id, ...body, note: "" });
  drawHighlightsForPage(s.page);
  renderHighlightList();
  renderPaperList(); // keep the active card's highlight count in sync
  clearSelection();
}

async function summarizeSelection() {
  const s = state.pendingSelection;
  if (!s) return;
  if (!requireAi()) return;
  // In fullscreen the side panel is hidden, so answer in the floating bubble.
  if (isFullscreen()) {
    const text = s.text;
    clearSelection();
    fsRun(
      "Summarize this passage:\n\n" + truncate(text, 300),
      `/api/papers/${state.currentPaperId}/summarize-selection`,
      { question: "", selection: text },
      (res) => res.summary
    );
    return;
  }
  switchToDocChat();
  appendMessage("user", "Summarize this passage:\n\n" + truncate(s.text, 300));
  const thinking = appendThinking();
  try {
    const res = await api(`/api/papers/${state.currentPaperId}/summarize-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "", selection: s.text }),
    });
    thinking.remove();
    appendMessage("assistant", res.summary);
  } catch (e) {
    thinking.remove();
    appendMessage("assistant", "Error: " + e.message);
  }
  clearSelection();
}

function askAboutSelection() {
  const s = state.pendingSelection;
  if (!s) return;
  // In fullscreen, prefill the bubble popup's input instead of the side panel.
  if (isFullscreen()) {
    openFsChat();
    const fsInput = $("#fsChatInput");
    fsInput.value = `About this passage: "${truncate(s.text, 200)}" — `;
    fsInput.dataset.selection = s.text;
    fsInput.focus();
    clearSelection();
    return;
  }
  switchToDocChat();
  const input = $("#chatInput");
  input.value = `About this passage: "${truncate(s.text, 200)}" — `;
  input.dataset.selection = s.text;
  input.focus();
  clearSelection();
}

function clearSelection() {
  window.getSelection().removeAllRanges();
  $("#selectionToolbar").classList.add("hidden");
  state.pendingSelection = null;
}

// ---------------------------------------------------------------- chat
function switchToDocChat() {
  state.chatMode = "doc";
  $("#chatTitle").textContent = state.currentTitle;
  setActiveTab("chat");
}

async function loadDocChat() {
  const msgs = await api(`/api/papers/${state.currentPaperId}/chat`);
  renderMessages(msgs);
}

async function loadLibraryChat() {
  state.chatMode = "library";
  $("#chatTitle").textContent = "Chat across all papers";
  setActiveTab("chat");
  const msgs = await api("/api/library/chat");
  renderMessages(msgs);
}

function renderMessages(msgs) {
  const box = $("#chatMessages");
  box.innerHTML = "";
  if (!msgs.length) {
    let note;
    if (state.chatMode === "library") {
      note = "Ask a question and I'll search across every paper in your library.";
    } else if (state.currentPaperId) {
      note = "Ask a question about this paper, or highlight a passage and choose Summarize or Ask AI.";
    } else {
      note = "Open a paper to chat about it, or use “Chat across all papers”.";
    }
    box.innerHTML = '<div class="chat-empty"></div>';
    box.firstChild.textContent = note;
    return;
  }
  for (const m of msgs) appendMessage(m.role, m.content, false);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, scroll = true) {
  const box = $("#chatMessages");
  const placeholder = box.querySelector(".chat-empty");
  if (placeholder) placeholder.remove();
  const div = document.createElement("div");
  div.className = "msg " + role;
  // Assistant answers are markdown (+ LaTeX) → render; user messages stay plain.
  if (role === "assistant") {
    div.classList.add("md");
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
  return div;
}

function appendThinking() {
  const box = $("#chatMessages");
  const div = document.createElement("div");
  div.className = "msg assistant thinking";
  div.textContent = "Thinking…";
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function sendChat() {
  const input = $("#chatInput");
  const question = input.value.trim();
  if (!question) return;
  if (!requireAi()) return;

  if (state.chatMode === "doc" && !state.currentPaperId) {
    alert("Open a paper first, or use the library chat.");
    return;
  }

  const selection = input.dataset.selection || null;
  appendMessage("user", question);
  input.value = "";
  delete input.dataset.selection;
  const thinking = appendThinking();

  try {
    let res;
    if (state.chatMode === "doc") {
      res = await api(`/api/papers/${state.currentPaperId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, selection }),
      });
    } else {
      res = await api("/api/library/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
    }
    thinking.remove();
    const msg = appendMessage("assistant", res.answer);
    if (res.sources && res.sources.length) {
      const src = document.createElement("div");
      src.className = "sources";
      if (state.chatMode === "doc") {
        const pages = [...new Set(res.sources.map((s) => s.page))];
        src.textContent = "Sources: pages " + pages.join(", ");
      } else {
        const names = [...new Set(res.sources.map((s) => `${s.title} (p.${s.page})`))];
        src.textContent = "Sources: " + names.slice(0, 5).join("; ");
      }
      msg.appendChild(src);
    }
  } catch (e) {
    thinking.remove();
    appendMessage("assistant", "Error: " + e.message);
  }
}

// ------------------------------------------------------- summarize paper
// Shared runner for the whole-paper AI buttons (Summarize, Prereading). Routes
// to the floating bubble in fullscreen (where the side panel is hidden), else
// to the document chat panel.
async function docAiAction(userLabel, path, pick) {
  if (!state.currentPaperId || !requireAi()) return;
  const endpoint = `/api/papers/${state.currentPaperId}/${path}`;
  if (isFullscreen()) {
    fsRun(userLabel, endpoint, {}, pick);
    return;
  }
  switchToDocChat();
  appendMessage("user", userLabel);
  const thinking = appendThinking();
  try {
    const res = await api(endpoint, { method: "POST" });
    thinking.remove();
    appendMessage("assistant", pick(res));
  } catch (e) {
    thinking.remove();
    appendMessage("assistant", "Error: " + e.message);
  }
}

function summarizePaper() {
  docAiAction("Summarize this paper.", "summarize", (r) => r.summary);
}

function generatePrereading() {
  docAiAction(
    "Prereading: core concepts to understand before reading this paper.",
    "prereading",
    (r) => r.prereading
  );
}

// -------------------------------------------------------- highlight list
function renderHighlightList() {
  const box = $("#highlightList");
  box.innerHTML = "";
  if (!state.highlights.length) {
    box.innerHTML = '<div class="empty-note">No highlights yet. Select text in the PDF and click “Highlight”.</div>';
    return;
  }
  for (const hl of state.highlights) {
    const div = document.createElement("div");
    div.className = "hl-item";
    div.innerHTML = `
      <div class="hl-text">${escapeHtml(truncate(hl.text, 260))}</div>
      <div class="hl-meta">
        <span>Page ${hl.page}</span>
        <span>
          <button class="goto">Go to</button>
          <button class="del">Delete</button>
        </span>
      </div>`;
    div.querySelector(".goto").onclick = () => scrollToPage(hl.page);
    div.querySelector(".del").onclick = () => deleteHighlight(hl.id, hl.page);
    box.appendChild(div);
  }
}

function scrollToPage(n) {
  const info = state.pageDivs[n];
  if (info) info.container.scrollIntoView({ behavior: "smooth" });
}

async function deleteHighlight(id, page) {
  await api(`/api/highlights/${id}`, { method: "DELETE" });
  state.highlights = state.highlights.filter((h) => h.id !== id);
  drawHighlightsForPage(page);
  renderHighlightList();
  renderPaperList(); // keep the active card's highlight count in sync
}

// ------------------------------------------------------------ delete paper
function deletePaper() {
  if (!state.currentPaperId) return;
  deletePaperById(state.currentPaperId, state.currentTitle);
}

async function deletePaperById(id, title) {
  if (!confirm(`Delete "${title}"? This removes the file, highlights, and chat.`)) return;
  await api(`/api/papers/${id}`, { method: "DELETE" });
  // If the deleted paper is the one on screen, clear the viewer.
  if (state.currentPaperId === id) {
    state.currentPaperId = null;
    state.pdfDoc = null;
    if (document.fullscreenElement) document.exitFullscreen();
    $("#pdfContainer").innerHTML = '<div id="emptyState"><p>Paper deleted. Select or upload another.</p></div>';
    $("#viewerTitle").textContent = "Select or upload a paper to begin";
    $("#chatMessages").innerHTML = "";
    $("#highlightList").innerHTML = "";
    ["#summarizeBtn", "#prereadingBtn", "#deletePaperBtn", "#zoomIn", "#zoomOut", "#fullscreenBtn"].forEach((s) => ($(s).disabled = true));
  }
  await loadPapers();
}

// ------------------------------------------------------------------ zoom
//
// Zoom works in two layers, like Chrome's PDF viewer:
//   1. LIVE  — a CSS `zoom` on the #pdfPages wrapper responds instantly to the
//              gesture (no re-render, no waiting), anchored to the cursor.
//   2. BAKE  — a short debounce after the gesture re-rasterizes the visible
//              pages at the new effective scale so text stays razor-sharp,
//              without moving the reader's scroll position.
//
// effective scale = state.scale (render resolution) * state.zoom (live CSS).
const MIN_SCALE = 0.4, MAX_SCALE = 6.0;
let bakeTimer = null;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Apply an instant zoom by `factor`, keeping the point under the cursor fixed.
// `e` is an optional wheel/mouse event used as the anchor; falls back to center.
function applyLiveZoom(factor, e) {
  if (!state.pdfDoc || !state.pagesWrap) return;
  const container = $("#pdfContainer");
  const oldZoom = state.zoom;
  const newEff = clamp(state.scale * oldZoom * factor, MIN_SCALE, MAX_SCALE);
  const newZoom = newEff / state.scale;
  if (Math.abs(newZoom - oldZoom) < 1e-4) return;

  const rect = container.getBoundingClientRect();
  const ax = e ? e.clientX - rect.left : rect.width / 2;
  const ay = e ? e.clientY - rect.top : rect.height / 2;

  // content coordinate (unzoomed) currently under the anchor point
  const ux = (container.scrollLeft + ax) / oldZoom;
  const uy = (container.scrollTop + ay) / oldZoom;

  state.zoom = newZoom;
  state.pagesWrap.style.zoom = newZoom;

  // keep that same content point under the cursor after zooming
  container.scrollLeft = ux * newZoom - ax;
  container.scrollTop = uy * newZoom - ay;

  scheduleBake();
}

function scheduleBake() {
  if (bakeTimer) clearTimeout(bakeTimer);
  bakeTimer = setTimeout(bake, 200);
}

// which pages currently intersect the viewport (plus a small margin)
function visiblePages() {
  const container = $("#pdfContainer");
  const rect = container.getBoundingClientRect();
  const out = [];
  for (const n in state.pageDivs) {
    const r = state.pageDivs[n].container.getBoundingClientRect();
    if (r.bottom >= rect.top - 300 && r.top <= rect.bottom + 300) out.push(parseInt(n, 10));
  }
  return out;
}

// Fold the live CSS zoom into the render scale and re-rasterize visible pages.
// Because the on-screen size is identical before and after, the scroll position
// stays put — no jump to the top.
async function bake() {
  if (!state.pdfDoc || !state.pagesWrap) return;
  if (Math.abs(state.zoom - 1) < 1e-4) return; // nothing to fold in

  const z = state.zoom;                 // capture; abort later if a newer zoom lands
  const newScale = state.scale * z;
  const vis = visiblePages();

  // Render the visible pages at the target scale FIRST, off-DOM. The old
  // (CSS-zoomed) canvases stay on screen meanwhile — no white flash.
  let built;
  try {
    built = await Promise.all(vis.map(async (n) => ({ n, content: await buildPageContent(n, newScale) })));
  } catch (e) {
    return;
  }
  // Resolve the new placeholder size BEFORE the commit (page 1 is cached, but
  // it's async) so the commit below has NO awaits — the browser can't paint the
  // intermediate un-zoomed state, which is what would cause a shrink/flash.
  const first = await state.pdfDoc.getPage(1);
  const vp1 = first.getViewport({ scale: newScale });
  if (state.zoom !== z || !state.pagesWrap) return; // a newer gesture is in progress

  // Commit atomically (synchronously): drop the live CSS zoom, adopt the new
  // scale, and swap in the pre-rendered visible pages. On-screen size is
  // unchanged, so neither the layout nor the scroll position moves.
  state.scale = newScale;
  state.zoom = 1;
  state.pagesWrap.style.zoom = 1;
  state.defaultSize = { w: vp1.width, h: vp1.height };

  renderQueue = [];
  state.pageSizes = {};
  const rendered = new Set();
  for (const { n, content } of built) {
    if (!state.pageDivs[n]) continue;
    commitPageContent(n, content); // sets state.pageSizes[n]
    rendered.add(n);
  }
  // Off-screen pages: resize to the new native size and drop their (stale-scale)
  // content so they re-render when scrolled into view. They're off-screen, so
  // emptying them causes no visible flash.
  for (const k in state.pageDivs) {
    const n = parseInt(k, 10);
    if (rendered.has(n)) continue;
    const wrap = state.pageDivs[n].container;
    wrap.replaceChildren();
    wrap.style.width = state.defaultSize.w + "px";
    wrap.style.height = state.defaultSize.h + "px";
    state.pageDivs[n].highlightLayer = null;
  }
  state.renderedPages = rendered;
}

function zoomBy(factor) { applyLiveZoom(factor, null); }

// Ctrl + mouse wheel / trackpad pinch → smooth, continuous live zoom anchored to
// the cursor. The per-event step scales with the scroll delta (so it's smooth,
// not quantized) but has a floor so it's never sluggish on devices that report
// small deltas (precision trackpads), and a cap so a big mouse notch isn't wild.
function wheelZoom(e) {
  if (!e.ctrlKey || !state.pdfDoc) return;
  e.preventDefault();
  // deltaMode 1 = lines (mouse wheel), 0 = pixels (trackpad); normalize to px.
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (!dy) return;
  const mag = Math.min(Math.abs(dy), 100) / 100; // 0..1 by how hard you scrolled
  const step = 0.06 + 0.16 * mag;                // 6%..22% per event
  const factor = Math.exp(dy < 0 ? step : -step);
  applyLiveZoom(factor, e);
}

// Two-finger pinch on a touchscreen → live zoom anchored at the pinch midpoint.
// (#pdfContainer has touch-action: pan-x pan-y so one finger still scrolls.)
let pinchDist = 0;
function touchDistance(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}
function touchMidpoint(t) {
  return { clientX: (t[0].clientX + t[1].clientX) / 2, clientY: (t[0].clientY + t[1].clientY) / 2 };
}
function pinchStart(e) {
  if (e.touches.length === 2 && state.pdfDoc) {
    pinchDist = touchDistance(e.touches);
    e.preventDefault();
  }
}
function pinchMove(e) {
  if (e.touches.length !== 2 || !state.pdfDoc || pinchDist <= 0) return;
  e.preventDefault();
  const d = touchDistance(e.touches);
  applyLiveZoom(d / pinchDist, touchMidpoint(e.touches));
  pinchDist = d;
}
function pinchEnd(e) {
  if (e.touches.length < 2) pinchDist = 0;
}

// ------------------------------------------------- fullscreen read mode
//
// The reader can put the PDF viewer into real fullscreen (browser Fullscreen
// API on #viewer). The right-hand chat panel lives outside #viewer, so it
// disappears in fullscreen — instead we show a floating "Ask AI" button that
// opens a small bubble popup. Highlighting still works (the selection toolbar
// lives inside #viewer), and its Summarize/Ask actions route to the bubble.

function isFullscreen() {
  return document.fullscreenElement === $("#viewer");
}

function toggleFullscreen() {
  if (!state.currentPaperId) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    const viewer = $("#viewer");
    (viewer.requestFullscreen || viewer.webkitRequestFullscreen)?.call(viewer);
  }
}

function onFullscreenChange() {
  const fs = isFullscreen();
  $("#fsChatToggle").classList.toggle("hidden", !fs);
  const btn = $("#fullscreenBtn");
  btn.classList.toggle("is-fullscreen", fs); // CSS swaps the expand/compress icon
  btn.title = fs ? "Exit full screen" : "Read full screen";
  if (!fs) $("#fsChatPopup").classList.add("hidden");
}

function openFsChat() {
  const popup = $("#fsChatPopup");
  popup.classList.remove("hidden");
  ensureFsPlaceholder();
}

function toggleFsChat() {
  const popup = $("#fsChatPopup");
  if (popup.classList.contains("hidden")) {
    openFsChat();
    $("#fsChatInput").focus();
  } else {
    popup.classList.add("hidden");
  }
}

// Show a hint line while the bubble has no messages yet.
function ensureFsPlaceholder() {
  const box = $("#fsChatBody");
  if (!box.children.length) {
    box.innerHTML =
      '<div class="fs-chat-empty">Ask a question about this paper, or highlight a passage and choose Summarize / Ask AI.</div>';
  }
}

function appendFsMessage(cls, content) {
  const box = $("#fsChatBody");
  const empty = box.querySelector(".fs-chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "fs-msg " + cls;
  // Assistant answers are markdown → render them; user/thinking stay plain text.
  if (cls.includes("assistant") && !cls.includes("thinking")) {
    div.classList.add("md");
    div.innerHTML = renderMarkdown(content);
  } else {
    div.textContent = content;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

// Renders a safe subset of Markdown + LaTeX math to HTML. AI output is not
// trusted, so text is HTML-escaped; code, math, headings, bold/italic, links,
// and lists are supported. Fenced code and math are pulled out first (as
// placeholder tokens using  sentinels) so Markdown never mangles them,
// then rendered HTML is spliced back in. Math uses KaTeX if loaded, else raw.
function renderMarkdown(src) {
  const escHtml = (s) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const blocks = [];   // block-level HTML (fenced code, display math)
  const inlines = [];  // inline HTML (inline code, inline math)
  const B = (html) => "B" + (blocks.push(html) - 1) + "";
  const I = (html) => "I" + (inlines.push(html) - 1) + "";

  const tex = (code, display) => {
    if (window.katex) {
      try {
        return window.katex.renderToString(code.trim(), { displayMode: display, throwOnError: false });
      } catch (e) { /* fall back to raw TeX below */ }
    }
    return "<code>" + escHtml(code.trim()) + "</code>";
  };

  src = String(src);
  // 1) fenced code blocks
  src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, code) =>
    B("<pre><code>" + escHtml(code.replace(/\n$/, "")) + "</code></pre>"));
  // 2) display math  $$...$$  and  \[...\]
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (m, c) => B(tex(c, true)));
  src = src.replace(/\\\[([\s\S]+?)\\\]/g, (m, c) => B(tex(c, true)));
  // 3) inline code
  src = src.replace(/`([^`]+)`/g, (m, c) => I("<code>" + escHtml(c) + "</code>"));
  // 4) inline math  $...$  (no space just inside, so "$5 and $6" is not math) and \(...\)
  src = src.replace(/\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (m, c) => I(tex(c, false)));
  src = src.replace(/\\\(([\s\S]+?)\\\)/g, (m, c) => I(tex(c, false)));

  const inline = (t) =>
    escHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\b(https?:\/\/[^\s<)]+)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, bare, txt, url) =>
        bare
          ? '<a href="' + bare + '" target="_blank" rel="noopener">' + bare + "</a>"
          : '<a href="' + url + '" target="_blank" rel="noopener">' + txt + "</a>");

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = line.match(/^B(\d+)$/))) {
      closeList();
      out.push(blocks[+m[1]]);            // a lone block token -> emit block directly
    } else if (!line.trim()) {
      closeList();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 6);
      out.push("<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">");
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else {
      closeList();
      out.push("<p>" + inline(line) + "</p>");
    }
  }
  closeList();

  let html = out.join("");
  html = html.replace(/I(\d+)/g, (m, i) => inlines[+i]);
  html = html.replace(/B(\d+)/g, (m, i) => blocks[+i]);
  return html;
}

// Let the reader reposition the bubble by dragging its header. (Resizing is
// handled natively via CSS `resize: both` on the popup.)
function makeFsPopupDraggable() {
  const popup = $("#fsChatPopup");
  const head = popup.querySelector(".fs-chat-head");
  let startX, startY, startLeft, startTop, dragging = false;

  head.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return; // let the close button work
    const rect = popup.getBoundingClientRect();
    // switch from bottom/right anchoring to explicit left/top for free movement
    popup.style.left = rect.left + "px";
    popup.style.top = rect.top + "px";
    popup.style.right = "auto";
    popup.style.bottom = "auto";
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    dragging = true;
    head.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = popup.offsetWidth, h = popup.offsetHeight;
    const left = clamp(startLeft + (e.clientX - startX), 0, window.innerWidth - w);
    const top = clamp(startTop + (e.clientY - startY), 0, window.innerHeight - h);
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove("dragging");
  });
}

// Resize the bubble from any edge or corner. Handles carry a direction class
// (n/s/e/w and the diagonals); we adjust size + left/top so the opposite
// edge stays anchored, clamped to sane min sizes and the viewport.
function makeFsPopupResizable() {
  const popup = $("#fsChatPopup");
  const MINW = 260, MINH = 200;
  let dir = null, sx, sy, sLeft, sTop, sW, sH;

  const onMove = (e) => {
    if (!dir) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    let left = sLeft, top = sTop, w = sW, h = sH;
    if (dir.includes("e")) w = sW + dx;
    if (dir.includes("s")) h = sH + dy;
    if (dir.includes("w")) { w = sW - dx; left = sLeft + dx; }
    if (dir.includes("n")) { h = sH - dy; top = sTop + dy; }

    if (w < MINW) { if (dir.includes("w")) left -= MINW - w; w = MINW; }
    if (h < MINH) { if (dir.includes("n")) top -= MINH - h; h = MINH; }
    w = Math.min(w, window.innerWidth - 8);
    h = Math.min(h, window.innerHeight - 8);
    left = clamp(left, 0, window.innerWidth - w);
    top = clamp(top, 0, window.innerHeight - h);

    popup.style.width = w + "px";
    popup.style.height = h + "px";
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  };
  const onUp = () => {
    dir = null;
    popup.classList.remove("resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  popup.querySelectorAll(".fs-resize").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      dir = handle.className.replace("fs-resize", "").trim();
      const r = popup.getBoundingClientRect();
      sLeft = r.left; sTop = r.top; sW = r.width; sH = r.height;
      sx = e.clientX; sy = e.clientY;
      // pin to left/top so both dimensions and position are ours to control
      popup.style.left = r.left + "px";
      popup.style.top = r.top + "px";
      popup.style.right = "auto";
      popup.style.bottom = "auto";
      popup.classList.add("resizing");
      e.preventDefault();
      e.stopPropagation();
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

// Drag the divider above the input up/down to resize the text box. Uses pointer
// events so it works with both mouse and touch (handle has touch-action: none).
function makeFsInputResizable() {
  const handle = $("#fsInputResize");
  const input = $("#fsChatInput");
  const popup = $("#fsChatPopup");
  let startY = 0, startH = 0, active = false;

  handle.addEventListener("pointerdown", (e) => {
    active = true;
    startY = e.clientY;
    startH = input.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!active) return;
    const maxH = Math.max(60, popup.clientHeight * 0.7);
    input.style.height = clamp(startH - (e.clientY - startY), 40, maxH) + "px";
  });
  const end = () => { active = false; };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

// Run a doc-scoped AI request and render the Q/A as bubbles in the popup.
async function fsRun(userText, endpoint, body, pick) {
  if (!state.currentPaperId || !requireAi()) return;
  openFsChat();
  appendFsMessage("user", userText);
  const thinking = appendFsMessage("assistant thinking", "Thinking…");
  try {
    const res = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    thinking.remove();
    appendFsMessage("assistant", pick(res));
  } catch (e) {
    thinking.remove();
    appendFsMessage("assistant", "Error: " + e.message);
  }
}

function sendFsChat() {
  const input = $("#fsChatInput");
  const question = input.value.trim();
  if (!question) return;
  const selection = input.dataset.selection || null;
  input.value = "";
  delete input.dataset.selection;
  fsRun(
    question,
    `/api/papers/${state.currentPaperId}/chat`,
    { question, selection },
    (res) => res.answer
  );
}

// ----------------------------------------------------------------- tabs
function setActiveTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".tab-content").forEach((c) =>
    c.classList.toggle("active", c.id === "tab-" + name)
  );
}

// ------------------------------------------------------------- utilities
function showViewerNote(html, isError = false) {
  const container = $("#pdfContainer");
  container.innerHTML = `<div class="viewer-note${isError ? " error" : ""}">${html}</div>`;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function requireAi() {
  if (!state.aiEnabled) {
    alert("AI features are disabled. Set GEMINI_API_KEY in .env and restart the server.");
    return false;
  }
  return true;
}

// ------------------------------------------------------------ wire events
function wireEvents() {
  $("#uploadInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleUpload(e.target.files[0]);
    e.target.value = "";
  });
  $("#librarySearch").addEventListener("input", renderPaperList);
  $("#libraryChatBtn").addEventListener("click", loadLibraryChat);
  $("#newFolderBtn").addEventListener("click", newFolder);

  // library card pill tabs: "All" (folder tree) vs "Recent" (flat, newest first)
  document.querySelectorAll(".lib-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libraryTab = btn.dataset.libtab;
      document.querySelectorAll(".lib-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderPaperList();
    });
  });

  // icon rail: purely a nav affordance (single workspace), but a couple of
  // icons map to something real rather than being inert chrome.
  document.querySelectorAll(".rail-nav .rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".rail-nav .rail-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  $("#railReaderBtn")?.addEventListener("click", toggleFullscreen);
  $("#railHighlightsBtn")?.addEventListener("click", () => setActiveTab("highlights"));
  $("#railSettingsBtn")?.addEventListener("click", () => {
    const el = $("#aiStatus");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 900);
  });
  $("#summarizeBtn").addEventListener("click", summarizePaper);
  $("#prereadingBtn").addEventListener("click", generatePrereading);
  $("#deletePaperBtn").addEventListener("click", deletePaper);
  $("#zoomIn").addEventListener("click", () => zoomBy(1.15));
  $("#zoomOut").addEventListener("click", () => zoomBy(1 / 1.15));
  $("#pdfContainer").addEventListener("wheel", wheelZoom, { passive: false });
  // touchscreen pinch-to-zoom
  $("#pdfContainer").addEventListener("touchstart", pinchStart, { passive: false });
  $("#pdfContainer").addEventListener("touchmove", pinchMove, { passive: false });
  $("#pdfContainer").addEventListener("touchend", pinchEnd);
  $("#pdfContainer").addEventListener("touchcancel", pinchEnd);

  // fullscreen read mode + floating bubble chat
  $("#fullscreenBtn").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  $("#fsChatToggle").addEventListener("click", toggleFsChat);
  $("#fsChatClose").addEventListener("click", () => $("#fsChatPopup").classList.add("hidden"));
  makeFsPopupDraggable();
  makeFsPopupResizable();
  makeFsInputResizable();
  $("#fsChatSend").addEventListener("click", sendFsChat);
  $("#fsChatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendFsChat();
    }
  });

  $("#sendBtn").addEventListener("click", sendChat);
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setActiveTab(t.dataset.tab))
  );

  document.addEventListener("mouseup", () => setTimeout(onSelection, 10));
  $("#selectionToolbar").addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action === "highlight") saveHighlight();
    else if (action === "summarize") summarizeSelection();
    else if (action === "ask") askAboutSelection();
  });
}

init();
