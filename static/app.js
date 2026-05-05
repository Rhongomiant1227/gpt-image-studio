const state = {
  config: null,
  status: null,
  history: [],
  uploads: [],
  selectedInputs: [],
  outputs: [],
  activeHistoryId: null,
  pollTimer: null,
  editingProfileName: null,
};

const $ = (selector) => document.querySelector(selector);

const els = {
  statusPill: $("#statusPill"),
  profileSelect: $("#profileSelect"),
  refreshStatusBtn: $("#refreshStatusBtn"),
  settingsBtn: $("#settingsBtn"),
  reloadHistoryBtn: $("#reloadHistoryBtn"),
  reloadUploadsBtn: $("#reloadUploadsBtn"),
  historySearch: $("#historySearch"),
  historyList: $("#historyList"),
  historyCount: $("#historyCount"),
  uploadGrid: $("#uploadGrid"),
  uploadCount: $("#uploadCount"),
  promptInput: $("#promptInput"),
  modeSelect: $("#modeSelect"),
  modeHint: $("#modeHint"),
  sizeSelect: $("#sizeSelect"),
  customSizeField: $("#customSizeField"),
  customSizeInput: $("#customSizeInput"),
  qualitySelect: $("#qualitySelect"),
  countInput: $("#countInput"),
  formatSelect: $("#formatSelect"),
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  inputStrip: $("#inputStrip"),
  selectionSummary: $("#selectionSummary"),
  clearBtn: $("#clearBtn"),
  generateBtn: $("#generateBtn"),
  resultMeta: $("#resultMeta"),
  resultGrid: $("#resultGrid"),
  busyOverlay: $("#busyOverlay"),
  toast: $("#toast"),
  settingsDialog: $("#settingsDialog"),
  closeSettingsBtn: $("#closeSettingsBtn"),
  settingsProfileSelect: $("#settingsProfileSelect"),
  profileNameInput: $("#profileNameInput"),
  baseUrlInput: $("#baseUrlInput"),
  apiKeyInput: $("#apiKeyInput"),
  modelInput: $("#modelInput"),
  configTestResult: $("#configTestResult"),
  addProfileBtn: $("#addProfileBtn"),
  deleteProfileBtn: $("#deleteProfileBtn"),
  testConfigBtn: $("#testConfigBtn"),
  saveConfigBtn: $("#saveConfigBtn"),
};

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.className = "toast hidden";
  }, 4200);
}

