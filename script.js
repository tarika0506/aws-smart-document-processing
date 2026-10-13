const state = {
  documents: [],
  events: [],
  lambdaRuns: [],
  notifications: [],
  duplicates: [],
  activity: [],
  nextId: 1
};

const STORAGE_KEY = "smartDocumentIntelligence_v1";

const els = {
  pages: [...document.querySelectorAll(".page")],
  navItems: [...document.querySelectorAll(".nav-item")],
  pageTitle: document.getElementById("pageTitle")
};

function saveState() {
  const copy = JSON.parse(JSON.stringify(state));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    Object.assign(state, parsed);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function showToast(message) {
  const div = document.createElement("div");
  div.className = "toast";
  div.textContent = message;
  document.getElementById("toastContainer").appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

function addActivity(service, action, detail) {
  state.activity.unshift({
    id: `ACT-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    service,
    action,
    detail,
    time: formatTime()
  });
  state.activity = state.activity.slice(0, 100);
}

function fileCategory(name) {
  const ext = name.toLowerCase().split(".").pop();
  if (["pdf"].includes(ext)) return "pdf";
  if (["doc", "docx"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv"].includes(ext)) return "xls";
  if (["ppt", "pptx"].includes(ext)) return "ppt";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "other";
}

function tokenize(name) {
  return new Set(
    name
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[_\-.()\[\]]/g, " ")
      .split(/\s+/)
      .filter(x => x.length > 1 && !["final", "latest", "new", "copy", "v1", "v2", "v3"].includes(x))
  );
}

function jaccard(setA, setB) {
  const union = new Set([...setA, ...setB]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / union.size;
}

function sizeSimilarity(a, b) {
  if (!a || !b) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

async function sha256(file) {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function compareWithExisting(doc) {
  const relationships = [];

  for (const other of state.documents) {
    if (other.id === doc.id) continue;

    if (other.hash && doc.hash && other.hash === doc.hash) {
      relationships.push({
        type: "Exact Duplicate",
        similarity: 100,
        documentId: other.id,
        documentName: other.name,
        reason: "Identical SHA-256 content hash"
      });
      continue;
    }

    const nameScore = jaccard(tokenize(doc.name), tokenize(other.name));
    const sizeScore = sizeSimilarity(doc.size, other.size);
    const score = Math.round((nameScore * 0.65 + sizeScore * 0.35) * 100);

    if (score >= 70 && fileCategory(doc.name) === fileCategory(other.name)) {
      relationships.push({
        type: "Near Duplicate / Version Candidate",
        similarity: score,
        documentId: other.id,
        documentName: other.name,
        reason: `Filename similarity ${Math.round(nameScore * 100)}%, size similarity ${Math.round(sizeScore * 100)}%`
      });
    }
  }

  return relationships.sort((a, b) => b.similarity - a.similarity);
}

function addDuplicateRelations(doc, relationships) {
  for (const rel of relationships) {
    const key = [doc.id, rel.documentId].sort().join("|");
    const already = state.duplicates.some(x => x.key === key);
    if (already) continue;

    state.duplicates.push({
      key,
      documentA: doc.name,
      documentAId: doc.id,
      documentB: rel.documentName,
      documentBId: rel.documentId,
      type: rel.type,
      similarity: rel.similarity,
      reason: rel.reason,
      time: formatTime()
    });
  }
}

function createNotification(level, title, message) {
  state.notifications.unshift({
    id: `SNS-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    level,
    title,
    message,
    time: formatTime(),
    read: false
  });
  state.notifications = state.notifications.slice(0, 100);
}

async function processFile(file) {
  const doc = {
    id: `DOC-${String(state.nextId++).padStart(4, "0")}`,
    name: file.name,
    size: file.size,
    type: file.type || "unknown",
    category: fileCategory(file.name),
    hash: "",
    status: "Uploaded",
    uploadedAt: formatTime(),
    processedAt: "",
    duplicateStatus: "Unique",
    duplicateScore: 0
  };

  state.documents.unshift(doc);
  addActivity("Amazon S3", "ObjectCreated", `${doc.name} uploaded to document-bucket`);
  state.events.unshift({
    id: `EVT-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    type: "Object Created",
    source: "aws.s3",
    detail: doc.name,
    time: formatTime(),
    status: "Routed"
  });

  addActivity("Amazon EventBridge", "Route Event", `ObjectCreated event routed for ${doc.name}`);
  renderAll();
  saveState();

  await new Promise(resolve => setTimeout(resolve, 350));

  try {
    doc.hash = await sha256(file);
  } catch {
    doc.hash = "browser-hash-unavailable";
  }

  addActivity("AWS Lambda", "Invoke", `DocumentProcessor invoked for ${doc.name}`);

  const relationships = compareWithExisting(doc);
  if (relationships.length) {
    const strongest = relationships[0];
    doc.duplicateStatus = strongest.type;
    doc.duplicateScore = strongest.similarity;
    addDuplicateRelations(doc, relationships);

    const exact = relationships.some(r => r.type === "Exact Duplicate");

    if (exact) {
      createNotification(
        "danger",
        "Exact duplicate detected",
        `${doc.name} has identical content to ${strongest.documentName}.`
      );
      addActivity("Amazon SNS", "Publish", `Exact duplicate alert for ${doc.name}`);
    } else {
      createNotification(
        "warning",
        "Possible document version detected",
        `${doc.name} is ${strongest.similarity}% similar to ${strongest.documentName}.`
      );
      addActivity("Amazon SNS", "Publish", `Near-duplicate alert for ${doc.name}`);
    }
  } else {
    createNotification(
      "success",
      "Document processed",
      `${doc.name} was processed successfully and no duplicate was detected.`
    );
    addActivity("Amazon SNS", "Publish", `Processing success notification for ${doc.name}`);
  }

  doc.status = "Processed";
  doc.processedAt = formatTime();

  state.lambdaRuns.unshift({
    id: `RUN-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    document: doc.name,
    result: doc.duplicateStatus,
    duration: `${Math.floor(80 + Math.random() * 160)} ms`,
    time: doc.processedAt
  });

  addActivity(
    "Amazon DynamoDB",
    "PutItem",
    `Stored metadata for ${doc.name} with status ${doc.duplicateStatus}`
  );

  renderAll();
  saveState();
}

function statCard(label, value, hint) {
  return `<div class="stat-card"><div class="label">${escapeHTML(label)}</div><div class="value">${escapeHTML(value)}</div><div class="hint">${escapeHTML(hint)}</div></div>`;
}

function renderNotificationCenter(){state.notifications.forEach(n=>{if(typeof n.read!=="boolean")n.read=false});const unread=state.notifications.filter(n=>!n.read).length;const count=document.getElementById("notificationCount");const feed=document.getElementById("notificationFeed");const sub=document.getElementById("notificationPanelSub");count.textContent=unread>99?"99+":unread;count.classList.toggle("show",unread>0);sub.textContent=unread?`${unread} unread SNS alert${unread===1?"":"s"}`:"No unread SNS alerts";if(!state.notifications.length){feed.innerHTML=emptyState("No notifications yet.");return}feed.innerHTML=state.notifications.slice(0,20).map(n=>`<div class="notification-item ${n.read?"":"unread"}" data-notification-id="${escapeHTML(n.id)}"><div class="notification-item-title"><span>${escapeHTML(n.title)}</span><span class="notification-type ${escapeHTML(n.level)}">${escapeHTML(n.level==="danger"?"DUPLICATE":n.level==="warning"?"REVIEW":"INFO")}</span></div><div class="notification-item-message">${escapeHTML(n.message)}</div><div class="notification-item-time">${escapeHTML(n.time)} · Amazon SNS simulation</div></div>`).join("");feed.querySelectorAll(".notification-item").forEach(item=>item.addEventListener("click",()=>{const n=state.notifications.find(x=>x.id===item.dataset.notificationId);if(!n)return;n.read=true;saveState();renderNotificationCenter();showPage("sns")}))}

function renderDashboard() {
  const total = state.documents.length;
  const exact = state.documents.filter(d => d.duplicateStatus === "Exact Duplicate").length;
  const near = state.documents.filter(d => d.duplicateStatus.includes("Near Duplicate")).length;
  const savings = state.duplicates
    .filter(d => d.type === "Exact Duplicate")
    .reduce((sum, d) => {
      const a = state.documents.find(x => x.id === d.documentAId);
      return sum + (a?.size || 0);
    }, 0);

  document.getElementById("dashboardStats").innerHTML = [
    statCard("Documents", total, "Objects in simulated S3"),
    statCard("Processed", state.documents.filter(d => d.status === "Processed").length, "Lambda processing complete"),
    statCard("Duplicate Relationships", state.duplicates.length, "Exact + near duplicate candidates"),
    statCard("Potential Savings", formatBytes(savings), "Estimated from exact duplicates")
  ].join("");

  const recent = state.documents.slice(0, 6);
  document.getElementById("recentDocuments").innerHTML = recent.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Object</th><th>Size</th><th>Status</th><th>Analysis</th></tr></thead><tbody>${
      recent.map(d => `<tr><td>${escapeHTML(d.name)}</td><td>${formatBytes(d.size)}</td><td>${statusBadge(d.status)}</td><td>${duplicateBadge(d.duplicateStatus, d.duplicateScore)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No documents uploaded yet.");

  const alerts = state.notifications.slice(0, 6);
  document.getElementById("recentAlerts").innerHTML = alerts.length
    ? alerts.map(n => `<div class="config-list"><div><span>${escapeHTML(n.time)}</span><strong>${escapeHTML(n.title)}</strong></div><div><span>${escapeHTML(n.level.toUpperCase())}</span><strong>${escapeHTML(n.message)}</strong></div></div>`).join("")
    : emptyState("No notifications yet.");
}

function statusBadge(status) {
  const cls = status === "Processed" ? "success" : "info";
  return `<span class="badge ${cls}">${escapeHTML(status)}</span>`;
}

function duplicateBadge(status, score) {
  if (status === "Exact Duplicate") return `<span class="badge danger">Exact duplicate</span>`;
  if (status.includes("Near Duplicate")) return `<span class="badge warning">${score}% similar</span>`;
  return `<span class="badge success">Unique</span>`;
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHTML(text)}</div>`;
}

function renderS3() {
  const query = (document.getElementById("s3Search")?.value || "").toLowerCase();
  const type = document.getElementById("s3TypeFilter")?.value || "all";
  const docs = state.documents.filter(d => {
    const matchesQuery = d.name.toLowerCase().includes(query);
    const matchesType = type === "all" || d.category === type;
    return matchesQuery && matchesType;
  });

  document.getElementById("s3Table").innerHTML = docs.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Object</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Status</th><th>Analysis</th></tr></thead><tbody>${
      docs.map(d => `<tr><td>${escapeHTML(d.name)}</td><td>${escapeHTML(d.type)}</td><td>${formatBytes(d.size)}</td><td>${escapeHTML(d.uploadedAt)}</td><td>${statusBadge(d.status)}</td><td>${duplicateBadge(d.duplicateStatus, d.duplicateScore)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No matching objects.");
}

function renderEventBridge() {
  document.getElementById("eventStats").innerHTML = [
    statCard("Events Received", state.events.length, "S3 ObjectCreated events"),
    statCard("Routed", state.events.filter(e => e.status === "Routed").length, "Sent to processor"),
    statCard("Source", "aws.s3", "Simulated event source"),
    statCard("Target", "Lambda", "DocumentProcessor")
  ].join("");

  document.getElementById("eventTable").innerHTML = state.events.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Event ID</th><th>Type</th><th>Source</th><th>Object</th><th>Status</th><th>Time</th></tr></thead><tbody>${
      state.events.map(e => `<tr><td>${escapeHTML(e.id)}</td><td>${escapeHTML(e.type)}</td><td>${escapeHTML(e.source)}</td><td>${escapeHTML(e.detail)}</td><td>${statusBadge(e.status)}</td><td>${escapeHTML(e.time)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No events generated yet.");
}

function renderLambda() {
  document.getElementById("lambdaStats").innerHTML = [
    statCard("Invocations", state.lambdaRuns.length, "DocumentProcessor runs"),
    statCard("Successful", state.lambdaRuns.length, "Completed simulations"),
    statCard("Function", "DocumentProcessor", "Simulated Lambda"),
    statCard("Trigger", "S3 Event", "Routed through EventBridge")
  ].join("");

  document.getElementById("lambdaTable").innerHTML = state.lambdaRuns.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Run</th><th>Document</th><th>Result</th><th>Duration</th><th>Time</th></tr></thead><tbody>${
      state.lambdaRuns.slice(0, 20).map(r => `<tr><td>${escapeHTML(r.id)}</td><td>${escapeHTML(r.document)}</td><td>${duplicateBadge(r.result, state.documents.find(d => d.name === r.document)?.duplicateScore || 0)}</td><td>${escapeHTML(r.duration)}</td><td>${escapeHTML(r.time)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No Lambda executions yet.");
}

function renderDynamoDB() {
  const query = (document.getElementById("ddbSearch")?.value || "").toLowerCase();
  const docs = state.documents.filter(d => d.name.toLowerCase().includes(query));

  document.getElementById("ddbTable").innerHTML = docs.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Document ID</th><th>Document</th><th>Hash</th><th>Size</th><th>Duplicate Status</th><th>Processed</th></tr></thead><tbody>${
      docs.map(d => `<tr><td>${escapeHTML(d.id)}</td><td>${escapeHTML(d.name)}</td><td>${escapeHTML(d.hash ? d.hash.slice(0, 18) + "..." : "Pending")}</td><td>${formatBytes(d.size)}</td><td>${duplicateBadge(d.duplicateStatus, d.duplicateScore)}</td><td>${escapeHTML(d.processedAt || "Pending")}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No metadata records yet.");
}

function renderSNS() {
  const critical = state.notifications.filter(n => n.level === "danger").length;
  const warnings = state.notifications.filter(n => n.level === "warning").length;

  document.getElementById("snsStats").innerHTML = [
    statCard("Messages", state.notifications.length, "Simulated SNS publishes"),
    statCard("Critical", critical, "Exact duplicate alerts"),
    statCard("Warnings", warnings, "Near duplicate alerts"),
    statCard("Success", state.notifications.filter(n => n.level === "success").length, "Normal processing")
  ].join("");

  document.getElementById("snsTable").innerHTML = state.notifications.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Message ID</th><th>Level</th><th>Subject</th><th>Message</th><th>Time</th></tr></thead><tbody>${
      state.notifications.map(n => `<tr><td>${escapeHTML(n.id)}</td><td><span class="badge ${n.level === "danger" ? "danger" : n.level === "warning" ? "warning" : "success"}">${escapeHTML(n.level)}</span></td><td>${escapeHTML(n.title)}</td><td>${escapeHTML(n.message)}</td><td>${escapeHTML(n.time)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No SNS-style notifications yet.");
}

function renderDetector() {
  const exact = state.duplicates.filter(d => d.type === "Exact Duplicate");
  const near = state.duplicates.filter(d => d.type !== "Exact Duplicate");
  const savings = exact.reduce((sum, d) => {
    const doc = state.documents.find(x => x.id === d.documentAId);
    return sum + (doc?.size || 0);
  }, 0);

  document.getElementById("detectorStats").innerHTML = [
    statCard("Exact Duplicates", exact.length, "Identical content"),
    statCard("Near Duplicates", near.length, "Possible versions"),
    statCard("Potential Savings", formatBytes(savings), "If exact duplicates are removed"),
    statCard("Analysis Model", "Hybrid", "Hash + similarity scoring")
  ].join("");

  document.getElementById("duplicateTable").innerHTML = state.duplicates.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Document A</th><th>Document B</th><th>Type</th><th>Similarity</th><th>Reason</th><th>Detected</th></tr></thead><tbody>${
      state.duplicates.map(d => `<tr><td>${escapeHTML(d.documentA)}</td><td>${escapeHTML(d.documentB)}</td><td>${duplicateBadge(d.type, d.similarity)}</td><td>${d.similarity}%</td><td>${escapeHTML(d.reason)}</td><td>${escapeHTML(d.time)}</td></tr>`).join("")
    }</tbody></table></div>`
    : emptyState("No duplicate relationships detected yet. Upload similar files to test the enhancement.");
}

function renderActivity() {
  document.getElementById("activityTimeline").innerHTML = state.activity.length
    ? `<div class="timeline">${
      state.activity.slice(0, 60).map(a => `<div class="timeline-item"><div class="timeline-time">${escapeHTML(a.time)}</div><div class="timeline-marker"></div><div class="timeline-content"><strong>${escapeHTML(a.service)} — ${escapeHTML(a.action)}</strong><span>${escapeHTML(a.detail)}</span></div></div>`).join("")
    }</div>`
    : emptyState("No activity yet.");
}

function renderAll() {
  renderNotificationCenter();
  renderDashboard();
  renderS3();
  renderEventBridge();
  renderLambda();
  renderDynamoDB();
  renderSNS();
  renderDetector();
  renderActivity();
}

function showPage(pageId) {
  els.pages.forEach(page => page.classList.toggle("active", page.id === pageId));
  els.navItems.forEach(item => item.classList.toggle("active", item.dataset.page === pageId));

  const active = els.navItems.find(item => item.dataset.page === pageId);
  els.pageTitle.textContent = active ? active.textContent : "Smart Document Intelligence";
}

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => showPage(item.dataset.page));
});

document.querySelectorAll("[data-go]").forEach(btn => {
  btn.addEventListener("click", () => showPage(btn.dataset.go));
});

async function handleFiles(files) {
  if (!files.length) return;
  for (const file of files) {
    await processFile(file);
  }
  showToast(`${files.length} document${files.length > 1 ? "s" : ""} processed.`);
}

document.getElementById("dashboardFileInput").addEventListener("change", e => {
  handleFiles([...e.target.files]);
  e.target.value = "";
});

document.getElementById("s3FileInput").addEventListener("change", e => {
  handleFiles([...e.target.files]);
  e.target.value = "";
});

document.getElementById("s3Search").addEventListener("input", renderS3);
document.getElementById("s3TypeFilter").addEventListener("change", renderS3);
document.getElementById("ddbSearch").addEventListener("input", renderDynamoDB);

document.getElementById("notificationBell").addEventListener("click",event=>{event.stopPropagation();document.getElementById("notificationPanel").classList.toggle("hidden")});document.getElementById("markNotificationsRead").addEventListener("click",()=>{state.notifications.forEach(n=>n.read=true);saveState();renderNotificationCenter()});document.addEventListener("click",event=>{const panel=document.getElementById("notificationPanel");const bell=document.getElementById("notificationBell");if(!panel.contains(event.target)&&!bell.contains(event.target))panel.classList.add("hidden")});

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Reset the entire simulation and remove all generated data?")) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

loadState();
renderAll();
