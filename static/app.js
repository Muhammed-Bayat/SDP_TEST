"use strict";

const $ = (sel) => document.querySelector(sel);

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtPct = (x) => ((x || 0) * 100).toFixed(2) + "%";
const fmtRate = (x) =>
  Number(x || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtSigned = (n) => (n >= 0 ? "+" : "") + fmtInt(n);
const fmtDate = (ts) =>
  ts
    ? new Date(ts * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

let metrics = null;
let currentTab = "files";
let repoState = { repos: [], active: null };
const charts = { churn: null, authors: null };
let commitSel = new Set();
let commitData = null;
let commitSearch = "";
let commitSnapshot = null;
let mergeMode = false;
let mergeChecked = new Set();

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

function setStatus(kind, text) {
  const el = $("#status");
  if (!kind) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.className = kind;
  el.innerHTML =
    '<span class="spinner"></span><span>' + esc(text) + "</span>";
}

function renderRepoSelect() {
  const picker = $("#repo-picker");
  const select = $("#repo-select");
  if (!repoState.repos.length) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;
  select.innerHTML = repoState.repos
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === repoState.active ? "selected" : ""}>` +
        `${esc(r.name)} — ${fmtInt(r.commit_count)} commits</option>`
    )
    .join("");
}

async function refreshRepoState() {
  repoState = await api("/api/state");
  renderRepoSelect();
}

function showIngest() {
  $("#view-ingest").hidden = false;
  $("#view-dashboard").hidden = true;
  $("#btn-new").hidden = true;
  renderRepoSelect();
  setStatus(null);
}

async function loadAndRender() {
  metrics = await api("/api/metrics");
  resetFilterInputs();
  mergeMode = false; // author keys are repository-scoped
  mergeChecked.clear();
  populateFilterOptions();
  renderDashboard();
}

function resetFilterInputs() {
  $("#filter-author").value = "";
  $("#filter-path").value = "";
  $("#filter-start").value = "";
  $("#filter-end").value = "";
  $("#table-search").value = "";
  commitSel.clear();
  commitData = null;
  updateCommitsButton();
}

function updateCommitsButton() {
  $("#btn-commits").textContent = commitSel.size
    ? `Commits: ${fmtInt(commitSel.size)} selected`
    : "Select commits…";
}

function populateFilterOptions() {
  $("#filter-author").innerHTML =
    '<option value="">All authors</option>' +
    (metrics.authors || [])
      .map(
        (a) =>
          `<option value="${esc(a.key)}">${esc(a.name)} &lt;${esc(a.email)}&gt;</option>`
      )
      .join("");
  $("#path-options").innerHTML = (metrics.dirs || [])
    .map((d) => d.path)
    .filter((p) => p)
    .sort()
    .slice(0, 1000)
    .map((p) => `<option value="${esc(p)}">`)
    .join("");
}

async function applyFilters() {
  const author = $("#filter-author").value;
  const path = $("#filter-path").value.trim();
  const start = $("#filter-start").value;
  const end = $("#filter-end").value;
  const body = { repo: repoState.active };
  if (author) body.author = author;
  if (path) body.path = path;
  if (start) body.start = start;
  if (end) body.end = end;
  if (commitSel.size) body.commits = [...commitSel];
  setStatus("loading", "Applying filters…");
  try {
    metrics = await api("/api/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!(author || path || start || end || commitSel.size)) {
      populateFilterOptions();
    }
    renderDashboard();
  } catch (err) {
    setStatus("error", err.message);
  }
}

$("#btn-apply").addEventListener("click", applyFilters);
$("#btn-clear-filters").addEventListener("click", async () => {
  resetFilterInputs();
  await applyFilters();
});

/* ---- manual commit selection ---- */

const COMMIT_ROW_CAP = 300;

function filteredCommits() {
  const q = commitSearch.trim().toLowerCase();
  if (!q) return commitData;
  return commitData.filter(
    (c) =>
      c.h.startsWith(q) ||
      (c.subject || "").toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q)
  );
}

function renderCommitList() {
  const rows = filteredCommits();
  const shown = rows.slice(0, COMMIT_ROW_CAP);
  $("#commit-list").innerHTML =
    shown
      .map(
        (c) =>
          `<label class="commit-row"><input type="checkbox" data-h="${esc(c.h)}" ` +
          `${commitSel.has(c.h) ? "checked" : ""}><span class="chash">${esc(c.h.slice(0, 10))}</span>` +
          `<span class="cdate">${fmtDate(c.ts)}</span>` +
          `<span class="cauthor" title="${esc(c.name)}">${esc(c.name)}</span>` +
          `<span class="csubj" title="${esc(c.subject || "")}">${esc(c.subject || "")}</span></label>`
      )
      .join("") +
    (rows.length > COMMIT_ROW_CAP
      ? `<div class="note" style="padding:8px 12px">Showing first ${fmtInt(COMMIT_ROW_CAP)} of ` +
        `${fmtInt(rows.length)} commits — refine the search to see more.</div>`
      : "");
  $("#commit-count").textContent = `${fmtInt(commitSel.size)} selected`;
}

async function openCommitModal() {
  commitSnapshot = new Set(commitSel);
  commitSearch = "";
  $("#commit-search").value = "";
  setStatus("loading", "Loading commits…");
  try {
    const params = repoState.active ? `?repo=${encodeURIComponent(repoState.active)}` : "";
    commitData = await api("/api/commits" + params);
    setStatus(null);
    $("#commit-modal").hidden = false;
    renderCommitList();
  } catch (err) {
    setStatus("error", err.message);
  }
}

function closeCommitModal() {
  $("#commit-modal").hidden = true;
}

$("#btn-commits").addEventListener("click", openCommitModal);
$("#commit-search").addEventListener("input", (e) => {
  commitSearch = e.target.value;
  renderCommitList();
});
$("#commit-list").addEventListener("change", (e) => {
  const h = e.target.dataset.h;
  if (!h) return;
  if (e.target.checked) commitSel.add(h);
  else commitSel.delete(h);
  $("#commit-count").textContent = `${fmtInt(commitSel.size)} selected`;
});
$("#commit-all").addEventListener("click", () => {
  filteredCommits().forEach((c) => commitSel.add(c.h));
  renderCommitList();
});
$("#commit-none").addEventListener("click", () => {
  filteredCommits().forEach((c) => commitSel.delete(c.h));
  renderCommitList();
});
$("#commit-apply").addEventListener("click", async () => {
  closeCommitModal();
  updateCommitsButton();
  await applyFilters();
});
$("#commit-cancel").addEventListener("click", () => {
  commitSel = commitSnapshot || new Set();
  closeCommitModal();
  updateCommitsButton();
});
$("#commit-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("#commit-cancel").click();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#commit-modal").hidden) $("#commit-cancel").click();
});

async function init() {
  try {
    await refreshRepoState();
    if (repoState.repos.length) {
      await loadAndRender();
    } else {
      showIngest();
    }
  } catch (err) {
    setStatus("error", err.message);
  }
}

async function runIngest(fetchCall, busyText) {
  document
    .querySelectorAll("button")
    .forEach((b) => (b.disabled = true));
  setStatus("loading", busyText);
  try {
    await fetchCall();
    await refreshRepoState();
    await loadAndRender();
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    document
      .querySelectorAll("button")
      .forEach((b) => (b.disabled = false));
  }
}

$("#clone-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#clone-url").value.trim();
  if (!url) return;
  runIngest(
    () =>
      api("/api/repos/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }),
    "Cloning repository — large repositories can take a few minutes…"
  );
});

$("#upload-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const file = $("#zip-file").files[0];
  if (!file) return;
  runIngest(
    async () => {
      const body = await file.arrayBuffer();
      return api(`/api/repos/upload?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body,
      });
    },
    "Uploading and analysing repository…"
  );
});

