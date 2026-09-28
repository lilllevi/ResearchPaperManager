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
  view: "dashboard",      // "reader" | "dashboard" | "folders" | "bookmarks"
  folderCursor: null,     // folder the Folders screen is currently showing (null = top)
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
  setView("dashboard");  // land on the dashboard (arXiv search + recommendations)
  // Deep link: #search=<query> pre-fills and runs an arXiv search.
  const m = location.hash.match(/^#search=(.+)$/);
  if (m) {
    $("#arxivSearchInput").value = decodeURIComponent(m[1]);
    runArxivSearch();
  }
}

async function loadFolders() {
  try { state.folders = await api("/api/folders"); }
  catch (e) { state.folders = []; }
}

async function loadPapers() {
  state.papers = await api("/api/papers");
  renderPaperList();
  syncBookmarkButton();
  // Keep an open browse screen current after an upload, delete or rename.
  if (typeof SCREENS !== "undefined" && SCREENS[state.view]) SCREENS[state.view].render();
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
// group (or, on the Folders screen, a folder card or breadcrumb) is a drop
// target that moves the dragged item into it (node.id, or null for
// Uncategorized / top level). stopPropagation keeps the innermost group the
// target when groups are nested.
function dragHasItem(e) {
  return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("text/plain");
}
function clearAllDragOver() {
  document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
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
    {
      label: p.bookmarked ? "Remove bookmark" : "Bookmark",
      onClick: () => setBookmark(p.id, !p.bookmarked),
    },
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
// Re-render the sidebar tree and whichever browse screen is open.
function refreshLibrary() {
  renderPaperList();
  if (SCREENS[state.view]) SCREENS[state.view].render();
}

async function newFolder(parentId = null) {
  const name = prompt("New folder name:");
  if (name === null) return;
  if (!name.trim()) return;
  try {
    await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parent_id: parentId }),
    });
    await loadFolders();
    refreshLibrary();
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
    refreshLibrary();
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
  refreshLibrary();
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
    refreshLibrary();
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
  // On the Folders screen, create it inside the folder being viewed.
  const parentId = state.view === "folders" ? state.folderCursor : null;
  const f = await api("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), parent_id: parentId }),
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
  $("#peterBtn").disabled = !state.aiEnabled;
  $("#deletePaperBtn").disabled = false;
  syncBookmarkButton();
  $("#zoomIn").disabled = false;
  $("#zoomOut").disabled = false;
  $("#fullscreenBtn").disabled = false;
  renderPaperList();

  // Record the view (feeds arXiv recommendations). Fire-and-forget.
  api(`/api/papers/${id}/view`, { method: "POST" }).catch(() => {});
  if (meta) meta.last_viewed = Date.now() / 1000;

  // Switch chat to this document. Load it now rather than after the PDF: the
  // two are independent, and a slow PDF shouldn't leave a stale chat panel.
  state.chatMode = "doc";
  $("#chatTitle").textContent = state.currentTitle;
  leaveFsThread();
  hidePeter();
  if (peterJobs.has(id)) peterExplains(false);  // its clip is still being made: show progress
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
      div.dataset.id = hl.id;
      div.style.left = r.x * w + "px";
      div.style.top = r.y * h + "px";
      div.style.width = r.w * w + "px";
      div.style.height = r.h * h + "px";
      if (hl.color) div.style.background = hl.color;
      info.highlightLayer.appendChild(div);
    }
  }
}

// Highlights on page `n` that overlap any of `rects` (page-normalized 0..1).
// The highlight layer is pointer-events:none so it never blocks text
// selection — hit-testing is done here against the saved rects instead.
function highlightsHit(n, rects) {
  const eps = 0.001;
  const overlaps = (a, b) =>
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps &&
    a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
  return state.highlights.filter(
    (hl) => hl.page === n && hl.rects.some((r) => rects.some((q) => overlaps(r, q)))
  );
}

// Page number + normalized point under a mouse event, or null if not over a page.
function pagePointOf(e) {
  const n = findPageOf(e.target);
  if (!n || !state.pageDivs[n]) return null;
  const pr = state.pageDivs[n].container.getBoundingClientRect();
  return {
    n,
    rect: { x: (e.clientX - pr.left) / pr.width, y: (e.clientY - pr.top) / pr.height, w: 0.002, h: 0.002 },
  };
}

// Hover feedback: pointer cursor + stronger tint on the highlight under the mouse.
let hoveredHlId = null;
function onPdfHover(e) {
  const pt = pagePointOf(e);
  const hit = pt ? highlightsHit(pt.n, [pt.rect])[0] : null;
  const id = hit ? hit.id : null;
  if (id === hoveredHlId) return;
  hoveredHlId = id;
  $("#pdfContainer").classList.toggle("over-hl", !!id);
  document.querySelectorAll(".hl-rect.hover").forEach((d) => d.classList.remove("hover"));
  if (id) document.querySelectorAll(`.hl-rect[data-id="${id}"]`).forEach((d) => d.classList.add("hover"));
}

// Position the floating toolbar near `anchor` (a client rect), kept inside the
// viewer. It lives inside #viewer (so it survives fullscreen), which is its
// positioned ancestor and clips overflow. Flips below if there's no room above.
function placeToolbar(anchor) {
  const toolbar = $("#selectionToolbar");
  const viewerRect = $("#viewer").getBoundingClientRect();
  toolbar.classList.remove("hidden");
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight, pad = 8;
  let left = anchor.left - viewerRect.left;
  let top = anchor.top - viewerRect.top - th - 8;
  if (top < pad) top = anchor.bottom - viewerRect.top + 8;
  left = Math.max(pad, Math.min(left, viewerRect.width - tw - pad));
  top = Math.max(pad, Math.min(top, viewerRect.height - th - pad));
  toolbar.style.left = left + "px";
  toolbar.style.top = top + "px";
}

// --------------------------------------------------------- text selection
function onSelection(e) {
  const sel = window.getSelection();
  const toolbar = $("#selectionToolbar");
  if (e && toolbar.contains(e.target)) return; // clicking a toolbar button
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    // A plain click on a highlight offers to remove it.
    const pt = e ? pagePointOf(e) : null;
    const hits = pt ? highlightsHit(pt.n, [pt.rect]) : [];
    state.pendingSelection = null;
    state.pendingRemoval = hits.length ? { ids: hits.map((h) => h.id), page: pt.n } : null;
    if (!hits.length) {
      toolbar.classList.add("hidden");
      return;
    }
    toolbar.classList.add("remove-only");
    toolbar.querySelector('[data-action="unhighlight"]').classList.remove("hidden");
    placeToolbar({ left: e.clientX, top: e.clientY, bottom: e.clientY });
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

  // If the selection covers existing highlights, offer to remove them too.
  const hits = highlightsHit(anchorPage, rects);
  state.pendingRemoval = hits.length ? { ids: hits.map((h) => h.id), page: anchorPage } : null;
  toolbar.classList.remove("remove-only");
  toolbar.querySelector('[data-action="unhighlight"]').classList.toggle("hidden", !hits.length);

  // Position the toolbar just above the end of the selection.
  placeToolbar(clientRects[clientRects.length - 1] || range.getBoundingClientRect());
}