function setBusy(value) {
  els.busyOverlay.classList.toggle("hidden", !value);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { detail: text };
  }
  if (!response.ok) {
    const detail = payload?.detail || response.statusText;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

function formatTime(value) {
  const date = new Date(value.endsWith?.("Z") ? value : Number(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function shortBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isActiveJob(item) {
  return ["queued", "running", "canceling"].includes(item?.status);
}

function statusText(item) {
  const progress = item.progress || {};
  const done = progress.completed || item.completed_count || 0;
  const failed = progress.failed || item.failed_count || 0;
  const total = progress.total || item.count || 0;
  const suffix = total ? `${done}/${total}` : `${done}`;
  if (item.status === "running") return failed ? `运行中 ${suffix} · 失败 ${failed}` : `运行中 ${suffix}`;
  if (item.status === "queued") return `排队中 ${suffix}`;
  if (item.status === "canceling") return `取消中 ${suffix}`;
  if (item.status === "completed") return `完成 ${suffix}`;
  if (item.status === "partial") return `部分完成 ${suffix} · 失败 ${failed}`;
  if (item.status === "canceled") return `已取消 ${suffix}`;
  if (item.status === "interrupted") return `已中断 ${suffix}`;
  if (item.status === "failed") return `失败 ${suffix}`;
  return item.status || "未知状态";
}

function maybeStartPolling() {
  const hasActive = state.history.some(isActiveJob);
  if (hasActive && !state.pollTimer) {
    state.pollTimer = setInterval(loadHistory, 1800);
  }
  if (!hasActive && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function activeProfile() {
  return state.config?.profiles?.find((item) => item.name === state.config.active_profile);
}

async function loadConfig() {
  state.config = await api("/api/config");
  renderProfiles();
}

async function loadStatus() {
  els.statusPill.textContent = "检查中";
  els.statusPill.className = "status-pill pending";
  try {
    state.status = await api("/api/status");
    if (state.status.ok && state.status.model_found) {
      els.statusPill.textContent = "可用";
      els.statusPill.className = "status-pill ok";
    } else if (state.status.ok) {
      els.statusPill.textContent = "模型未列出";
      els.statusPill.className = "status-pill pending";
    } else {
      els.statusPill.textContent = "不可用";
      els.statusPill.className = "status-pill fail";
    }
  } catch (error) {
    els.statusPill.textContent = "不可用";
    els.statusPill.className = "status-pill fail";
    showToast(error.message, "fail");
  }
}

async function loadHistory() {
  const data = await api("/api/history?limit=160");
  state.history = data.items || [];
  renderHistory();
  if (state.activeHistoryId) {
    const active = state.history.find((item) => item.id === state.activeHistoryId);
    if (active) {
      renderResults(active.outputs || [], active);
    }
  }
  maybeStartPolling();
}

async function loadUploads() {
  const data = await api("/api/uploads");
  state.uploads = data.items || [];
  renderUploads();
}

function renderProfiles(settingsSelection = null) {
  const profiles = state.config?.profiles || [];
  const active = state.config?.active_profile;
  const settingsActive = settingsSelection || state.editingProfileName || active;
  els.profileSelect.innerHTML = "";
  els.settingsProfileSelect.innerHTML = "";
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.name;
    option.textContent = profile.name;
    if (profile.name === active) option.selected = true;
    els.profileSelect.append(option);

    const settingsOption = document.createElement("option");
    settingsOption.value = profile.name;
    settingsOption.textContent = profile.name;
    if (profile.name === settingsActive) settingsOption.selected = true;
    els.settingsProfileSelect.append(settingsOption);
  }
  const selected = profiles.find((item) => item.name === settingsActive) || activeProfile();
  fillSettingsForm(selected);
}

function fillSettingsForm(profile) {
  if (!profile) return;
  state.editingProfileName = profile.name || null;
  els.profileNameInput.value = profile.name || "";
  els.baseUrlInput.value = profile.base_url || "";
  els.apiKeyInput.value = "";
  els.apiKeyInput.placeholder = profile.has_api_key ? "已保存，留空则保留" : "粘贴 API key";
  els.modelInput.value = profile.model || "gpt-image-2";
  els.configTestResult.textContent = profile.has_api_key ? "已保存 API key" : "未配置 API key";
  els.configTestResult.className = profile.has_api_key ? "config-test ok" : "config-test fail";
}

function currentSize() {
  const selected = els.sizeSelect.value;
  return selected === "custom" ? els.customSizeInput.value.trim() : selected;
}

function renderHistory() {
  const query = els.historySearch.value.trim().toLowerCase();
  const items = state.history.filter((item) => !query || item.prompt.toLowerCase().includes(query));
  els.historyCount.textContent = `${state.history.length} 条记录`;
  els.historyList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无历史";
    els.historyList.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    const active = isActiveJob(item);
    card.className = `history-card ${active ? "active-job" : ""}`;
    card.tabIndex = 0;
    card.role = "button";
    card.dataset.id = item.id;
    const outputs = item.outputs || [];
    const percent = item.progress?.percent || 0;
    card.innerHTML = `
      <div class="history-meta">
        <span>${formatTime(item.created_at)}</span>
        <span>${item.mode} · ${item.size}</span>
      </div>
      <div class="job-status-row">
        <span class="job-status ${item.status}"></span>
        <span class="job-status-text"></span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="prompt-line"></div>
      <div class="thumb-row"></div>
      <div class="history-actions"></div>
    `;
    card.querySelector(".job-status").textContent = item.status || "";
    card.querySelector(".job-status-text").textContent = statusText(item);
    card.querySelector(".prompt-line").textContent = item.prompt;
    const thumbs = card.querySelector(".thumb-row");
    for (const image of outputs.slice(0, 4)) {
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = image.name;
      thumbs.append(img);
    }
    const actions = card.querySelector(".history-actions");
    if (active) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button danger tiny";
      cancel.textContent = "取消";
      cancel.addEventListener("click", (event) => {
        event.stopPropagation();
        cancelJob(item.id);
      });
      actions.append(cancel);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button ghost tiny";
    remove.textContent = "删除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteHistoryItem(item);
    });
    actions.append(remove);
    card.addEventListener("click", () => loadHistoryIntoForm(item));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadHistoryIntoForm(item);
    });
    els.historyList.append(card);
  }
}

