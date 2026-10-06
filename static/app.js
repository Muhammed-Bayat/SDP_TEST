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
  populateFilterOptions();
  renderDashboard();
}

function resetFilterInputs() {
  $("#filter-author").value = "";
  $("#filter-path").value = "";
  $("#filter-start").value = "";
  $("#filter-end").value = "";
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
    .map((p) => `<option value="${esc(p)}">`)
    .join("");
}

async function applyFilters() {
  const author = $("#filter-author").value;
  const path = $("#filter-path").value.trim();
  const start = $("#filter-start").value;
  const end = $("#filter-end").value;
  const params = new URLSearchParams();
  if (repoState.active) params.set("repo", repoState.active);
  if (author) params.set("author", author);
  if (path) params.set("path", path);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  setStatus("loading", "Applying filters…");
  try {
    metrics = await api("/api/metrics?" + params.toString());
    if (!(author || path || start || end)) populateFilterOptions();
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
  if (!am.author_count) return "";
  if (!merged.length) {
    return `<div class="note merge-note">Author merging (.mailmap): all ` +
      `${fmtInt(am.raw_identity_count)} identities are already canonical — no merges needed.</div>`;
  }
  const example = merged[0];
  const from = example.from[0];
  return `<div class="note merge-note">Author merging (.mailmap): ` +
    `${fmtInt(am.raw_identity_count)} raw identities resolved to ` +
    `${fmtInt(am.author_count)} authors (${merged.length} merged). ` +
    `E.g. “${esc(from.name)} &lt;${esc(from.email)}&gt;” → ` +
    `“${esc(example.name)} &lt;${esc(example.email)}&gt;”.</div>`;
}

function renderTable() {
  let html = "";
  let count = 0;

  if (currentTab === "authors") {
    count = metrics.authors.length;
    html = mergeNote() +
      `<table><thead><tr>${AUTHOR_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const a of metrics.authors) {
      html +=
        `<tr><td class="path" title="${esc(a.name)}">${esc(a.name)}</td>` +
        `<td class="path" title="${esc(a.email)}">${esc(a.email)}</td>` +
        `<td>${fmtInt(a.commits)}</td><td>${fmtInt(a.mods)}</td>` +
        `<td>${fmtInt(a.churn)}</td><td>${fmtPct(a.ownership)}</td></tr>`;
    }
  } else {
    const rows = currentTab === "files" ? metrics.files : metrics.dirs;
    count = rows.length;
    html =
      `<table><thead><tr>${OBJECT_COLS.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
    for (const r of rows) {
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
  $("#table-area").innerHTML = html;
  $("#table-count").textContent = `${fmtInt(count)} ${
    currentTab === "authors" ? "authors" : currentTab === "files" ? "files" : "directories"
  }`;
}

init();