$("#btn-new").addEventListener("click", showIngest);

$("#repo-select").addEventListener("change", async () => {
  const id = $("#repo-select").value;
  setStatus("loading", "Switching repository…");
  try {
    await api("/api/repos/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await refreshRepoState(); // sync active repo for all later calls
    await loadAndRender();
  } catch (err) {
    setStatus("error", err.message);
  }
});

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    document
      .querySelectorAll(".tab")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderTable();
  })
);

$("#table-search").addEventListener("input", renderTable);

function renderDashboard() {
  $("#view-ingest").hidden = true;
  $("#view-dashboard").hidden = false;
  $("#btn-new").hidden = false;
  renderRepoSelect();
  $("#clone-url").value = "";

  const src = metrics.source || {};
  $("#source-line").textContent =
    src.kind === "clone"
      ? `Source: deep clone of ${src.url}`
      : src.kind === "zip"
        ? `Source: uploaded zip (${src.filename})`
        : "Source: persisted repository";

  const H = metrics.commit_count;
  const flt = metrics.filtered;
  const bits = [
    flt && flt.author ? "the selected author" : null,
    flt && flt.path ? `path “${flt.path}” (file and directory metrics are scoped to it)` : null,
    flt && (flt.start || flt.end)
      ? `the selected time period (${fmtDate(flt.start)} → ${fmtDate(flt.end)})`
      : null,
    flt && flt.commits ? `the ${fmtInt(flt.commits)} manually selected commits` : null,
  ].filter(Boolean);
  $("#commit-set-note").textContent = flt
    ? `Metrics below are computed over the filtered commit set H = ${fmtInt(H)} ` +
      `non-merge commits matching ${bits.join(" + ")}. ` +
      `Author metrics are shown for the repository root (all files).`
    : `Commit-set metrics below are computed over H = all ${fmtInt(H)} ` +
      `non-merge commits reachable from HEAD (committer dates). ` +
      `Author metrics are shown for the repository root (all files).`;

  const repo = metrics.repo;
  const cards = [
    ["Commits (|H|)", fmtInt(H), ""],
    ["First commit", fmtDate(metrics.first_commit), ""],
    ["Last commit", fmtDate(metrics.last_commit), ""],
    ["Added lines", fmtInt(repo.added), "pos"],
    ["Removed lines", fmtInt(repo.removed), "neg"],
    ["Growth", fmtSigned(repo.growth), repo.growth >= 0 ? "pos" : "neg"],
    ["Churn", fmtInt(repo.churn), ""],
    ["Modifications", fmtInt(repo.mods), ""],
    ["Mod. frequency", fmtPct(repo.freq), ""],
    ["Churn rate", fmtRate(repo.rate) + " /commit", ""],
  ];
  $("#overview").innerHTML = cards
    .map(
      ([label, value, cls]) =>
        `<div class="metric-card"><div class="label">${label}</div>` +
        `<div class="value ${cls}">${esc(value)}</div></div>`
    )
    .join("");

  renderCharts();
  renderTable();
  setStatus(null);
}