async function removeHighlights() {
  const r = state.pendingRemoval;
  if (!r) return;
  clearSelection();
  for (const id of r.ids) await deleteHighlight(id, r.page);
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
  await switchToDocChat();
  appendMessage("user", "Summarize this passage:\n\n" + truncate(s.text, 300));
  const thinking = appendThinking();
  try {
    const res = await api(`/api/papers/${state.currentPaperId}/summarize-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "", selection: s.text }),
    });
    thinking.remove();
    addReplyControls(appendMessage("assistant", res.summary), res.message_uid, 0);
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
  let input;
  if (isFullscreen()) {
    openFsChat();
    leaveFsThread();
    input = $("#fsChatInput");
  } else {
    switchToDocChat();
    input = $("#chatInput");
  }
  input.value = `About this passage: "${truncate(s.text, 200)}" — `;
  input.dataset.selection = s.text;
  // Clear the PDF selection *before* focusing: removeAllRanges() would
  // otherwise pull the caret back out of the input.
  clearSelection();
  focusAtEnd(input);
}

// Focus a text box with the caret after its prefilled text. Deferred so it
// runs after the mouseup/selection handlers triggered by the toolbar click.
function focusAtEnd(input) {
  setTimeout(() => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    input.scrollTop = input.scrollHeight;
  }, 30);
}

function clearSelection() {
  window.getSelection().removeAllRanges();
  $("#selectionToolbar").classList.add("hidden");
  state.pendingSelection = null;
  state.pendingRemoval = null;
}

// ---------------------------------------------------------------- chat
// The side panel shows either the main chat, or one *thread*: a separate
// conversation branching off a single assistant answer (state.thread). Thread
// replies never appear in the main chat — each answer just shows a quiet
// "N replies" link — so the main conversation stays uncluttered.
// Show this paper's main chat. If a thread or the library chat was showing,
// the document chat is reloaded first; await it before appending messages.
async function switchToDocChat() {
  const reload = state.thread || state.chatMode !== "doc";
  state.chatMode = "doc";
  $("#chatTitle").textContent = state.currentTitle;
  setActiveTab("chat");
  if (reload && state.currentPaperId) await loadDocChat();
  else resetThreadUi();
}

function chatBase() {
  return state.chatMode === "doc"
    ? `/api/papers/${state.currentPaperId}/chat`
    : "/api/library/chat";
}

async function loadDocChat() {
  resetThreadUi();
  const msgs = await api(`/api/papers/${state.currentPaperId}/chat`);
  renderMessages(msgs);
}

async function loadLibraryChat() {
  resetThreadUi();
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
  for (const m of msgs) {
    const div = appendMessage(m.role, m.content, false);
    if (m.role === "assistant") addReplyControls(div, m.uid, m.reply_count || 0);
  }
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

// Footer on a main-chat answer: "N replies" (when a thread exists) and a
// Reply button that only appears on hover (always shown on touch screens).
// `open(quote)` opens the thread — in the side panel by default, or in the
// fullscreen bubble for answers shown there.
function addReplyControls(div, uid, replyCount, open = (q) => openThread(uid, q)) {
  if (!uid) return;
  div.dataset.uid = uid;
  const foot = document.createElement("div");
  foot.className = "msg-foot";
  if (replyCount > 0) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "thread-link";
    link.textContent = replyCount === 1 ? "1 reply" : `${replyCount} replies`;
    link.addEventListener("click", () => open(""));
    foot.appendChild(link);
  }
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "msg-reply";
  reply.title = "Reply in a thread (or select part of the answer first)";
  reply.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5 5.5 5.5 0 0 1 14.5 20H11"/></svg><span>Reply</span>';
  reply.addEventListener("click", () => open(selectedTextIn(div)));
  foot.appendChild(reply);
  div.appendChild(foot);
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

// ---- threads
async function openThread(parentUid, quote = "") {
  hideReplyPill();
  const already = state.thread && state.thread.uid === parentUid;
  state.thread = { uid: parentUid, quote: quote || (already ? state.thread.quote : "") };
  $("#threadBar").classList.remove("hidden");
  $("#chatInput").placeholder = "Reply in thread…";
  setReplyQuote(state.thread.quote);
  setActiveTab("chat");
  const box = $("#chatMessages");
  if (!already) box.innerHTML = '<div class="chat-empty">Loading thread…</div>';
  try {
    const t = await api(`${chatBase()}/thread/${parentUid}`);
    if (!state.thread || state.thread.uid !== parentUid) return;  // navigated away
    renderThread(t);
  } catch (e) {
    box.innerHTML = '<div class="chat-empty"></div>';
    box.firstChild.textContent = "Couldn't load this thread: " + e.message;
  }
  focusAtEnd($("#chatInput"));
}

// Renders a thread into `box` (side panel by default, or the fullscreen
// bubble with its own message class and append function).
function renderThread(t, box = $("#chatMessages"), msgClass = "msg", appendReply = appendThreadMessage) {
  box.innerHTML = "";

  // The answer being replied to, collapsed to a few lines until expanded.
  const anchor = document.createElement("div");
  anchor.className = "thread-anchor";
  if (t.prompt) {
    const q = document.createElement("div");
    q.className = "thread-prompt";
    q.textContent = "You asked: " + truncate(t.prompt.content.replace(/\s+/g, " "), 140);
    anchor.appendChild(q);
  }
  const body = document.createElement("div");
  body.className = `${msgClass} assistant md thread-anchor-body collapsed`;
  body.innerHTML = renderMarkdown(t.parent.content);
  anchor.appendChild(body);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "thread-more";
  more.textContent = "Show full answer";
  more.addEventListener("click", () => {
    const collapsed = body.classList.toggle("collapsed");
    more.textContent = collapsed ? "Show full answer" : "Show less";
  });
  anchor.appendChild(more);
  box.appendChild(anchor);
  // Only offer "Show full answer" when there is actually more to show.
  requestAnimationFrame(() => {
    if (body.scrollHeight <= body.clientHeight + 4) {
      body.classList.remove("collapsed");
      more.remove();
    }
  });

  const divider = document.createElement("div");
  divider.className = "thread-divider";
  divider.textContent = t.messages.length
    ? `${t.messages.length} ${t.messages.length === 1 ? "reply" : "replies"}`
    : "Start the thread — ask a follow-up about this answer";
  box.appendChild(divider);

  for (const m of t.messages) appendReply(m.role, m.content, m.quote, false);
  box.scrollTop = t.messages.length ? box.scrollHeight : 0;
}

function appendThreadMessage(role, content, quote, scroll = true) {
  return addQuote(appendMessage(role, content, scroll), quote);
}

// Show the quoted part of an answer at the top of a thread reply.
function addQuote(div, quote) {
  if (quote) {
    const q = document.createElement("div");
    q.className = "msg-quote";
    q.textContent = truncate(quote.replace(/\s+/g, " "), 220);
    div.prepend(q);
  }
  return div;
}

// Back to the main chat, scrolled to the answer the thread hangs off.
async function leaveThread({ reload = true } = {}) {
  const uid = state.thread && state.thread.uid;
  resetThreadUi();
  if (!reload) return;
  if (state.chatMode === "doc" && state.currentPaperId) await loadDocChat();
  else if (state.chatMode === "library") await loadLibraryChat();
  const el = uid && $("#chatMessages").querySelector(`[data-uid="${uid}"]`);
  if (el) el.scrollIntoView({ block: "center" });
}

function resetThreadUi() {
  state.thread = null;
  hideReplyPill();
  $("#threadBar").classList.add("hidden");
  $("#chatInput").placeholder = "Ask a question…";
  setReplyQuote("");
}

// The "Replying to: …" strip above the input; × drops the quote.
function setReplyQuote(text) {
  if (state.thread) state.thread.quote = text || "";
  fillQuoteStrip($("#replyQuote"), text);
}

function fillQuoteStrip(strip, text) {
  strip.classList.toggle("hidden", !text);
  strip.querySelector(".rq-text").textContent = text ? truncate(text.replace(/\s+/g, " "), 160) : "";
}

function selectedTextIn(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !el.contains(sel.anchorNode)) return "";
  return sel.toString().trim();
}

// Selecting text inside an AI answer pops a small "Reply" pill next to it:
// in the main chat it opens that answer's thread quoting the selection; inside
// a thread it just sets the quote for the next reply. Works in the side panel
// and in the fullscreen bubble.
function onChatSelection() {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
  const node = text && sel.anchorNode;
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const msg = el && el.closest && el.closest(
    "#chatMessages .msg.assistant:not(.thinking), #fsChatBody .fs-msg.assistant:not(.thinking)"
  );
  if (!msg || !msg.contains(sel.focusNode)) return hideReplyPill();
  const inFs = !!msg.closest("#fsChatBody");
  const inThread = inFs ? !!state.fsThread : !!state.thread;
  const uid = msg.dataset.uid;
  if (!inThread && !uid) return hideReplyPill();

  const pill = $("#chatReplyPill");
  const rects = sel.getRangeAt(0).getClientRects();
  const last = rects[rects.length - 1];
  if (!last) return hideReplyPill();
  pill.style.left = Math.min(last.right + 6, window.innerWidth - 90) + "px";
  pill.style.top = Math.max(last.top - 34, 8) + "px";
  pill.classList.remove("hidden");
  pill.onclick = () => {
    if (inThread) {
      if (inFs) setFsReplyQuote(text); else setReplyQuote(text);
      hideReplyPill();
      window.getSelection().removeAllRanges();
      focusAtEnd($(inFs ? "#fsChatInput" : "#chatInput"));
    } else if (inFs) {
      openFsThread(uid, text);
    } else {
      openThread(uid, text);
    }
  };
}

function hideReplyPill() {
  const pill = $("#chatReplyPill");
  if (pill) pill.classList.add("hidden");
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

  const thread = state.thread;
  const quote = thread ? thread.quote : "";
  const selection = input.dataset.selection || null;
  if (thread) {
    const divider = $("#chatMessages .thread-divider");
    if (divider && !$("#chatMessages .msg:not(.thread-anchor-body)")) divider.textContent = "Replies";
    appendThreadMessage("user", question, quote);
    setReplyQuote("");
  } else {
    appendMessage("user", question);
  }
  input.value = "";
  delete input.dataset.selection;
  const thinking = appendThinking();

  const body = { question };
  if (state.chatMode === "doc") body.selection = selection;
  if (thread) Object.assign(body, { parent_uid: thread.uid, quote: quote || null });

  try {
    const res = await api(chatBase(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    thinking.remove();
    // Left the thread (or entered another) while waiting: it's saved, and
    // shows up next time that thread is opened.
    if (state.thread !== thread) return;
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
    if (!thread) addReplyControls(msg, res.message_uid, 0);
  } catch (e) {
    thinking.remove();
    if (state.thread !== thread) return;
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
  await switchToDocChat();
  appendMessage("user", userLabel);
  const thinking = appendThinking();
  try {
    const res = await api(endpoint, { method: "POST" });
    thinking.remove();
    addReplyControls(appendMessage("assistant", pick(res)), res.message_uid, 0);
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

// ------------------------------------------------------- Peter explains
// Plays a parody audio clip: Peter Griffin explains the paper to Stewie (a
// Gemini-written dialogue performed by Gemini TTS). One clip is cached per
// paper on the server, so replays are instant; "New take" regenerates.
//
// Making a clip takes a minute or more, so it runs in the background: open
// another paper or screen and it keeps going. When it finishes you get the
// player back if you're still on that paper, or a "ready" notice if not.
let peterRequest = 0;  // which request the player is currently showing
const peterJobs = new Map();  // paperId -> pending api() promise

// True when the player is showing (or waiting for) this paper's clip.
function peterShowing(paperId, req) {
  return req === peterRequest && state.currentPaperId === paperId &&
    !$("#peterPlayer").classList.contains("hidden");
}

async function peterExplains(regenerate) {
  const paperId = state.currentPaperId;
  if (!paperId || !requireAi()) return;
  const req = ++peterRequest;
  const audio = $("#peterAudio");
  audio.pause();
  stopPeterVideo();
  $("#peterPlayer").classList.remove("hidden");
  audio.classList.add("hidden");
  $("#peterActions").classList.add("hidden");
  $("#peterTranscript").classList.add("hidden");
  $("#peterTranscriptBtn").textContent = "Transcript";
  $("#peterRegenBtn").disabled = true;

  let job = peterJobs.get(paperId);
  if (!job) {
    job = api(
      `/api/papers/${paperId}/peter` + (regenerate ? "?regenerate=true" : ""),
      { method: "POST" }
    );
    peterJobs.set(paperId, job);
    job.finally(() => peterJobs.delete(paperId)).catch(() => {});
    // Finished while the user was elsewhere: tell them.
    job.then(
      (res) => { if (!res.cached && !peterWatching(paperId)) showPeterNotice(paperId, true); },
      (e) => { if (!peterWatching(paperId)) showPeterNotice(paperId, false, e.message); },
    );
    setPeterStatus(regenerate
      ? "Peter's taking another crack at it… (about 30–90 s). You can keep reading or open another paper; it'll keep going."
      : "Peter's reading the paper… (the first time takes about 30–90 s). You can keep reading or open another paper; it'll keep going.", true);
  } else {
    setPeterStatus("Still working on it… (you can leave; it'll keep going)", true);
  }

  try {
    const res = await job;
    if (!peterShowing(paperId, req)) return;
    renderPeterTranscript(res.transcript);
    setPeterStatus("");
    audio.src = res.audio_url;
    audio.classList.remove("hidden");
    $("#peterActions").classList.remove("hidden");
    setPeterSubtitles(res.lines);
    startPeterVideo();
    // Don't start talking over a screen the user can't see.
    if (state.view === "reader") audio.play().catch(() => {});  // autoplay may be blocked
  } catch (e) {
    if (!peterShowing(paperId, req)) return;
    setPeterStatus("Couldn't make the clip: " + e.message);
    $("#peterActions").classList.remove("hidden");
  } finally {
    if (req === peterRequest) $("#peterRegenBtn").disabled = false;
  }
}

// The user is looking at this paper's player in the reader right now.
function peterWatching(paperId) {
  return state.view === "reader" && state.currentPaperId === paperId &&
    !$("#peterPlayer").classList.contains("hidden");
}

let peterNoticeTimer = null;
function showPeterNotice(paperId, ok, error) {
  const p = state.papers.find((x) => x.id === paperId);
  const title = p ? `“${truncate(p.title, 60)}”` : "your paper";
  $("#peterNoticeText").textContent = ok
    ? `Peter's explanation of ${title} is ready.`
    : `Couldn't make Peter's clip for ${title}: ${error}`;
  $("#peterNoticeOpen").textContent = ok ? "Listen" : "Open paper";
  $("#peterNoticeOpen").onclick = () => {
    hidePeterNotice();
    if (!state.papers.some((x) => x.id === paperId)) return;  // deleted meanwhile
    setView("reader");
    if (state.currentPaperId !== paperId) openPaper(paperId);
    if (ok) peterExplains(false);  // cached now, so it's instant
  };
  $("#peterNotice").classList.remove("hidden");
  clearTimeout(peterNoticeTimer);
  peterNoticeTimer = setTimeout(hidePeterNotice, 20000);
}

function hidePeterNotice() {
  clearTimeout(peterNoticeTimer);
  $("#peterNotice").classList.add("hidden");
}

// ------------------------------------------------ Peter's background video
// While the clip plays, a muted video from the videos/ folder plays alongside
// it: a random file from a random point, following the audio's play/pause.
// When one video ends, another random one takes over.
let peterVideos = null;  // file names, fetched once per page load

async function startPeterVideo() {
  const video = $("#peterVideo");
  const req = peterRequest;
  try {
    if (!peterVideos) peterVideos = (await api("/api/videos")).videos || [];
  } catch (e) { peterVideos = []; }
  if (req !== peterRequest || !peterVideos.length) return;  // player closed meanwhile
  const name = peterVideos[Math.floor(Math.random() * peterVideos.length)];
  video.onloadedmetadata = () => {
    // Somewhere that leaves at least 20 s to play (or the start of a short one).
    const room = (video.duration || 0) - 20;
    if (room > 0 && isFinite(room)) video.currentTime = Math.random() * room;
    if (!$("#peterAudio").paused) video.play().catch(() => {});
  };
  video.onended = () => startPeterVideo();
  video.onerror = () => {  // unplayable file (e.g. an unsupported codec): try another
    peterVideos = peterVideos.filter((v) => v !== name);
    startPeterVideo();
  };
  video.src = "/api/videos/" + encodeURIComponent(name);
  video.classList.remove("hidden");
  showPeterStage();
}

function showPeterStage() {
  $("#peterStage").classList.remove("hidden");
  $("#peterPlayer").classList.add("has-stage");
}

function stopPeterVideo() {
  const video = $("#peterVideo");
  video.onloadedmetadata = video.onended = video.onerror = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.classList.add("hidden");
  clearPeterSubs();
  $("#peterStage").classList.add("hidden");
  $("#peterPlayer").classList.remove("has-stage");
}

function setPeterExpanded(on) {
  $("#peterPlayer").classList.toggle("expanded", on);
  $("#peterExpand").title = on ? "Shrink" : "Expand";
}

// ------------------------------------------------- Peter's subtitles
// Big captions over the video, a few words at a time, with the word being
// spoken enlarged. Word timings come from the server (estimated from the
// audio's pauses; see voice.py) and follow the audio's clock.
const peterSubs = { chunks: [], shown: -1, raf: 0 };

function setPeterSubtitles(lines) {
  const chunks = [];
  for (const line of lines || []) {
    let cur = null;
    for (const w of line.words || []) {
      if (!cur) chunks.push(cur = { who: line.who, words: [] });
      cur.words.push(w);
      const n = cur.words.length;
      if (n >= 5 || /[.!?…]$/.test(w.w) || (n >= 3 && /[,;:—]$/.test(w.w))) cur = null;
    }
  }
  for (const c of chunks) c.start = c.words[0].s;
  chunks.forEach((c, i) => {
    const next = chunks[i + 1];
    c.until = Math.min(next ? next.start : Infinity, c.words[c.words.length - 1].e + 0.6);
  });
  clearPeterSubs();
  peterSubs.chunks = chunks;
  if (chunks.length) showPeterStage();
  renderPeterSubs();
}

function clearPeterSubs() {
  cancelAnimationFrame(peterSubs.raf);
  peterSubs.chunks = [];
  peterSubs.shown = -1;
  $("#peterSubs").innerHTML = "";
}

function renderPeterSubs() {
  const t = $("#peterAudio").currentTime;
  const chunks = peterSubs.chunks;
  const i = chunks.findIndex((c) => t >= c.start && t < c.until);
  const box = $("#peterSubs");
  if (i !== peterSubs.shown) {  // a new chunk: rebuild the caption
    peterSubs.shown = i;
    box.innerHTML = "";
    if (i >= 0) {
      const who = document.createElement("span");
      who.className = "who " + chunks[i].who.toLowerCase();
      who.textContent = chunks[i].who;
      const line = document.createElement("span");
      line.className = "line";
      for (const w of chunks[i].words) {
        const el = document.createElement("span");
        el.className = "w";
        el.textContent = w.w;
        line.appendChild(el);
      }
      box.append(who, line);
    }
  }
  if (i < 0) return;
  let active = -1;
  chunks[i].words.forEach((w, k) => { if (t >= w.s) active = k; });
  box.querySelectorAll(".w").forEach((el, k) => el.classList.toggle("on", k === active));
}

function peterSubsLoop() {
  renderPeterSubs();
  peterSubs.raf = requestAnimationFrame(peterSubsLoop);
}

function setPeterStatus(text, loading = false) {
  const el = $("#peterStatus");
  el.innerHTML = "";
  if (!text) return;
  if (loading) {
    const spin = document.createElement("span");
    spin.className = "disc-spinner";
    el.appendChild(spin);
  }
  const msg = document.createElement("span");
  msg.textContent = text;
  el.appendChild(msg);
}

function renderPeterTranscript(script) {
  const box = $("#peterTranscript");
  box.innerHTML = "";
  for (const line of (script || "").split("\n")) {
    const m = line.match(/^(Peter|Stewie):\s*(.*)$/);
    if (!m) continue;
    const p = document.createElement("p");
    const who = document.createElement("strong");
    who.textContent = m[1] + ": ";
    p.append(who, document.createTextNode(m[2]));
    box.appendChild(p);
  }
}

// Closes the player. A clip still being made keeps going (see peterJobs).
function hidePeter() {
  peterRequest++;
  const audio = $("#peterAudio");
  audio.pause();
  audio.removeAttribute("src");
  stopPeterVideo();
  $("#peterPlayer").classList.add("hidden");
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
    ["#summarizeBtn", "#prereadingBtn", "#peterBtn", "#deletePaperBtn", "#zoomIn", "#zoomOut", "#fullscreenBtn"].forEach((s) => ($(s).disabled = true));
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
  if (!fs) {
    $("#fsChatPopup").classList.add("hidden");
    hideReplyPill();
    if (state.chatMode === "doc" && state.currentPaperId && !state.thread) loadDocChat();
  }
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
// With body.parent_uid it's a reply in the bubble's open thread; anything
// else (summaries, new questions) goes to the main conversation.
async function fsRun(userText, endpoint, body, pick) {
  if (!state.currentPaperId || !requireAi()) return;
  openFsChat();
  if (state.fsThread && !body.parent_uid) leaveFsThread();
  const thread = state.fsThread;
  if (thread) {
    const divider = $("#fsChatBody .thread-divider");
    if (divider && !thread.count) divider.textContent = "Replies";
    addQuote(appendFsMessage("user", userText), body.quote);
  } else {
    appendFsMessage("user", userText);
  }
  const thinking = appendFsMessage("assistant thinking", "Thinking…");
  try {
    const res = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    thinking.remove();
    if (state.fsThread !== thread) return;  // left/entered a thread meanwhile; it's saved
    const div = appendFsMessage("assistant", pick(res));
    if (thread) thread.count += 2;
    else addReplyControls(div, res.message_uid, 0, (q) => openFsThread(res.message_uid, q));
  } catch (e) {
    thinking.remove();
    if (state.fsThread !== thread) return;
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
  const body = { question, selection };
  if (state.fsThread) {
    Object.assign(body, { parent_uid: state.fsThread.uid, quote: state.fsThread.quote || null });
    setFsReplyQuote("");
  }
  fsRun(question, `/api/papers/${state.currentPaperId}/chat`, body, (res) => res.answer);
}

// The bubble shows one thread at a time in place of its conversation; the
// conversation's nodes are set aside (state.fsMainNodes) and put back on Back.
async function openFsThread(parentUid, quote = "") {
  hideReplyPill();
  openFsChat();
  const box = $("#fsChatBody");
  const already = state.fsThread && state.fsThread.uid === parentUid;
  if (!state.fsThread) state.fsMainNodes = [...box.childNodes];
  state.fsThread = {
    uid: parentUid,
    quote: quote || (already ? state.fsThread.quote : ""),
    count: already ? state.fsThread.count : 0,
  };
  $("#fsThreadBack").classList.remove("hidden");
  $("#fsChatHeadTitle").textContent = "Thread";
  $("#fsChatInput").placeholder = "Reply in thread…";
  setFsReplyQuote(state.fsThread.quote);
  if (!already) box.innerHTML = '<div class="fs-chat-empty">Loading thread…</div>';
  try {
    const t = await api(`/api/papers/${state.currentPaperId}/chat/thread/${parentUid}`);
    if (!state.fsThread || state.fsThread.uid !== parentUid) return;
    state.fsThread.count = t.messages.length;
    renderThread(t, box, "fs-msg", (role, content, q, scroll) =>
      addQuote(appendFsMessage(role, content), q));
  } catch (e) {
    box.innerHTML = '<div class="fs-chat-empty"></div>';
    box.firstChild.textContent = "Couldn't load this thread: " + e.message;
  }
  focusAtEnd($("#fsChatInput"));
}

function leaveFsThread() {
  const t = state.fsThread;
  if (!t) return;
  state.fsThread = null;
  hideReplyPill();
  const box = $("#fsChatBody");
  box.replaceChildren(...(state.fsMainNodes || []));
  state.fsMainNodes = null;
  $("#fsThreadBack").classList.add("hidden");
  $("#fsChatHeadTitle").textContent = "Ask about this paper";
  $("#fsChatInput").placeholder = "Ask a question…";
  setFsReplyQuote("");
  ensureFsPlaceholder();
  // Refresh the answer's "N replies" link and bring it back into view.
  const parent = box.querySelector(`[data-uid="${t.uid}"]`);
  if (parent) {
    const foot = parent.querySelector(":scope > .msg-foot");
    if (foot) foot.remove();
    addReplyControls(parent, t.uid, t.count, (q) => openFsThread(t.uid, q));
    parent.scrollIntoView({ block: "center" });
  }
}

function setFsReplyQuote(text) {
  if (state.fsThread) state.fsThread.quote = text || "";
  fillQuoteStrip($("#fsReplyQuote"), text);
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
// =====================================================================
// Screens (Dashboard / Folders / Bookmarks)
//
// The rail switches `document.body.dataset.view`. CSS hides #sidebar,
// #viewer and #panel for the browse views and collapses #app to two
// columns, so a screen takes the whole area beside the rail. Because the
// inactive screens are display:none, grid auto-placement ignores them and
// the reader layout is left untouched.
// =====================================================================

const SCREENS = {
  dashboard: { el: "#screenDashboard", render: renderDashboard },
  folders:   { el: "#screenFolders",   render: renderFoldersScreen },
  bookmarks: { el: "#screenBookmarks", render: renderBookmarksScreen },
};

function setView(name) {
  if (name !== "reader" && !SCREENS[name]) name = "reader";
  state.view = name;
  document.body.dataset.view = name;

  for (const key of Object.keys(SCREENS)) {
    $(SCREENS[key].el).classList.toggle("hidden", key !== name);
  }
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.classList.contains("rail-btn") && b.dataset.view === name);
  });

  if (SCREENS[name]) SCREENS[name].render();
}

// Opening a paper from any screen drops you back into the reader.
function openPaperFromScreen(id) {
  setView("reader");
  openPaper(id);
}

function paperCardIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5L14 3Z"/><path d="M13.8 3.2v4.3h4.4M8.5 12.5h7M8.5 16h4.5"/></svg>';
}

function bookmarkGlyph(filled) {
  return '<svg viewBox="0 0 24 24" fill="' + (filled ? "currentColor" : "none") +
    '" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4-6.5 4V5.5a1 1 0 0 1 1-1Z"/></svg>';
}

// A card that opens on click/Enter, drags as `payload` ("paper:ID" /
// "folder:ID"), and has a ⋯ menu (also on right-click). A div rather than a
// <button> because it contains the menu button.
function browseCard(topHtml, payload, onOpen, openMenuAt) {
  const card = document.createElement("div");
  card.className = "browse-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.innerHTML =
    '<div class="card-top">' + topHtml +
    '<button type="button" class="card-menu" title="Options">' + ICONS.kebab + '</button></div>' +
    '<span class="card-name"></span><span class="card-meta"></span>';
  card.onclick = onOpen;
  card.addEventListener("keydown", (e) => {
    if (e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); }
  });
  const menuBtn = card.querySelector(".card-menu");
  menuBtn.onclick = (e) => { e.stopPropagation(); openMenuAt(menuBtn); };
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenuAt(menuBtn); });
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", payload);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
    closeMenu();
  });
  card.addEventListener("dragend", () => { card.classList.remove("dragging"); clearAllDragOver(); });
  return card;
}