function renderUploads() {
  els.uploadCount.textContent = `${state.uploads.length} 张图片`;
  els.uploadGrid.innerHTML = "";
  if (!state.uploads.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无导入图片";
    els.uploadGrid.append(empty);
    return;
  }
  const selected = new Set(state.selectedInputs.map((item) => item.id));
  for (const item of state.uploads) {
    const card = document.createElement("button");
    card.className = `upload-card ${selected.has(item.id) ? "selected" : ""}`;
    card.type = "button";
    card.innerHTML = `
      <img src="${item.url}" alt="">
      <div>
        <strong></strong>
        <span>${shortBytes(item.size)}</span>
      </div>
      <button class="upload-delete button ghost tiny" type="button">删除</button>
    `;
    card.querySelector("strong").textContent = item.name;
    card.querySelector(".upload-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteUploadImage(item);
    });
    card.addEventListener("click", () => toggleInputImage(item));
    els.uploadGrid.append(card);
  }
}

function renderInputStrip() {
  els.inputStrip.innerHTML = "";
  const count = state.selectedInputs.length;
  els.selectionSummary.textContent = count ? `已选择 ${count} 张参考图` : "未选择参考图";
  els.modeHint.textContent = count ? "将使用图片编辑接口" : "将使用文本生成接口";
  for (const item of state.selectedInputs) {
    const chip = document.createElement("div");
    chip.className = "input-chip";
    chip.innerHTML = `<img src="${item.url}" alt=""><button class="chip-remove" type="button">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.selectedInputs = state.selectedInputs.filter((selected) => selected.id !== item.id);
      renderInputStrip();
      renderUploads();
    });
    els.inputStrip.append(chip);
  }
}

function renderResults(outputs = state.outputs, record = null) {
  state.outputs = outputs || [];
  els.resultGrid.innerHTML = "";
  els.resultGrid.classList.toggle("empty", !state.outputs.length);
  if (!state.outputs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = record && isActiveJob(record) ? "任务运行中，单张完成后会出现在这里" : "生成结果会出现在这里";
    els.resultGrid.append(empty);
    els.resultMeta.textContent = record ? statusText(record) : "等待生成";
    return;
  }
  els.resultMeta.textContent = record ? statusText(record) : `${state.outputs.length} 张图片`;
  for (const item of state.outputs) {
    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <img src="${item.url}" alt="">
      <div class="result-actions">
        <a href="${item.url}" target="_blank" rel="noreferrer">打开</a>
        <a href="${item.url}" download>下载</a>
      </div>
    `;
    els.resultGrid.append(card);
  }
}

function toggleInputImage(item) {
  const exists = state.selectedInputs.some((selected) => selected.id === item.id);
  if (exists) {
    state.selectedInputs = state.selectedInputs.filter((selected) => selected.id !== item.id);
  } else {
    state.selectedInputs = [...state.selectedInputs, item];
  }
  renderInputStrip();
  renderUploads();
}

function loadHistoryIntoForm(item) {
  state.activeHistoryId = item.id;
  els.promptInput.value = item.prompt || "";
  els.modeSelect.value = item.mode || "auto";
  if ([...els.sizeSelect.options].some((option) => option.value === item.size)) {
    els.sizeSelect.value = item.size;
  } else {
    els.sizeSelect.value = "custom";
    els.customSizeInput.value = item.size;
  }
  els.customSizeField.classList.toggle("visible", els.sizeSelect.value === "custom");
  els.qualitySelect.value = item.quality || "high";
  els.countInput.value = item.count || 1;
  els.formatSelect.value = item.output_format || "png";
  state.selectedInputs = item.inputs || [];
  renderInputStrip();
  renderUploads();
  renderResults(item.outputs || [], item);
  showToast("已载入历史记录");
}