function renderCharts() {
  const months = metrics.months || [];
  if (charts.churn) charts.churn.destroy();
  if (charts.authors) charts.authors.destroy();

  charts.churn = new Chart($("#chart-churn"), {
    type: "bar",
    data: {
      labels: months.map((m) => m.month),
      datasets: [
        { label: "Added", data: months.map((m) => m.added), backgroundColor: "#059669" },
        { label: "Removed", data: months.map((m) => m.removed), backgroundColor: "#d5776d" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { maxTicksLimit: 14 } },
        y: { stacked: true },
      },
    },
  });

  const top = (metrics.authors || []).slice(0, 10);
  charts.authors = new Chart($("#chart-authors"), {
    type: "bar",
    data: {
      labels: top.map((a) => a.name),
      datasets: [
        { label: "Churn", data: top.map((a) => a.churn), backgroundColor: "#2563eb" },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
    },
  });
}

const OBJECT_COLS = [
  "Path", "Added", "Removed", "Growth", "Churn",
  "Modifications", "Mod. frequency", "Churn rate",
];
const AUTHOR_COLS = ["Author", "Email", "Commits", "Modifications", "Churn", "Ownership"];

function mergeNote() {
  const am = metrics.author_merging || {};
  const merged = am.merged_authors || [];
  const manual = am.manual_merges || [];
  if (!am.author_count && !manual.length) return "";
  let html = "";
  if (merged.length) {
    const example = merged[0];
    const from = example.from[0];
    html += `<div class="note merge-note">Author merging (.mailmap): ` +
      `${fmtInt(am.raw_identity_count)} raw identities resolved to ` +
      `${fmtInt(am.author_count)} authors (${merged.length} merged). ` +
      `E.g. “${esc(from.name)} &lt;${esc(from.email)}&gt;” → ` +
      `“${esc(example.name)} &lt;${esc(example.email)}&gt;”.</div>`;
  } else if (am.author_count) {
    html += `<div class="note merge-note">Author merging (.mailmap): all ` +
      `${fmtInt(am.raw_identity_count)} identities are already canonical — no merges needed.</div>`;
  }
  for (const ex of manual) {
    const names = ex.from.map((f) => esc(f.name)).join(" + ");
    html += `<div class="note merge-note manual">Manually merged: ` +
      `${names} → “${esc(ex.name)} &lt;${esc(ex.email)}&gt;”.</div>`;
  }
  return html;
}

/* ---- manual author merging ---- */

function mergeBar() {
  if (currentTab !== "authors" || !mergeMode) {
    return currentTab === "authors"
      ? `<div class="merge-bar"><button id="merge-enable" class="ghost">Merge authors manually…</button></div>`
      : "";
  }
  const def = (metrics.authors || []).find((a) => mergeChecked.has(a.key));
  return `<div class="merge-bar card">
    <div class="merge-bar-row">
      <button id="merge-start" class="primary" ${mergeChecked.size < 2 ? "disabled" : ""}>
        Merge ${fmtInt(mergeChecked.size)} selected…</button>
      <button id="merge-done" class="ghost">Done</button>
      <button id="merge-reset" class="ghost">Reset manual merges</button>
    </div>
    <div id="merge-form" class="merge-bar-row" hidden>
      <label>Merged name <input id="merge-name" type="text" value="${esc(def ? def.name : "")}"></label>
      <label>Merged email <input id="merge-email" type="text" value="${esc(def ? def.email : "")}"></label>
      <button id="merge-apply" class="primary">Apply merge</button>
    </div>
  </div>`;
}

function checkedAuthors() {
  return (metrics.authors || []).filter((a) => mergeChecked.has(a.key));
}

async function applyMergeResult(resp) {
  metrics = resp.metrics;
  mergeMode = false;
  mergeChecked.clear();
  populateFilterOptions();
  renderDashboard();
}

async function doMerge() {
  const name = $("#merge-name").value.trim();
  const email = $("#merge-email").value.trim();
  if (!name) {
    setStatus("error", "A merged author name is required.");
    return;
  }
  try {
    const resp = await api("/api/repos/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: repoState.active,
        rules: [{
          name,
          email,
          members: checkedAuthors().map((a) => ({ key: a.key, name: a.name, email: a.email })),
        }],
      }),
    });
    await applyMergeResult(resp);
  } catch (err) {
    setStatus("error", err.message);
  }
}