// One paper card, shared by the Folders and Bookmarks screens.
function paperCard(p) {
  const card = browseCard(
    '<span class="card-icon">' + paperCardIcon() + '</span><span class="card-spacer"></span>' +
    (p.bookmarked ? '<span class="card-bm" title="Bookmarked">' + bookmarkGlyph(true) + '</span>' : ''),
    "paper:" + p.id,
    () => openPaperFromScreen(p.id),
    (anchor) => openPaperMenu(anchor, p),
  );
  card.querySelector(".card-name").textContent = p.title;
  card.querySelector(".card-meta").textContent =
    (p.num_pages || 0) + " pages · " + formatShortDate(p.uploaded_at);
  return card;
}

function folderCard(node) {
  const count = subtreePaperCount(node, state.papers);
  const card = browseCard(
    '<span class="card-icon">' + ICONS.folder + '</span><span class="card-spacer"></span>',
    "folder:" + node.id,
    () => { state.folderCursor = node.id; renderFoldersScreen(); },
    (anchor) => openFolderMenu(anchor, node),
  );
  card.querySelector(".card-name").textContent = node.name;
  card.querySelector(".card-meta").textContent = count + (count === 1 ? " paper" : " papers");
  addDropHandlers(card, node.id);  // drop papers/folders onto it to move them in
  return card;
}

