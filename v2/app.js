const state = {
  raw: null,
  records: [],
  filtered: [],
  sortBy: "priority",
  sortDir: "desc",
  view: "table",
  compact: false,
  filters: {
    keyword: "",
    execution: "all",
    data: "all",
    evidence: "all",
    priority: "all",
    owner: "all",
    source: "all",
    risk: "all"
  }
};

const EXEC_LABELS = {
  todo: "待开始",
  in_progress: "进行中",
  blocked: "阻塞",
  done: "完成"
};

const DATA_LABELS = {
  draft: "草稿",
  pending_validation: "待校验",
  validated: "已校验",
  locked: "已锁定",
  archived: "已归档"
};

const EVIDENCE_LABELS = {
  missing: "缺失",
  partial: "部分匹配",
  matched: "已匹配",
  approved: "已确认"
};

const OWNER_ORDER = ["项目经理", "数据专员", "材料专员", "PI负责人"];
const BOARD_LANES = ["todo", "in_progress", "blocked", "done"];

const $ = (id) => document.getElementById(id);

const els = {
  appShell: document.querySelector(".app-shell"),
  datasetMeta: $("datasetMeta"),
  kpiGrid: $("kpiGrid"),
  flowGrid: $("flowGrid"),
  keywordInput: $("keywordInput"),
  executionFilter: $("executionFilter"),
  dataFilter: $("dataFilter"),
  evidenceFilter: $("evidenceFilter"),
  priorityFilter: $("priorityFilter"),
  ownerFilter: $("ownerFilter"),
  sourceFilter: $("sourceFilter"),
  riskFilter: $("riskFilter"),
  sortBy: $("sortBy"),
  sortDirBtn: $("sortDirBtn"),
  densityBtn: $("densityBtn"),
  resetBtn: $("resetBtn"),
  tableTabBtn: $("tableTabBtn"),
  boardTabBtn: $("boardTabBtn"),
  resultMeta: $("resultMeta"),
  activeChain: $("activeChain"),
  tableView: $("tableView"),
  boardView: $("boardView"),
  tableBody: $("tableBody"),
  boardGrid: $("boardGrid"),
  roleList: $("roleList"),
  alertList: $("alertList"),
  drawerOverlay: $("drawerOverlay"),
  drawerTitle: $("drawerTitle"),
  drawerBody: $("drawerBody"),
  drawerClose: $("drawerClose")
};

