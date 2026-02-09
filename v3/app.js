const state = {
  raw: null,
  records: [],
  filtered: [],
  sortBy: "priority",
  sortDir: "desc",
  tab: "board",
  filters: {
    keyword: "",
    execution: "all",
    data: "all",
    evidence: "all",
    priority: "all",
    owner: "all"
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
const FLOW_ORDER = ["todo", "in_progress", "blocked", "done"];
const WIP_LIMITS = {
  todo: 6,
  in_progress: 6,
  blocked: 2,
  done: 10
};

const PRESETS = [
  {
    key: "all",
    label: "全量视图",
    apply() {
      return {
        keyword: "",
        execution: "all",
        data: "all",
        evidence: "all",
        priority: "all",
        owner: "all"
      };
    }
  },
  {
    key: "blocked",
    label: "阻塞清理",
    apply() {
      return {
        ...state.filters,
        execution: "blocked",
        priority: "P0"
      };
    }
  },
  {
    key: "evidence",
    label: "材料补证",
    apply() {
      return {
        ...state.filters,
        evidence: "missing",
        owner: "材料专员"
      };
    }
  },
  {
    key: "code",
    label: "编号待确认",
    apply() {
      return {
        ...state.filters,
        owner: "项目经理"
      };
    }
  },
  {
    key: "sprint",
    label: "高风险冲刺",
    apply() {
      return {
        ...state.filters,
        priority: "P0",
        execution: "all"
      };
    }
  }
];

const $ = (id) => document.getElementById(id);

const els = {
  datasetMeta: $("datasetMeta"),
  overviewCards: $("overviewCards"),
  flowFunnel: $("flowFunnel"),
  keywordInput: $("keywordInput"),
  executionFilter: $("executionFilter"),
  dataFilter: $("dataFilter"),
  evidenceFilter: $("evidenceFilter"),
  priorityFilter: $("priorityFilter"),
  ownerFilter: $("ownerFilter"),
  quickPresets: $("quickPresets"),
  sortBy: $("sortBy"),
  sortDirBtn: $("sortDirBtn"),
  resetBtn: $("resetBtn"),
  resultMeta: $("resultMeta"),
  activePath: $("activePath"),
  boardGrid: $("boardGrid"),
  tableBody: $("tableBody"),
  collabMatrix: $("collabMatrix"),
  roleWorkload: $("roleWorkload"),
  alerts: $("alerts"),
  boardTab: $("boardTab"),
  tableTab: $("tableTab"),
  collabTab: $("collabTab"),
  tabButtons: Array.from(document.querySelectorAll(".tab")),
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

function esc(value) {
  return safe(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value) {
  return safe(value).toLowerCase();
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function parseDate(value) {
  if (!value) {
    return 0;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function tag(label, cls) {
  return `<span class="tag ${cls}">${esc(label)}</span>`;
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

function metricRate(metric) {
  if (!metric || metric.completed === null || metric.total === null || !metric.total) {
    return null;
  }
  const raw = Math.round((metric.completed / metric.total) * 100);
  return Math.max(0, Math.min(100, raw));
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

function inferOwner(record) {
  const ws = record.workflow_status || {};
  const flags = record.anomaly_flags || [];
  if (ws.execution_status === "blocked" || flags.includes("negative_gap_sci")) {
    return "PI负责人";
  }
  if (
    flags.includes("missing_or_pending_project_code") ||
    safe(record.project_code).includes("待确认") ||
    record.project_code_type === "未设置"
  ) {
    return "项目经理";
  }
  if (["missing", "partial"].includes(ws.evidence_status) || flags.includes("missing_ppt")) {
    return "材料专员";
  }
  return "数据专员";
}

function inferNextAction(record) {
  const ws = record.workflow_status || {};
  const flags = record.anomaly_flags || [];
  if (ws.execution_status === "blocked") {
    return "PI负责人发起阻塞评审并给出解锁方案";
  }
  if (ws.evidence_status === "missing") {
    return "材料专员补齐支撑材料与 PPT，回写 evidence 状态";
  }
  if (ws.evidence_status === "partial") {
    return "补齐证据映射并关联指标明细";
  }
  if (flags.includes("missing_or_pending_project_code")) {
    return "项目经理核实项目编号并更新主表";
  }
  if (ws.execution_status === "todo") {
    return "拆分为周任务并指定责任角色";
  }
  if (ws.execution_status === "done") {
    return "归档并输出可复用模板";
  }
  return "持续跟踪风险标签并准备验收材料";
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
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function renderPresets() {
  els.quickPresets.innerHTML = PRESETS.map((preset) => {
    return `<button class="preset" data-preset="${esc(preset.key)}">${esc(preset.label)}</button>`;
  }).join("");
}

function renderOverview() {
  const total = state.records.length;
  const filtered = state.filtered.length;
  const blocked = state.records.filter((record) => record.workflow_status?.execution_status === "blocked").length;
  const p0 = state.records.filter((record) => record.priority === "P0").length;
  const avgCompletion = total
    ? Math.round(state.records.reduce((sum, record) => sum + record.completion, 0) / total)
    : 0;
  const missingEvidence = state.records.filter((record) => {
    const evidence = record.workflow_status?.evidence_status;
    return evidence === "missing" || evidence === "partial";
  }).length;

  els.overviewCards.innerHTML = `
    <article class="overview-card">
      <p class="label">任务总量</p>
      <p class="value">${total}</p>
      <p class="note">筛选中 ${filtered} 条</p>
    </article>
    <article class="overview-card">
      <p class="label">阻塞任务</p>
      <p class="value">${blocked}</p>
      <p class="note">需 PI 介入处理</p>
    </article>
    <article class="overview-card">
      <p class="label">P0 优先级</p>
      <p class="value">${p0}</p>
      <p class="note">高风险冲刺对象</p>
    </article>
    <article class="overview-card">
      <p class="label">平均达成率</p>
      <p class="value">${avgCompletion}%</p>
      <p class="note">专利/EI/SCI 综合</p>
    </article>
    <article class="overview-card">
      <p class="label">待补证据项</p>
      <p class="value">${missingEvidence}</p>
      <p class="note">missing + partial</p>
    </article>
  `;
}

function renderFunnel() {
  const total = state.filtered.length || 1;
  els.flowFunnel.innerHTML = FLOW_ORDER.map((flow) => {
    const list = state.filtered.filter((record) => record.workflow_status?.execution_status === flow);
    const count = list.length;
    const width = Math.round((count / total) * 100);
    const limit = WIP_LIMITS[flow];
    const exceeded = count > limit;

    return `
      <article class="funnel-node">
        <div class="head">
          <span>${esc(EXEC_LABELS[flow])}</span>
          <span>WIP ${limit}</span>
        </div>
        <strong>${count}${exceeded ? " !" : ""}</strong>
        <div class="funnel-bar"><div class="funnel-fill" style="width:${width}%;"></div></div>
      </article>
    `;
  }).join("");
}

function renderActivePath() {
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

  chain.push(`视图=${state.tab}`);

  els.activePath.innerHTML = chain
    .map((item, index) => {
      const prefix = index === 0 ? "" : " -> ";
      return `<span class="path-chip">${esc(prefix + item)}</span>`;
    })
    .join("");
}

function sortRecords(list) {
  const arr = [...list];
  const dir = state.sortDir === "asc" ? 1 : -1;
  const priorityMap = { P0: 3, P1: 2, P2: 1 };

  arr.sort((a, b) => {
    if (state.sortBy === "priority") {
      return (num(priorityMap[a.priority]) - num(priorityMap[b.priority])) * dir;
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
    const keywordOk = keyword
      ? [record.project_name, record.project_code, record.record_id, record.target_summary]
          .map(text)
          .some((value) => value.includes(keyword))
      : true;

    const codePending =
      safe(record.project_code).includes("待确认") || record.project_code_type === "未设置";

    const ownerOk =
      state.filters.owner === "all" ||
      record.owner === state.filters.owner ||
      (state.filters.owner === "项目经理" && codePending);

    return (
      keywordOk &&
      (state.filters.execution === "all" || ws.execution_status === state.filters.execution) &&
      (state.filters.data === "all" || ws.data_status === state.filters.data) &&
      (state.filters.evidence === "all" || ws.evidence_status === state.filters.evidence) &&
      (state.filters.priority === "all" || record.priority === state.filters.priority) &&
      ownerOk
    );
  });

  state.filtered = sortRecords(state.filtered);
  renderAll();
}

function renderBoard() {
  els.boardGrid.innerHTML = FLOW_ORDER.map((lane) => {
    const list = state.filtered.filter((record) => record.workflow_status?.execution_status === lane);
    const limit = WIP_LIMITS[lane];
    const exceeded = list.length > limit;

    const cards = list
      .map((record) => {
        return `
          <article class="card" data-id="${esc(record.record_id)}">
            <p class="name">${esc(record.project_name)}</p>
            <p class="meta">${esc(record.record_id)} · ${esc(record.end_date)}</p>
            <div class="card-tags">
              ${tag(record.priority, `priority ${record.priority}`)}
              ${tag(record.owner, "owner")}
              ${tag(`风险 ${record.risk}`, "risk")}
            </div>
            <div class="next">${esc(record.nextAction)}</div>
          </article>
        `;
      })
      .join("");

    return `
      <section class="board-col">
        <div class="board-head">
          <span>${esc(EXEC_LABELS[lane])}</span>
          <span>${list.length}/${limit}${exceeded ? " 超限" : ""}</span>
        </div>
        <div class="board-body">${cards || "<p class='meta'>暂无任务</p>"}</div>
      </section>
    `;
  }).join("");
}

function renderTable() {
  if (!state.filtered.length) {
    els.tableBody.innerHTML = '<tr><td colspan="9">暂无匹配记录</td></tr>';
    return;
  }

  els.tableBody.innerHTML = state.filtered
    .map((record) => {
      const ws = record.workflow_status || {};
      const flow = `${safe(EXEC_LABELS[ws.execution_status])} -> ${safe(DATA_LABELS[ws.data_status])} -> ${safe(EVIDENCE_LABELS[ws.evidence_status])}`;
      return `
        <tr data-id="${esc(record.record_id)}">
          <td>${esc(record.record_id)}</td>
          <td class="project">${esc(record.project_name)}</td>
          <td>${tag(record.priority, `priority ${record.priority}`)}</td>
          <td>${tag(EXEC_LABELS[ws.execution_status] || safe(ws.execution_status), `execution ${safe(ws.execution_status)}`)}</td>
          <td>${tag(record.owner, "owner")}</td>
          <td>${esc(flow)}</td>
          <td>${esc(record.nextAction)}</td>
          <td>
            <div class="progress">
              <div class="bar"><div class="fill" style="width:${record.completion}%;"></div></div>
              <span>${record.completion}%</span>
            </div>
          </td>
          <td>${esc(record.end_date)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCollabMatrix() {
  const statusColumns = FLOW_ORDER;
  const rows = OWNER_ORDER.map((owner) => {
    const list = state.filtered.filter((record) => record.owner === owner);
    const cells = statusColumns
      .map((status) => list.filter((record) => record.workflow_status?.execution_status === status).length)
      .map((count) => `<td>${count}</td>`)
      .join("");

    const avg = list.length
      ? Math.round(list.reduce((sum, record) => sum + record.completion, 0) / list.length)
      : 0;

    return `<tr><td>${esc(owner)}</td>${cells}<td>${avg}%</td></tr>`;
  }).join("");

  const header = statusColumns.map((status) => `<th>${esc(EXEC_LABELS[status])}</th>`).join("");

  els.collabMatrix.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>角色</th>
          ${header}
          <th>平均达成率</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderRoleWorkload() {
  const html = OWNER_ORDER.map((owner) => {
    const list = state.filtered.filter((record) => record.owner === owner);
    const blocked = list.filter((record) => record.workflow_status?.execution_status === "blocked").length;
    const p0 = list.filter((record) => record.priority === "P0").length;
    const pending = list.filter((record) => {
      const evidence = record.workflow_status?.evidence_status;
      return evidence === "missing" || evidence === "partial";
    }).length;

    return `
      <div class="role-row">
        <div class="head">
          <strong>${esc(owner)}</strong>
          <span>${list.length} 项</span>
        </div>
        <div class="stats">
          ${tag(`阻塞 ${blocked}`, "risk")}
          ${tag(`P0 ${p0}`, "priority P0")}
          ${tag(`待补证 ${pending}`, "owner")}
        </div>
      </div>
    `;
  }).join("");

  els.roleWorkload.innerHTML = html;
}

function renderAlerts() {
  const blocked = state.filtered.filter((record) => record.workflow_status?.execution_status === "blocked").length;
  const evidenceMissing = state.filtered.filter((record) => record.workflow_status?.evidence_status === "missing").length;
  const evidencePartial = state.filtered.filter((record) => record.workflow_status?.evidence_status === "partial").length;
  const missingCode = state.filtered.filter((record) => {
    return safe(record.project_code).includes("待确认") || record.project_code_type === "未设置";
  }).length;
  const lowCompletion = state.filtered.filter((record) => record.completion < 50).length;

  const messages = [
    `阻塞任务 ${blocked} 条，优先处理状态卡点与责任拆分`,
    `证据缺失 ${evidenceMissing} 条，建议材料专员建立补证台账`,
    `证据部分匹配 ${evidencePartial} 条，需补齐指标映射`,
    `项目编号待确认 ${missingCode} 条，建议项目经理集中核验`,
    `达成率低于 50% 的任务 ${lowCompletion} 条，建议拆分短周期里程碑`
  ];

  els.alerts.innerHTML = messages.map((msg) => `<li>${esc(msg)}</li>`).join("");
}

function renderResultMeta() {
  els.resultMeta.textContent = `${state.filtered.length} / ${state.records.length} 记录`;
}

function renderAll() {
  renderOverview();
  renderFunnel();
  renderActivePath();
  renderResultMeta();
  renderBoard();
  renderTable();
  renderCollabMatrix();
  renderRoleWorkload();
  renderAlerts();
}

function showTab(tab) {
  state.tab = tab;
  els.boardTab.classList.toggle("hidden", tab !== "board");
  els.tableTab.classList.toggle("hidden", tab !== "table");
  els.collabTab.classList.toggle("hidden", tab !== "collab");

  els.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  renderActivePath();
}

function showDrawer(record) {
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
        return `<dt>${esc(name)}</dt><dd>-</dd>`;
      }
      return `<dt>${esc(name)}</dt><dd>完成 ${esc(metric.completed)} / 缺口 ${esc(metric.gap)} / 总量 ${esc(metric.total)}</dd>`;
    })
    .join("");

  els.drawerTitle.textContent = safe(record.project_name);
  els.drawerBody.innerHTML = `
    <dl class="dl">
      <dt>record_id</dt><dd>${esc(record.record_id)}</dd>
      <dt>source_table</dt><dd>${esc(record.source_table)}</dd>
      <dt>execution</dt><dd>${esc(EXEC_LABELS[ws.execution_status] || safe(ws.execution_status))}</dd>
      <dt>data_status</dt><dd>${esc(DATA_LABELS[ws.data_status] || safe(ws.data_status))}</dd>
      <dt>evidence_status</dt><dd>${esc(EVIDENCE_LABELS[ws.evidence_status] || safe(ws.evidence_status))}</dd>
      <dt>priority</dt><dd>${esc(record.priority)}</dd>
      <dt>owner</dt><dd>${esc(record.owner)}</dd>
      <dt>completion</dt><dd>${esc(record.completion)}%</dd>
      <dt>risk</dt><dd>${esc((record.anomaly_flags || []).join(", "))}</dd>
      <dt>project_code</dt><dd>${esc(record.project_code)}</dd>
      <dt>period_raw</dt><dd>${esc(record.period_raw)}</dd>
      <dt>end_date</dt><dd>${esc(record.end_date)}</dd>
      <dt>target_summary</dt><dd>${esc(record.target_summary)}</dd>
      <dt>next_action</dt><dd>${esc(record.nextAction)}</dd>
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

function resetFilters() {
  state.filters = {
    keyword: "",
    execution: "all",
    data: "all",
    evidence: "all",
    priority: "all",
    owner: "all"
  };

  els.keywordInput.value = "";
  els.executionFilter.value = "all";
  els.dataFilter.value = "all";
  els.evidenceFilter.value = "all";
  els.priorityFilter.value = "all";
  els.ownerFilter.value = "all";

  applyFilters();
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

  els.quickPresets.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-preset]");
    if (!button) {
      return;
    }
    const preset = PRESETS.find((item) => item.key === button.dataset.preset);
    if (!preset) {
      return;
    }
    state.filters = preset.apply();

    els.keywordInput.value = state.filters.keyword;
    els.executionFilter.value = state.filters.execution;
    els.dataFilter.value = state.filters.data;
    els.evidenceFilter.value = state.filters.evidence;
    els.priorityFilter.value = state.filters.priority;
    els.ownerFilter.value = state.filters.owner;

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

  els.resetBtn.addEventListener("click", resetFilters);

  els.tabButtons.forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });

  els.boardGrid.addEventListener("click", (event) => {
    const card = event.target.closest(".card[data-id]");
    if (!card) {
      return;
    }
    const record = state.filtered.find((item) => item.record_id === card.dataset.id);
    showDrawer(record);
  });

  els.tableBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) {
      return;
    }
    const record = state.filtered.find((item) => item.record_id === row.dataset.id);
    showDrawer(record);
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
    if (event.key === "1") {
      showTab("board");
    }
    if (event.key === "2") {
      showTab("table");
    }
    if (event.key === "3") {
      showTab("collab");
    }
  });
}

function init(data) {
  state.raw = data;
  state.records = (data.records || []).map(deriveRecord);

  fillSelect(els.executionFilter, data.status_flow?.execution_status || []);
  fillSelect(els.dataFilter, data.status_flow?.data_status || []);
  fillSelect(els.evidenceFilter, data.status_flow?.evidence_status || []);

  els.datasetMeta.textContent = `数据集: ${safe(data.dataset)} · 生成时间: ${safe(data.generated_at)}`;

  renderPresets();
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