function sectionLabel(text) {
  const h = document.createElement("p");
  h.className = "grid-label";
  h.textContent = text;
  return h;
}

function emptyNote(text) {
  const d = document.createElement("div");
  d.className = "screen-empty";
  d.textContent = text;
  return d;
}

// ------------------------------------------------------------- Folders
// A directory browser: folders you drill into, papers you open. Items can be
// dragged onto a folder card or breadcrumb, or moved from their ⋯ menu.
function renderFoldersScreen() {
  const body = $("#foldersBody");
  const crumbHost = $("#foldersCrumb");
  body.innerHTML = "";
  crumbHost.innerHTML = "";

  const byId = new Map(state.folders.map((f) => [f.id, f]));
  const cursor = state.folderCursor;

  // If the folder we were in was deleted elsewhere, fall back to the top.
  if (cursor != null && !byId.has(cursor)) state.folderCursor = null;

  const trail = [];
  let cur = state.folderCursor != null ? byId.get(state.folderCursor) : null;
  let guard = 0;
  while (cur && guard++ < 100) {
    trail.unshift(cur);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }

  const crumbs = document.createElement("div");
  crumbs.className = "crumbs";
  const mkCrumb = (label, id, isCurrent) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb" + (isCurrent ? " current" : "");
    b.textContent = label;
    if (!isCurrent) b.onclick = () => { state.folderCursor = id; renderFoldersScreen(); };
    addDropHandlers(b, id);  // drop onto a crumb to move an item up
    return b;
  };
  crumbs.appendChild(mkCrumb("All papers", null, trail.length === 0));
  trail.forEach((f, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    crumbs.appendChild(sep);
    crumbs.appendChild(mkCrumb(f.name, f.id, i === trail.length - 1));
  });
  crumbHost.appendChild(crumbs);

  const { roots } = buildFolderTree();
  let childFolders;
  if (state.folderCursor == null) {
    childFolders = roots;
  } else {
    const find = (nodes) => {
      for (const n of nodes) {
        if (n.id === state.folderCursor) return n;
        const hit = find(n.children || []);
        if (hit) return hit;
      }
      return null;
    };
    childFolders = (find(roots) || { children: [] }).children;
  }
  const papersHere = state.papers.filter((p) =>
    state.folderCursor == null ? !p.folder_id : p.folder_id === state.folderCursor
  );

  if (!childFolders.length && !papersHere.length) {
    body.appendChild(emptyNote(
      state.folderCursor == null
        ? "No papers yet. Upload one from the reader to get started."
        : "This folder is empty. Drag papers onto it, or use a paper's ⋯ menu › Move to."
    ));
    return;
  }

  if (childFolders.length) {
    body.appendChild(sectionLabel(state.folderCursor == null ? "Folders" : "Subfolders"));
    const grid = document.createElement("div");
    grid.className = "card-grid";
    childFolders.forEach((n) => grid.appendChild(folderCard(n)));
    body.appendChild(grid);
  }
  if (papersHere.length) {
    body.appendChild(sectionLabel(state.folderCursor == null ? "Uncategorized papers" : "Papers"));
    const grid = document.createElement("div");
    grid.className = "card-grid";
    papersHere.forEach((p) => grid.appendChild(paperCard(p)));
    body.appendChild(grid);
  }
}