function safe(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function escapeHtml(value) {
  return safe(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toText(value) {
  return safe(value).toLowerCase();
}

function toNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function parseDate(value) {
  if (!value) {
    return 0;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function scorePriority(record) {
  const flags = record.anomaly_flags || [];
  const ws = record.workflow_status || {};
  if (ws.execution_status === "blocked" || flags.includes("negative_gap_sci")) {
    return "P0";
  }
  if (flags.length > 0 || ["missing", "partial"].includes(ws.evidence_status)) {
    return "P1";
  }
  return "P2";
}

function inferOwner(record) {
  const ws = record.workflow_status || {};
  const flags = record.anomaly_flags || [];
  const code = safe(record.project_code);
  if (ws.execution_status === "blocked" || flags.includes("negative_gap_sci")) {
    return "PI负责人";
  }
  if (
    flags.includes("missing_or_pending_project_code") ||
    code.includes("待确认") ||
    record.project_code_type === "未设置"
  ) {
    return "项目经理";
  }
  if (["missing", "partial"].includes(ws.evidence_status) || flags.includes("missing_ppt")) {
    return "材料专员";
  }
  return "数据专员";
}

function metricRate(metric) {
  if (!metric || metric.completed === null || metric.total === null || !metric.total) {
    return null;
  }
  const rate = Math.round((metric.completed / metric.total) * 100);
  return Math.max(0, Math.min(100, rate));
}

function calcCompletion(record) {
  const metrics = record.metrics || {};
  const rates = [
    metricRate(metrics.invention_patent),
    metricRate(metrics.ei),
    metricRate(metrics.sci)
  ].filter((n) => n !== null);

  if (!rates.length) {
    return 0;
  }
  return Math.round(rates.reduce((sum, n) => sum + n, 0) / rates.length);
}

function inferNextAction(record) {
  const ws = record.workflow_status || {};
  const flags = record.anomaly_flags || [];
  if (ws.execution_status === "blocked") {
    return "安排 PI 评审会，拆解阻塞根因并重排里程碑";
  }
  if (ws.evidence_status === "missing") {
    return "材料专员补齐支撑材料与 PPT 附件";
  }
  if (ws.evidence_status === "partial") {
    return "补证据映射，完成材料与指标一一对应";
  }
  if (flags.includes("missing_or_pending_project_code")) {
    return "项目经理确认项目编号并回填主表";
  }
  if (ws.data_status === "pending_validation") {
    return "数据专员完成字段核验后锁定";
  }
  if (ws.execution_status === "todo") {
    return "建立执行分工并确认本周交付清单";
  }
  if (ws.execution_status === "done") {
    return "归档成果并沉淀复盘要点";
  }
  return "维持当前推进节奏并跟踪风险标签";
}

function deriveRecord(record) {
  const priority = scorePriority(record);
  const owner = inferOwner(record);
  const completion = calcCompletion(record);
  const risk = (record.anomaly_flags || []).length;
  return {
    ...record,
    priority,
    owner,
    completion,
    risk,
    nextAction: inferNextAction(record)
  };
}

function fillSelect(select, values) {
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部";
  select.appendChild(all);
  values.forEach((value) => {
    if (!value) {
      return;
    }
    const item = document.createElement("option");
    item.value = value;
    item.textContent = value;
    select.appendChild(item);
  });
}

function tag(label, className) {
  return `<span class="tag ${className}">${escapeHtml(label)}</span>`;
}

function renderFlowTags(record) {
  const ws = record.workflow_status || {};
  return `
    <div class="flow-tags">
      ${tag(EXEC_LABELS[ws.execution_status] || safe(ws.execution_status), `execution ${safe(ws.execution_status)}`)}
      ${tag(DATA_LABELS[ws.data_status] || safe(ws.data_status), "data")}
      ${tag(EVIDENCE_LABELS[ws.evidence_status] || safe(ws.evidence_status), `evidence ${safe(ws.evidence_status)}`)}
    </div>
  `;
}

function renderKpis() {
  const total = state.records.length;
  const filtered = state.filtered.length;
  const p0 = state.records.filter((r) => r.priority === "P0").length;
  const blocked = state.records.filter((r) => r.workflow_status?.execution_status === "blocked").length;
  const avgCompletion = total
    ? Math.round(state.records.reduce((sum, r) => sum + r.completion, 0) / total)
    : 0;
  const missingEvidence = state.records.filter((r) => {
    const evidence = r.workflow_status?.evidence_status;
    return evidence === "missing" || evidence === "partial";
  }).length;

  els.kpiGrid.innerHTML = `
    <article class="kpi-card">
      <p class="kpi-label">任务总量</p>
      <p class="kpi-value">${total}</p>
      <p class="kpi-note">当前筛选 ${filtered} 条</p>
    </article>
    <article class="kpi-card">
      <p class="kpi-label">P0 紧急项</p>
      <p class="kpi-value">${p0}</p>
      <p class="kpi-note">优先级高于常规推进</p>
    </article>
    <article class="kpi-card">
      <p class="kpi-label">阻塞项</p>
      <p class="kpi-value">${blocked}</p>
      <p class="kpi-note">需 PI/管理层介入</p>
    </article>
    <article class="kpi-card">
      <p class="kpi-label">平均达成率</p>
      <p class="kpi-value">${avgCompletion}%</p>
      <p class="kpi-note">专利 + EI + SCI 综合</p>
    </article>
    <article class="kpi-card">
      <p class="kpi-label">证据待补项</p>
      <p class="kpi-value">${missingEvidence}</p>
      <p class="kpi-note">missing / partial</p>
    </article>
  `;
}

function renderFlowGrid() {
  const total = state.filtered.length || 1;
  els.flowGrid.innerHTML = BOARD_LANES.map((lane) => {
    const count = state.filtered.filter((r) => r.workflow_status?.execution_status === lane).length;
    const width = Math.round((count / total) * 100);
    return `
      <article class="flow-node">
        <div class="flow-head">
          <span>${escapeHtml(EXEC_LABELS[lane])}</span>
          <span>${count}</span>
        </div>
        <div class="flow-value">${count}</div>
        <div class="flow-bar"><div class="flow-fill" style="width:${width}%;"></div></div>
      </article>
    `;
  }).join("");
}

function renderActiveChain() {
  const chain = [];
  if (state.filters.keyword) {
    chain.push(`关键词=${state.filters.keyword}`);
  }
  if (state.filters.execution !== "all") {
    chain.push(`执行=${state.filters.execution}`);
  }
  if (state.filters.data !== "all") {
    chain.push(`数据=${state.filters.data}`);
  }
  if (state.filters.evidence !== "all") {
    chain.push(`证据=${state.filters.evidence}`);
  }
  if (state.filters.priority !== "all") {
    chain.push(`优先级=${state.filters.priority}`);
  }
  if (state.filters.owner !== "all") {
    chain.push(`角色=${state.filters.owner}`);
  }
  if (state.filters.source !== "all") {
    chain.push(`来源=${state.filters.source}`);
  }
  if (state.filters.risk !== "all") {
    chain.push(`风险=${state.filters.risk}`);
  }

  if (!chain.length) {
    els.activeChain.innerHTML = '<span class="chain-chip">当前无筛选条件</span>';
    return;
  }

  els.activeChain.innerHTML = chain
    .map((item, index) => {
      const prefix = index === 0 ? "" : " -> ";
      return `<span class="chain-chip">${escapeHtml(prefix + item)}</span>`;
    })
    .join("");
}

function sortRecords(list) {
  const arr = [...list];
  const dir = state.sortDir === "asc" ? 1 : -1;
  const priMap = { P0: 3, P1: 2, P2: 1 };

  arr.sort((a, b) => {
    if (state.sortBy === "priority") {
      return (toNumber(priMap[a.priority]) - toNumber(priMap[b.priority])) * dir;
    }
    if (state.sortBy === "end_date") {
      return (parseDate(a.end_date) - parseDate(b.end_date)) * dir;
    }
    if (state.sortBy === "risk") {
      return (a.risk - b.risk) * dir;
    }
    if (state.sortBy === "completion") {
      return (a.completion - b.completion) * dir;
    }
    return 0;
  });

  return arr;
}

function applyFilters() {
  const keyword = state.filters.keyword.toLowerCase();
  state.filtered = state.records.filter((record) => {
    const ws = record.workflow_status || {};
    const hasRisk = record.risk > 0;
    const keywordOk = keyword
      ? [record.project_name, record.project_code, record.record_id, record.target_summary]
          .map(toText)
          .some((value) => value.includes(keyword))
      : true;

    return (
      keywordOk &&
      (state.filters.execution === "all" || ws.execution_status === state.filters.execution) &&
      (state.filters.data === "all" || ws.data_status === state.filters.data) &&
      (state.filters.evidence === "all" || ws.evidence_status === state.filters.evidence) &&
      (state.filters.priority === "all" || record.priority === state.filters.priority) &&
      (state.filters.owner === "all" || record.owner === state.filters.owner) &&
      (state.filters.source === "all" || record.source_table === state.filters.source) &&
      (state.filters.risk === "all" || (state.filters.risk === "yes" ? hasRisk : !hasRisk))
    );
  });

  state.filtered = sortRecords(state.filtered);
  renderAll();
}

function renderTable() {
  if (!state.filtered.length) {
    els.tableBody.innerHTML = '<tr><td colspan="9">没有匹配记录</td></tr>';
    return;
  }

  els.tableBody.innerHTML = state.filtered
    .map((record) => {
      return `
        <tr data-id="${escapeHtml(record.record_id)}">
          <td>${escapeHtml(record.record_id)}</td>
          <td class="project-name">${escapeHtml(record.project_name)}</td>
          <td>${renderFlowTags(record)}</td>
          <td>${tag(record.priority, `priority ${record.priority}`)}</td>
          <td>${tag(record.owner, "owner")}</td>
          <td>${tag(`风险 ${record.risk}`, "risk")}</td>
          <td>
            <div class="progress">
              <div class="progress-bar"><div class="progress-fill" style="width:${record.completion}%;"></div></div>
              <span>${record.completion}%</span>
            </div>
          </td>
          <td><div class="next-action">${escapeHtml(record.nextAction)}</div></td>
          <td>${escapeHtml(record.end_date)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderBoard() {
  els.boardGrid.innerHTML = BOARD_LANES.map((lane) => {
    const list = state.filtered.filter((r) => r.workflow_status?.execution_status === lane);
    const cards = list
      .map((record) => {
        return `
          <article class="board-card" data-id="${escapeHtml(record.record_id)}">
            <p class="card-title">${escapeHtml(record.project_name)}</p>
            <p class="card-meta">${escapeHtml(record.record_id)} · ${escapeHtml(record.end_date)}</p>
            <div class="card-tags">
              ${tag(record.priority, `priority ${record.priority}`)}
              ${tag(record.owner, "owner")}
              ${tag(`风险 ${record.risk}`, "risk")}
            </div>
            <div class="card-next">${escapeHtml(record.nextAction)}</div>
          </article>
        `;
      })
      .join("");

    return `
      <section class="board-col">
        <div class="board-col-head">
          <strong>${escapeHtml(EXEC_LABELS[lane])}</strong>
          <span>${list.length}</span>
        </div>
        <div class="board-col-body">${cards || "<p class='card-meta'>暂无任务</p>"}</div>
      </section>
    `;
  }).join("");
}

function renderRoleList() {
  const cards = OWNER_ORDER.map((owner) => {
    const list = state.filtered.filter((record) => record.owner === owner);
    const blocked = list.filter((record) => record.workflow_status?.execution_status === "blocked").length;
    const p0 = list.filter((record) => record.priority === "P0").length;
    const avg = list.length
      ? Math.round(list.reduce((sum, record) => sum + record.completion, 0) / list.length)
      : 0;

    return `
      <article class="role-card">
        <div class="role-head">
          <strong>${escapeHtml(owner)}</strong>
          <span>${list.length} 项</span>
        </div>
        <div class="role-stats">
          <span class="stat">阻塞 ${blocked}</span>
          <span class="stat">P0 ${p0}</span>
          <span class="stat">均值 ${avg}%</span>
        </div>
      </article>
    `;
  });

  els.roleList.innerHTML = cards.join("");
}

function renderAlerts() {
  const blocked = state.filtered.filter((record) => record.workflow_status?.execution_status === "blocked").length;
  const missingPpt = state.filtered.filter((record) => (record.anomaly_flags || []).includes("missing_ppt")).length;
  const pendingCode = state.filtered.filter((record) => {
    const code = safe(record.project_code);
    return code.includes("待确认") || record.project_code_type === "未设置";
  }).length;
  const lowCompletion = state.filtered.filter((record) => record.completion < 50).length;

  const alerts = [
    `阻塞项 ${blocked} 条，建议优先按 PI 评审链路推进`,
    `缺少 PPT ${missingPpt} 条，材料专员需本周补齐`,
    `待确认项目编号 ${pendingCode} 条，建议项目经理统一核实`,
    `达成率低于 50% 的条目 ${lowCompletion} 条，需拆分阶段目标`
  ];

  els.alertList.innerHTML = alerts.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderResultMeta() {
  els.resultMeta.textContent = `${state.filtered.length} / ${state.records.length} 记录`;
}

function renderAll() {
  renderKpis();
  renderFlowGrid();
  renderActiveChain();
  renderResultMeta();
  renderTable();
  renderBoard();
  renderRoleList();
  renderAlerts();
}

function openDrawer(record) {
  if (!record) {
    return;
  }
  const ws = record.workflow_status || {};
  const metrics = record.metrics || {};
  const metricRows = [
    ["中核", metrics.zhonghe],
    ["发明专利", metrics.invention_patent],
    ["软著", metrics.software_copyright],
    ["EI", metrics.ei],
    ["SCI", metrics.sci]
  ]
    .map(([name, metric]) => {
      if (!metric) {
        return `<dt>${escapeHtml(name)}</dt><dd>-</dd>`;
      }
      return `<dt>${escapeHtml(name)}</dt><dd>完成 ${escapeHtml(metric.completed)} / 缺口 ${escapeHtml(metric.gap)} / 总量 ${escapeHtml(metric.total)}</dd>`;
    })
    .join("");

  els.drawerTitle.textContent = safe(record.project_name);
  els.drawerBody.innerHTML = `
    <dl class="detail-grid">
      <dt>record_id</dt><dd>${escapeHtml(record.record_id)}</dd>
      <dt>source_table</dt><dd>${escapeHtml(record.source_table)}</dd>
      <dt>状态流转</dt><dd>${escapeHtml(EXEC_LABELS[ws.execution_status] || safe(ws.execution_status))} / ${escapeHtml(DATA_LABELS[ws.data_status] || safe(ws.data_status))} / ${escapeHtml(EVIDENCE_LABELS[ws.evidence_status] || safe(ws.evidence_status))}</dd>
      <dt>priority</dt><dd>${escapeHtml(record.priority)}</dd>
      <dt>owner</dt><dd>${escapeHtml(record.owner)}</dd>
      <dt>project_code</dt><dd>${escapeHtml(record.project_code)}</dd>
      <dt>period_raw</dt><dd>${escapeHtml(record.period_raw)}</dd>
      <dt>end_date</dt><dd>${escapeHtml(record.end_date)}</dd>
      <dt>target_summary</dt><dd>${escapeHtml(record.target_summary)}</dd>
      <dt>anomaly_flags</dt><dd>${escapeHtml((record.anomaly_flags || []).join(", "))}</dd>
      <dt>next_action</dt><dd>${escapeHtml(record.nextAction)}</dd>
      ${metricRows}
    </dl>
  `;

  els.drawerOverlay.classList.add("open");
  els.drawerOverlay.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  els.drawerOverlay.classList.remove("open");
  els.drawerOverlay.setAttribute("aria-hidden", "true");
}

function setView(view) {
  state.view = view;
  if (view === "table") {
    els.tableView.classList.remove("hidden");
    els.boardView.classList.add("hidden");
    els.tableTabBtn.classList.add("active");
    els.boardTabBtn.classList.remove("active");
  } else {
    els.boardView.classList.remove("hidden");
    els.tableView.classList.add("hidden");
    els.boardTabBtn.classList.add("active");
    els.tableTabBtn.classList.remove("active");
  }
}

function bindEvents() {
  els.keywordInput.addEventListener("input", (event) => {
    state.filters.keyword = event.target.value.trim();
    applyFilters();
  });

  els.executionFilter.addEventListener("change", (event) => {
    state.filters.execution = event.target.value;
    applyFilters();
  });

  els.dataFilter.addEventListener("change", (event) => {
    state.filters.data = event.target.value;
    applyFilters();
  });

  els.evidenceFilter.addEventListener("change", (event) => {
    state.filters.evidence = event.target.value;
    applyFilters();
  });

  els.priorityFilter.addEventListener("change", (event) => {
    state.filters.priority = event.target.value;
    applyFilters();
  });

  els.ownerFilter.addEventListener("change", (event) => {
    state.filters.owner = event.target.value;
    applyFilters();
  });

  els.sourceFilter.addEventListener("change", (event) => {
    state.filters.source = event.target.value;
    applyFilters();
  });

  els.riskFilter.addEventListener("change", (event) => {
    state.filters.risk = event.target.value;
    applyFilters();
  });

  els.sortBy.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    applyFilters();
  });

  els.sortDirBtn.addEventListener("click", () => {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    els.sortDirBtn.textContent = state.sortDir === "asc" ? "升序" : "降序";
    applyFilters();
  });

  els.densityBtn.addEventListener("click", () => {
    state.compact = !state.compact;
    els.appShell.classList.toggle("compact", state.compact);
    els.densityBtn.textContent = `紧凑模式: ${state.compact ? "开" : "关"}`;
  });

  els.resetBtn.addEventListener("click", () => {
    state.filters = {
      keyword: "",
      execution: "all",
      data: "all",
      evidence: "all",
      priority: "all",
      owner: "all",
      source: "all",
      risk: "all"
    };

    els.keywordInput.value = "";
    els.executionFilter.value = "all";
    els.dataFilter.value = "all";
    els.evidenceFilter.value = "all";
    els.priorityFilter.value = "all";
    els.ownerFilter.value = "all";
    els.sourceFilter.value = "all";
    els.riskFilter.value = "all";

    applyFilters();
  });

  els.tableTabBtn.addEventListener("click", () => setView("table"));
  els.boardTabBtn.addEventListener("click", () => setView("board"));

  els.tableBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) {
      return;
    }
    const record = state.filtered.find((item) => item.record_id === row.dataset.id);
    openDrawer(record);
  });

  els.boardGrid.addEventListener("click", (event) => {
    const card = event.target.closest(".board-card");
    if (!card) {
      return;
    }
    const record = state.filtered.find((item) => item.record_id === card.dataset.id);
    openDrawer(record);
  });

  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerOverlay.addEventListener("click", (event) => {
    if (event.target === els.drawerOverlay) {
      closeDrawer();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
    }
    if (event.key === "/") {
      event.preventDefault();
      els.keywordInput.focus();
    }
  });
}

function init(data) {
  state.raw = data;
  state.records = (data.records || []).map(deriveRecord);

  fillSelect(els.executionFilter, data.status_flow?.execution_status || []);
  fillSelect(els.dataFilter, data.status_flow?.data_status || []);
  fillSelect(els.evidenceFilter, data.status_flow?.evidence_status || []);
  fillSelect(els.sourceFilter, [...new Set(state.records.map((record) => record.source_table))]);

  const dataset = safe(data.dataset);
  const generatedAt = safe(data.generated_at);
  els.datasetMeta.textContent = `数据集: ${dataset} · 生成时间: ${generatedAt}`;

  state.filtered = sortRecords(state.records);
  renderAll();
  bindEvents();
}

function loadData() {
  fetch("./data.json")
    .then((res) => res.json())
    .then(init)
    .catch(() => {
      els.datasetMeta.textContent = "数据加载失败";
    });
}

loadData();