async function uploadFiles(files) {
  if (!files?.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file);
  try {
    const data = await api("/api/upload", { method: "POST", body: form });
    state.selectedInputs = [...state.selectedInputs, ...(data.items || [])];
    await loadUploads();
    renderInputStrip();
    showToast(`已导入 ${data.items.length} 张图片`);
  } catch (error) {
    showToast(error.message, "fail");
  }
}

function clipboardImageFiles(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const files = [];
  for (const item of items) {
    if (!item.type?.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const extension = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const namedFile = new File(
      [file],
      `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
      { type: item.type },
    );
    files.push(namedFile);
  }
  return files;
}

async function generate() {
  const prompt = els.promptInput.value.trim();
  if (!prompt) {
    showToast("请输入 prompt", "fail");
    return;
  }
  const body = {
    prompt,
    input_ids: state.selectedInputs.map((item) => item.id),
    size: currentSize(),
    quality: els.qualitySelect.value,
    output_format: els.formatSelect.value,
    count: Number(els.countInput.value || 1),
    mode: els.modeSelect.value,
    profile: els.profileSelect.value,
  };
  try {
    const record = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.activeHistoryId = record.id;
    renderResults(record.outputs || [], record);
    await loadHistory();
    showToast(`已提交 ${body.count} 张图片任务`, "ok");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

async function cancelJob(jobId) {
  try {
    const record = await api(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    if (state.activeHistoryId === jobId) renderResults(record.outputs || [], record);
    await loadHistory();
    showToast("已请求取消");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

async function deleteHistoryItem(item) {
  const active = isActiveJob(item);
  const message = active
    ? "这个项目仍在运行。删除会先取消任务，并从历史列表移除记录。确认删除？"
    : "确认从历史列表删除这条记录？";
  if (!window.confirm(message)) return;
  try {
    await api(`/api/history/${item.id}`, { method: "DELETE" });
    state.history = state.history.filter((historyItem) => historyItem.id !== item.id);
    if (state.activeHistoryId === item.id) {
      state.activeHistoryId = null;
      renderResults([]);
    }
    renderHistory();
    maybeStartPolling();
    showToast("历史记录已删除");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

async function deleteUploadImage(item) {
  if (!window.confirm("确认从图片库删除这张图片？历史记录中的旧引用不会被清空，但图片文件会被移除。")) return;
  try {
    await api(`/api/uploads/${item.id}`, { method: "DELETE" });
    state.uploads = state.uploads.filter((upload) => upload.id !== item.id);
    state.selectedInputs = state.selectedInputs.filter((selected) => selected.id !== item.id);
    renderUploads();
    renderInputStrip();
    showToast("图片已删除");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

function profileFromForm() {
  const profile = {
    name: els.profileNameInput.value.trim(),
    base_url: els.baseUrlInput.value.trim().replace(/\/$/, ""),
    model: els.modelInput.value.trim() || "gpt-image-2",
    previous_name: state.editingProfileName || els.settingsProfileSelect.value,
  };
  const key = els.apiKeyInput.value.trim();
  if (key) profile.api_key = key;
  return profile;
}

async function saveConfigFromForm() {
  const profile = profileFromForm();
  if (!profile.name || !profile.base_url) {
    showToast("Profile 名称和 Base URL 不能为空", "fail");
    return;
  }
  const map = new Map((state.config.profiles || []).map((item) => [item.name, item]));
  const oldName = els.settingsProfileSelect.value;
  if (oldName && oldName !== profile.name) map.delete(oldName);
  map.set(profile.name, profile);
  const profiles = Array.from(map.values()).map((item) => ({
    name: item.name,
    base_url: item.base_url,
    model: item.model || "gpt-image-2",
    ...(item.previous_name ? { previous_name: item.previous_name } : {}),
    ...(item.api_key ? { api_key: item.api_key } : {}),
  }));
  try {
    state.config = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ active_profile: profile.name, profiles }),
    });
    state.editingProfileName = profile.name;
    renderProfiles(profile.name);
    await loadStatus();
    showToast("配置已保存");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

async function testConfigFromForm() {
  const profile = profileFromForm();
  els.configTestResult.textContent = "测试中";
  els.configTestResult.className = "config-test";
  try {
    const result = await api("/api/config/test", {
      method: "POST",
      body: JSON.stringify(profile),
    });
    const found = result.model_found ? "模型可用" : "接口可用，但模型未在列表中";
    if (result.resolved_base_url) {
      els.baseUrlInput.value = result.resolved_base_url;
    }
    const checked = (result.checked || []).map((item) => item.base_url).join(" → ");
    els.configTestResult.textContent = `${found} · ${result.resolved_base_url || result.base_url || profile.base_url}${checked ? ` · 已检查 ${checked}` : ""}`;
    els.configTestResult.className = result.ok ? "config-test ok" : "config-test fail";
  } catch (error) {
    els.configTestResult.textContent = error.message;
    els.configTestResult.className = "config-test fail";
  }
}

function addProfile() {
  const name = `profile-${Date.now().toString().slice(-5)}`;
  const profile = {
    name,
    base_url: "",
    model: "gpt-image-2",
    has_api_key: false,
  };
  state.config.profiles.push(profile);
  renderProfiles(name);
  els.settingsProfileSelect.value = name;
  fillSettingsForm(profile);
}

async function deleteCurrentProfile() {
  if ((state.config.profiles || []).length <= 1) {
    showToast("至少保留一个 Profile", "fail");
    return;
  }
  const name = els.settingsProfileSelect.value;
  if (!window.confirm(`确认删除 Profile「${name}」？`)) return;
  const remaining = state.config.profiles.filter((item) => item.name !== name);
  const active = state.config.active_profile === name ? remaining[0].name : state.config.active_profile;
  try {
    state.config = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        active_profile: active,
        profiles: remaining.map((item) => ({
          name: item.name,
          base_url: item.base_url,
          model: item.model || "gpt-image-2",
        })),
      }),
    });
    state.editingProfileName = active;
    renderProfiles(active);
    await loadStatus();
    showToast("Profile 已删除");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

function bindEvents() {
  els.refreshStatusBtn.addEventListener("click", loadStatus);
  els.reloadHistoryBtn.addEventListener("click", loadHistory);
  els.reloadUploadsBtn.addEventListener("click", loadUploads);
  els.historySearch.addEventListener("input", renderHistory);
  els.sizeSelect.addEventListener("change", () => {
    els.customSizeField.classList.toggle("visible", els.sizeSelect.value === "custom");
  });
  els.profileSelect.addEventListener("change", async () => {
    try {
      state.config = await api("/api/config/active", {
        method: "POST",
        body: JSON.stringify({ name: els.profileSelect.value }),
      });
      state.editingProfileName = els.profileSelect.value;
      renderProfiles(els.profileSelect.value);
      await loadStatus();
      showToast("Profile 已切换");
    } catch (error) {
      showToast(error.message, "fail");
    }
  });
  els.settingsBtn.addEventListener("click", () => els.settingsDialog.showModal());
  els.settingsProfileSelect.addEventListener("change", () => {
    const profile = state.config.profiles.find((item) => item.name === els.settingsProfileSelect.value);
    fillSettingsForm(profile);
  });
  els.addProfileBtn.addEventListener("click", addProfile);
  els.deleteProfileBtn.addEventListener("click", deleteCurrentProfile);
  els.saveConfigBtn.addEventListener("click", saveConfigFromForm);
  els.testConfigBtn.addEventListener("click", testConfigFromForm);
  els.closeSettingsBtn.addEventListener("click", () => els.settingsDialog.close());
  els.generateBtn.addEventListener("click", generate);
  els.clearBtn.addEventListener("click", () => {
    els.promptInput.value = "";
    state.selectedInputs = [];
    renderInputStrip();
    renderUploads();
  });
  els.dropZone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => uploadFiles(els.fileInput.files));
  for (const eventName of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragover");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragover");
    });
  }
  els.dropZone.addEventListener("drop", (event) => {
    uploadFiles(event.dataTransfer.files);
  });
  document.addEventListener("paste", (event) => {
    const files = clipboardImageFiles(event);
    if (!files.length) return;
    event.preventDefault();
    uploadFiles(files);
  });
}

async function init() {
  bindEvents();
  renderResults([]);
  try {
    await loadConfig();
    await Promise.all([loadStatus(), loadHistory(), loadUploads()]);
    renderInputStrip();
  } catch (error) {
    showToast(error.message, "fail");
  }
}

init();