// ----------------------------------------------------------- Bookmarks
function renderBookmarksScreen() {
  const body = $("#bookmarksBody");
  body.innerHTML = "";
  const marked = state.papers.filter((p) => p.bookmarked);
  if (!marked.length) {
    body.appendChild(emptyNote(
      "No bookmarks yet. Open a paper and press the bookmark button in the header, or use a paper's ⋯ menu."
    ));
    return;
  }
  const grid = document.createElement("div");
  grid.className = "card-grid";
  marked.forEach((p) => grid.appendChild(paperCard(p)));
  body.appendChild(grid);
}

// ----------------------------------------------------------- Dashboard
// Library counts, semantic arXiv search and recommendations. The markup is
// static in index.html so a re-render (e.g. after an upload) never wipes the
// search box; only the stats and the two result lists are rebuilt.
function renderDashboard() {
  renderDashStats();
  renderArxivList("search");
  renderArxivList("recs");
  if (!discover.interestsLoaded) loadInterests();
  // Recommendations load lazily the first time the dashboard is shown.
  if (!discover.recs.data && !discover.recs.loading && !discover.recs.error) loadRecommendations(false);
}

function renderDashStats() {
  const row = $("#dashStats");
  row.innerHTML = "";
  const stats = [
    ["Papers", state.papers.length],
    ["Folders", state.folders.length],
    ["Bookmarked", state.papers.filter((p) => p.bookmarked).length],
    ["Pages", state.papers.reduce((n, p) => n + (p.num_pages || 0), 0)],
  ];
  for (const pair of stats) {
    const cell = document.createElement("div");
    cell.className = "stat";
    cell.innerHTML = '<div class="stat-label"></div><div class="stat-value"></div>';
    cell.querySelector(".stat-label").textContent = pair[0];
    cell.querySelector(".stat-value").textContent = pair[1];
    row.appendChild(cell);
  }
}