async function doMergeReset() {
  try {
    const resp = await api("/api/repos/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoState.active, clear: true }),
    });
    await applyMergeResult(resp);
  } catch (err) {
    setStatus("error", err.message);
  }
}

$("#table-area").addEventListener("click", (e) => {
  const id = e.target.id;
  if (id === "merge-enable") {
    mergeMode = true;
    mergeChecked.clear();
    renderTable();
  } else if (id === "merge-done") {
    mergeMode = false;
    mergeChecked.clear();
    renderTable();
  } else if (id === "merge-start") {
    $("#merge-form").hidden = false;
  } else if (id === "merge-apply") {
    doMerge();
  } else if (id === "merge-reset") {
    doMergeReset();
  }
});

$("#table-area").addEventListener("change", (e) => {
  if (e.target.matches("input[type=checkbox][data-key]")) {
    if (e.target.checked) mergeChecked.add(e.target.dataset.key);
    else mergeChecked.delete(e.target.dataset.key);
    renderTable();
  }
});

const TABLE_ROW_CAP = 500;

function tableRows() {
  const q = ($("#table-search").value || "").trim().toLowerCase();
  const all = currentTab === "authors"
    ? metrics.authors || []
    : currentTab === "files" ? metrics.files : metrics.dirs;
  if (!q) return { all, rows: all };
  const rows = all.filter((r) =>
    currentTab === "authors"
      ? r.name.toLowerCase().includes(q) || (r.email || "").toLowerCase().includes(q)
      : r.path.toLowerCase().includes(q));
  return { all, rows };
}

function renderTable() {
  let html = "";
  const { all, rows } = tableRows();
  const shown = rows.slice(0, TABLE_ROW_CAP);

  if (currentTab === "authors") {
    html = mergeBar() + mergeNote() +
      `<table><thead><tr>${mergeMode ? "<th></th>" : ""}${AUTHOR_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const a of shown) {
      html +=
        `<tr>` +
        (mergeMode
          ? `<td><input type="checkbox" data-key="${esc(a.key)}" ` +
            `${mergeChecked.has(a.key) ? "checked" : ""}></td>`
          : "") +
        `<td class="path" title="${esc(a.name)}">${esc(a.name)}</td>` +
        `<td class="path" title="${esc(a.email)}">${esc(a.email)}</td>` +
        `<td>${fmtInt(a.commits)}</td><td>${fmtInt(a.mods)}</td>` +
        `<td>${fmtInt(a.churn)}</td><td>${fmtPct(a.ownership)}</td></tr>`;
    }
  } else {
    html =
      `<table><thead><tr>${OBJECT_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const r of shown) {
      const label = r.path === "" ? "(repository root)" : r.path;
      html +=
        `<tr><td class="path" title="${esc(r.path)}">${esc(label)}</td>` +
        `<td>${fmtInt(r.added)}</td><td>${fmtInt(r.removed)}</td>` +
        `<td class="${r.growth >= 0 ? "pos" : "neg"}">${fmtSigned(r.growth)}</td>` +
        `<td>${fmtInt(r.churn)}</td><td>${fmtInt(r.mods)}</td>` +
        `<td>${fmtPct(r.freq)}</td><td>${fmtRate(r.rate)}</td></tr>`;
    }
  }
  html += "</tbody></table>";
  if (rows.length > TABLE_ROW_CAP) {
    html += `<div class="note table-cap">Showing the first ${fmtInt(TABLE_ROW_CAP)} of ` +
      `${fmtInt(rows.length)} rows — use the search box to narrow them down.</div>`;
  }
  $("#table-area").innerHTML = html;
  const noun = currentTab === "authors" ? "authors" : currentTab === "files" ? "files" : "directories";
  $("#table-count").textContent = rows.length === all.length
    ? `${fmtInt(all.length)} ${noun}`
    : `${fmtInt(rows.length)} of ${fmtInt(all.length)} ${noun}`;
}

init();