// -------------------------------------------------------- arXiv discovery
const discover = {
  // mode: "semantic" (Gemini, on submit) or "exact" (live as you type)
  search: { loading: false, error: null, data: null, query: "", mode: "semantic", seq: 0 },
  recs:   { loading: false, error: null, data: null },
  adding: new Set(),     // arxiv ids currently being downloaded/ingested
  cardErrors: {},        // arxiv id -> last add error
  expanded: new Set(),   // arxiv ids whose abstract is expanded
  interests: [],         // typed-in interests (saved in storage/interests.json)
  interestsLoaded: false,
};

const DISCOVER_HOSTS = {
  search: { status: "#arxivSearchStatus", list: "#arxivSearchResults" },
  recs:   { status: "#recsStatus",        list: "#recsResults" },
};

const SEARCH_MODES = {
  semantic: {
    sub: "Describe what you're looking for in plain language. Recent papers rank higher.",
    placeholder: "e.g. neural network decoders for surface-code quantum error correction",
  },
  exact: {
    sub: "Papers whose title, abstract or authors contain exactly what you type. Updates as you type.",
    placeholder: "e.g. surface code",
  },
};

function setSearchMode(mode) {
  if (!SEARCH_MODES[mode]) mode = "semantic";
  const s = discover.search;
  const changed = s.mode !== mode;
  s.mode = mode;
  try { localStorage.setItem("rpm.searchMode", mode); } catch (e) {}
  document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#arxivSearchSub").textContent = SEARCH_MODES[mode].sub;
  $("#arxivSearchInput").placeholder = SEARCH_MODES[mode].placeholder;
  $("#arxivSearchBtn").classList.toggle("hidden", mode === "exact");  // exact runs as you type
  if (!changed) return;
  clearTimeout(exactTimer);
  s.seq++;  // drop any response still on its way
  Object.assign(s, { loading: false, error: null, data: null });
  $("#arxivSearchBtn").disabled = false;
  renderArxivList("search");
  if (mode === "exact") runExactSearch();
}

// ---- exact text: live, debounced; only the newest response is shown
let exactTimer = null;
function scheduleExactSearch() {
  if (discover.search.mode !== "exact") return;
  clearTimeout(exactTimer);
  exactTimer = setTimeout(runExactSearch, 350);
}

async function runExactSearch() {
  clearTimeout(exactTimer);
  const s = discover.search;
  const q = $("#arxivSearchInput").value.trim();
  const seq = ++s.seq;
  if (q.replace(/[^a-z0-9]/gi, "").length < 2) {
    Object.assign(s, { loading: false, error: null, data: null, query: q });
    renderArxivList("search");
    return;
  }
  Object.assign(s, { loading: true, error: null, query: q });
  renderArxivList("search");
  try {
    const data = await api("/api/arxiv/search?mode=exact&q=" + encodeURIComponent(q));
    if (seq !== s.seq) return;  // the user typed more; a newer search owns the UI
    if (!data.stale) s.data = data;
  } catch (err) {
    if (seq !== s.seq) return;
    s.error = err.message || String(err);
  }
  s.loading = false;
  renderArxivList("search");
}

async function runArxivSearch(e) {
  if (e) e.preventDefault();
  if (discover.search.mode === "exact") return runExactSearch();
  const q = $("#arxivSearchInput").value.trim();
  if (!q || discover.search.loading) return;
  Object.assign(discover.search, { loading: true, error: null, query: q });
  $("#arxivSearchBtn").disabled = true;
  renderArxivList("search");
  try {
    discover.search.data = await api("/api/arxiv/search?q=" + encodeURIComponent(q));
  } catch (err) {
    discover.search.error = err.message || String(err);
  } finally {
    discover.search.loading = false;
    $("#arxivSearchBtn").disabled = false;
    renderArxivList("search");
  }
}

async function loadRecommendations(refresh) {
  if (discover.recs.loading) return;
  Object.assign(discover.recs, { loading: true, error: null });
  $("#recsRefreshBtn").disabled = true;
  renderArxivList("recs");
  try {
    discover.recs.data = await api("/api/arxiv/recommendations" + (refresh ? "?refresh=true" : ""));
  } catch (err) {
    discover.recs.error = err.message || String(err);
  } finally {
    discover.recs.loading = false;
    $("#recsRefreshBtn").disabled = false;
    renderArxivList("recs");
  }
}

// ---- typed-in interests (steer recommendations alongside recent reading)
async function loadInterests() {
  discover.interestsLoaded = true;
  try {
    discover.interests = (await api("/api/interests")).interests || [];
  } catch (err) {
    discover.interestsLoaded = false;  // try again next time the dashboard shows
  }
  renderInterests();
}

async function saveInterests(next) {
  const prev = discover.interests;
  discover.interests = next;
  renderInterests();
  try {
    const res = await api("/api/interests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interests: next }),
    });
    discover.interests = res.interests;
    renderInterests();
    loadRecommendations(false);  // new interest set → recomputed (or cached) list
  } catch (err) {
    discover.interests = prev;
    renderInterests();
    alert("Couldn't save interests: " + (err.message || err));
  }
}

function addInterest(e) {
  e.preventDefault();
  const input = $("#interestInput");
  const text = input.value.trim().replace(/\s+/g, " ");
  if (!text) return;
  input.value = "";
  if (discover.interests.some((i) => i.toLowerCase() === text.toLowerCase())) return;
  saveInterests([...discover.interests, text]);
}

function renderInterests() {
  const list = $("#interestList");
  if (!list) return;
  list.innerHTML = "";
  if (!discover.interests.length) {
    list.innerHTML = '<span class="interest-empty">None yet — add topics you care about and they’ll shape your recommendations.</span>';
    return;
  }
  for (const text of discover.interests) {
    const chip = document.createElement("span");
    chip.className = "interest-chip";
    const label = document.createElement("span");
    label.textContent = text;
    const del = document.createElement("button");
    del.type = "button";
    del.title = "Remove";
    del.textContent = "×";
    del.addEventListener("click", () => saveInterests(discover.interests.filter((i) => i !== text)));
    chip.append(label, del);
    list.appendChild(chip);
  }
}

// Which library paper (if any) an arXiv result corresponds to. Checked
// against the live library so adds/deletes elsewhere are reflected at once.
function normTitle(t) { return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function libraryPaperFor(item) {
  const nt = normTitle(item.title);
  const hit = state.papers.find((p) =>
    (p.arxiv_id && p.arxiv_id === item.arxiv_id) || (nt && normTitle(p.title) === nt));
  if (hit) return hit.id;
  // The server also matches the arXiv stamp inside hand-uploaded PDFs.
  if (item.paper_id && state.papers.some((p) => p.id === item.paper_id)) return item.paper_id;
  return null;
}

function statusHtml(kind) {
  const s = discover[kind];
  if (s.loading && kind === "search" && s.mode === "exact") {
    return '<div class="disc-loading small"><span class="disc-spinner"></span><span>Searching arXiv…</span></div>';
  }
  if (s.loading) {
    const msg = kind === "search"
      ? "Searching arXiv and ranking by meaning… (arXiv is rate-limited, so this can take 15–30 s)"
      : "Finding papers related to your interests and recent reading… (this can take up to a minute the first time)";
    return '<div class="disc-loading"><span class="disc-spinner"></span><span>' + msg + "</span></div>";
  }
  if (s.error) return '<div class="disc-error"></div>';
  return "";
}

function renderArxivList(kind) {
  const hosts = DISCOVER_HOSTS[kind];
  const statusEl = $(hosts.status);
  const listEl = $(hosts.list);
  if (!statusEl || !listEl) return;
  const s = discover[kind];

  statusEl.innerHTML = statusHtml(kind);
  if (s.error && !s.loading) {
    statusEl.querySelector(".disc-error").textContent =
      (kind === "search" ? "Search failed: " : "Couldn't load recommendations: ") + s.error;
  }

  if (kind === "recs") {
    const basis = $("#recsBasis");
    const prof = (s.data && s.data.profile) || [];
    const ints = (s.data && s.data.interests) || [];
    const parts = [];
    if (ints.length) parts.push(ints.length === 1 ? "your interest" : `your ${ints.length} interests`);
    if (prof.length) {
      parts.push(prof.slice(0, 3).map((p) => "“" + truncate(p.title, 60) + "”").join(", ") +
        (prof.length > 3 ? ` and ${prof.length - 3} more` : ""));
    }
    basis.textContent = parts.length
      ? "Based on " + parts.join(" and ") + "."
      : "Based on your interests and the papers you've recently added and opened.";
  }

  // Live exact search keeps the previous results up while the next one loads.
  const live = kind === "search" && s.mode === "exact";
  if (s.loading && live && s.data) return;
  listEl.innerHTML = "";
  if (!s.data || s.loading) return;

  // Meta line: ranking mode + any notices (fallbacks, partial failures).
  const meta = document.createElement("div");
  meta.className = "disc-meta";
  const mode = s.data.mode;
  if (mode === "semantic" || mode === "keyword") {
    const badge = document.createElement("span");
    badge.className = "chip" + (mode === "semantic" ? " chip-lilac" : "");
    badge.textContent = mode === "semantic" ? "Ranked by meaning + recency" : "Keyword match + recency";
    meta.appendChild(badge);
  } else if (mode === "exact" && (s.data.items || []).length) {
    const badge = document.createElement("span");
    badge.className = "chip";
    const n = s.data.items.length;
    badge.textContent = `Exact match · ${n} paper${n === 1 ? "" : "s"}`;
    meta.appendChild(badge);
  }
  if (kind === "recs" && s.data.computed_at) {
    const when = document.createElement("span");
    when.textContent = "Updated " + relativeAge(new Date(s.data.computed_at * 1000)) + (s.data.cached ? " (cached)" : "");
    meta.appendChild(when);
  }
  for (const n of s.data.notices || []) {
    const note = document.createElement("span");
    note.className = "disc-notice";
    note.textContent = n;
    meta.appendChild(note);
  }
  if (meta.childNodes.length) listEl.appendChild(meta);

  const items = s.data.items || [];
  if (!items.length) {
    if (!(s.data.notices || []).length) {
      listEl.appendChild(emptyNote(
        kind !== "search" ? "No recommendations yet."
          : mode === "exact" ? `No arXiv papers contain “${s.data.text}”.`
          : "No matching papers found on arXiv."));
    }
    return;
  }
  const grid = document.createElement("div");
  grid.className = "arxiv-grid";
  const mark = mode === "exact" ? s.data.text : null;
  items.forEach((item) => grid.appendChild(arxivCard(item, mark)));
  listEl.appendChild(grid);
}

function formatArxivDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function relativeAge(d) {
  const days = Math.max(0, (Date.now() - d.getTime()) / 86400000);
  if (days < 1) {
    const hours = Math.round(days * 24);
    return hours <= 1 ? "just now" : hours + " h ago";
  }
  if (days < 14) return Math.round(days) + (Math.round(days) === 1 ? " day ago" : " days ago");
  if (days < 60) return Math.round(days / 7) + " wk ago";
  if (days < 730) return Math.round(days / 30.4) + " mo ago";
  return Math.round(days / 365) + " yr ago";
}

// Fills `el` with `text`, wrapping matches of `term` in <mark>. Like the
// server's exact search, case and punctuation between words are ignored.
function setHighlighted(el, text, term) {
  el.textContent = "";
  const words = (term || "").match(/[a-z0-9]+/gi);
  if (!words) { el.textContent = text; return; }
  const pattern = words.join("[^a-z0-9]+");
  let last = 0;
  for (const m of text.matchAll(new RegExp(pattern, "gi"))) {
    const mk = document.createElement("mark");
    mk.textContent = m[0];
    el.append(text.slice(last, m.index), mk);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

function arxivCard(item, mark = null) {
  const card = document.createElement("article");
  card.className = "arxiv-card";
  const pub = new Date(item.published);
  const ageDays = (Date.now() - pub.getTime()) / 86400000;

  card.innerHTML =
    '<div class="ax-top">' +
      '<span class="chip chip-date"></span>' +
      (ageDays < 30 ? '<span class="chip chip-new">New</span>' : "") +
      (item.primary_category ? '<span class="chip chip-cat"></span>' : "") +
      '<a class="ax-id" target="_blank" rel="noopener"></a>' +
    "</div>" +
    '<a class="ax-title" target="_blank" rel="noopener"></a>' +
    '<div class="ax-authors"></div>' +
    '<p class="ax-abstract" title="Click to expand"></p>' +
    '<div class="ax-actions"></div>' +
    '<div class="ax-error"></div>';

  card.querySelector(".chip-date").textContent =
    formatArxivDate(item.published) + " · " + relativeAge(pub);
  card.querySelector(".chip-date").title = "Submitted to arXiv";
  if (item.primary_category) card.querySelector(".chip-cat").textContent = item.primary_category;
  const idLink = card.querySelector(".ax-id");
  idLink.href = item.abs_url;
  idLink.textContent = "arXiv:" + item.arxiv_id;
  const title = card.querySelector(".ax-title");
  title.href = item.abs_url;
  setHighlighted(title, item.title, mark);

  const authors = item.authors || [];
  setHighlighted(card.querySelector(".ax-authors"),
    authors.slice(0, 4).join(", ") + (authors.length > 4 ? ` et al. (${authors.length})` : ""), mark);

  const abs = card.querySelector(".ax-abstract");
  setHighlighted(abs, item.summary, mark);
  abs.classList.toggle("expanded", discover.expanded.has(item.arxiv_id));
  abs.onclick = () => {
    if (discover.expanded.has(item.arxiv_id)) discover.expanded.delete(item.arxiv_id);
    else discover.expanded.add(item.arxiv_id);
    abs.classList.toggle("expanded");
  };

  const actions = card.querySelector(".ax-actions");
  const pid = libraryPaperFor(item);
  if (pid) {
    const tag = document.createElement("span");
    tag.className = "ax-inlib";
    tag.textContent = "In library";
    const open = axButton("Open", "btn-dark", () => openPaperFromScreen(pid));
    actions.append(tag, open);
  } else if (discover.adding.has(item.arxiv_id)) {
    const busy = document.createElement("span");
    busy.className = "disc-loading small";
    busy.innerHTML = '<span class="disc-spinner"></span><span>Downloading &amp; indexing…</span>';
    actions.appendChild(busy);
  } else {
    actions.append(
      axButton("Add & open", "btn-dark", () => addArxivPaper(item, true)),
      axButton("Add to library", "btn-ghost", () => addArxivPaper(item, false))
    );
  }
  const pdf = document.createElement("a");
  pdf.className = "ax-link";
  pdf.href = item.pdf_url || item.abs_url;
  pdf.target = "_blank";
  pdf.rel = "noopener";
  pdf.textContent = "PDF ↗";
  actions.appendChild(pdf);

  const err = discover.cardErrors[item.arxiv_id];
  if (err) card.querySelector(".ax-error").textContent = err;
  return card;
}

function axButton(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

async function addArxivPaper(item, openAfter) {
  if (discover.adding.has(item.arxiv_id)) return;
  discover.adding.add(item.arxiv_id);
  delete discover.cardErrors[item.arxiv_id];
  renderArxivList("search");
  renderArxivList("recs");
  try {
    const res = await api("/api/arxiv/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arxiv_id: item.arxiv_id, title: item.title }),
    });
    item.paper_id = res.id;
    discover.adding.delete(item.arxiv_id);
    await loadPapers();   // re-renders the dashboard with "In library"
    if (openAfter) openPaperFromScreen(res.id);
  } catch (err) {
    discover.adding.delete(item.arxiv_id);
    discover.cardErrors[item.arxiv_id] = "Couldn't add: " + (err.message || err);
    renderArxivList("search");
    renderArxivList("recs");
  }
}

// -------------------------------------------------------- bookmarking
async function setBookmark(paperId, value) {
  await api("/api/papers/" + paperId, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookmarked: value }),
  });
  const p = state.papers.find((x) => x.id === paperId);
  if (p) p.bookmarked = value ? 1 : 0;
  syncBookmarkButton();
  renderPaperList();
  if (SCREENS[state.view]) SCREENS[state.view].render();
}

function syncBookmarkButton() {
  const btn = $("#bookmarkBtn");
  if (!btn) return;
  const p = state.papers.find((x) => x.id === state.currentPaperId);
  btn.disabled = !state.currentPaperId;
  const on = !!(p && p.bookmarked);
  btn.classList.toggle("is-on", on);
  btn.title = on ? "Remove bookmark" : "Bookmark this paper";
}

function wireEvents() {
  $("#uploadInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleUpload(e.target.files[0]);
    e.target.value = "";
  });
  $("#librarySearch").addEventListener("input", renderPaperList);
  $("#arxivSearchForm").addEventListener("submit", runArxivSearch);
  $("#arxivSearchInput").addEventListener("input", scheduleExactSearch);
  document.querySelectorAll(".mode-tab").forEach((b) =>
    b.addEventListener("click", () => setSearchMode(b.dataset.mode)));
  let savedMode = "semantic";
  try { savedMode = localStorage.getItem("rpm.searchMode") || "semantic"; } catch (e) {}
  setSearchMode(savedMode);
  $("#recsRefreshBtn").addEventListener("click", () => loadRecommendations(true));
  $("#interestForm").addEventListener("submit", addInterest);
  $("#libraryChatBtn").addEventListener("click", loadLibraryChat);
  $("#newFolderBtn").addEventListener("click", () => newFolder());
  $("#foldersNewBtn").addEventListener("click", () => newFolder(state.folderCursor));

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
  // Rail navigation: every element carrying data-view switches screens.
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view))
  );
  $("#bookmarkBtn")?.addEventListener("click", () => {
    if (!state.currentPaperId) return;
    const p = state.papers.find((x) => x.id === state.currentPaperId);
    setBookmark(state.currentPaperId, !(p && p.bookmarked));
  });
  $("#railSettingsBtn")?.addEventListener("click", () => {
    const el = $("#aiStatus");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 900);
  });
  $("#themeToggleBtn")?.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("rpm.theme", next); } catch (e) {}
  });
  $("#summarizeBtn").addEventListener("click", summarizePaper);
  $("#prereadingBtn").addEventListener("click", generatePrereading);
  $("#peterBtn").addEventListener("click", () => peterExplains(false));
  $("#peterRegenBtn").addEventListener("click", () => peterExplains(true));
  $("#peterClose").addEventListener("click", hidePeter);
  $("#peterNoticeClose").addEventListener("click", hidePeterNotice);
  // The background video and subtitles follow the clip's play/pause.
  $("#peterAudio").addEventListener("play", () => {
    const v = $("#peterVideo");
    if (v.getAttribute("src")) v.play().catch(() => {});
    cancelAnimationFrame(peterSubs.raf);
    peterSubsLoop();
  });
  $("#peterAudio").addEventListener("pause", () => {
    $("#peterVideo").pause();
    cancelAnimationFrame(peterSubs.raf);
    renderPeterSubs();
  });
  $("#peterAudio").addEventListener("seeked", renderPeterSubs);
  $("#peterExpand").addEventListener("click", () =>
    setPeterExpanded(!$("#peterPlayer").classList.contains("expanded")));
  $("#peterStage").addEventListener("dblclick", () =>
    setPeterExpanded(!$("#peterPlayer").classList.contains("expanded")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#peterPlayer").classList.contains("expanded")) setPeterExpanded(false);
  });
  $("#peterTranscriptBtn").addEventListener("click", () => {
    const t = $("#peterTranscript");
    t.classList.toggle("hidden");
    $("#peterTranscriptBtn").textContent = t.classList.contains("hidden") ? "Transcript" : "Hide transcript";
  });
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
  $("#threadBack").addEventListener("click", () => leaveThread());
  $("#replyQuote .rq-clear").addEventListener("click", () => setReplyQuote(""));
  $("#chatMessages").addEventListener("mouseup", () => setTimeout(onChatSelection, 10));
  $("#fsChatBody").addEventListener("mouseup", () => setTimeout(onChatSelection, 10));
  $("#fsChatBody").addEventListener("scroll", hideReplyPill);
  $("#fsThreadBack").addEventListener("click", leaveFsThread);
  $("#fsReplyQuote .rq-clear").addEventListener("click", () => setFsReplyQuote(""));
  $("#chatMessages").addEventListener("scroll", hideReplyPill);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#chatReplyPill")) hideReplyPill();
  });
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => setActiveTab(t.dataset.tab))
  );

  document.addEventListener("mouseup", (e) => setTimeout(() => onSelection(e), 10));
  $("#pdfContainer").addEventListener("mousemove", onPdfHover);
  $("#selectionToolbar").addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action === "unhighlight") removeHighlights();
    else if (action === "highlight") saveHighlight();
    else if (action === "summarize") summarizeSelection();
    else if (action === "ask") askAboutSelection();
  });
}

init();
