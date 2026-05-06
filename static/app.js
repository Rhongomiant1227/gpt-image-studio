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
  draftProfile: null,
  profileFormOrigin: null,
};

const DRAFT_PROFILE_ID = "__draft_profile__";

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
  discardProfileBtn: $("#discardProfileBtn"),
  testConfigBtn: $("#testConfigBtn"),
  saveConfigBtn: $("#saveConfigBtn"),
  saveAndSwitchConfigBtn: $("#saveAndSwitchConfigBtn"),
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
  const summary = compactStatusSummary(item);
  let text = item.status || "unknown";
  if (item.status === "running") text = failed ? `运行中 ${suffix} · 失败 ${failed}` : `运行中 ${suffix}`;
  else if (item.status === "queued") text = `排队中 ${suffix}`;
  else if (item.status === "canceling") text = `取消中 ${suffix}`;
  else if (item.status === "completed") text = `完成 ${suffix}`;
  else if (item.status === "partial") text = `部分完成 ${suffix} · 失败 ${failed}`;
  else if (item.status === "canceled") text = `已取消 ${suffix}`;
  else if (item.status === "interrupted") text = `已中断 ${suffix}`;
  else if (item.status === "failed") text = `失败 ${suffix}`;
  return summary ? `${text} · ${summary}` : text;
}

function firstErrorLine(item) {
  const first = item?.errors?.find?.((entry) => entry?.trim()) || item?.error?.split?.("\n")?.find?.((entry) => entry?.trim()) || "";
  return first.replace(/^#\d+:\s*/, "").trim();
}

function friendlyErrorText(message) {
  const text = (message || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "";
  if (lower.includes("getaddrinfo failed")) {
    return "无法连接到服务地址：DNS 解析失败，请检查当前 Profile 的 Base URL。";
  }
  if (lower.includes("invalid api key") || lower.includes('\"code\":\"invalid_api_key\"')) {
    return "API Key 无效，请检查当前 Profile 的密钥。";
  }
  if (lower.includes("concurrency limit exceeded")) {
    return "并发已满（429）：当前同时运行的任务太多，请减少并发或稍后重试。";
  }
  if (lower.includes("rate limit") && lower.includes("429")) {
    return "请求被限流（429）：请稍后重试，或减少同时运行的任务数量。";
  }
  if (lower.includes("content safety service is temporarily unavailable")) {
    return "服务商内容安全服务暂时不可用（503），请稍后重试。";
  }
  if (lower.includes("image api returned no image payloads")) {
    return "接口没有返回图片数据。通常是服务商兼容性问题或上游异常。";
  }
  if (lower.includes("image api error 502")) {
    return "服务商上游服务异常（502），请稍后重试。";
  }
  if (lower.includes("image api error 503")) {
    return "服务商暂时不可用（503），请稍后重试。";
  }
  if (lower.includes("image api error 504") || lower.includes("timed out") || lower.includes("timeout")) {
    return "请求超时，请稍后重试。";
  }
  if (lower.includes("unable to connect to the remote server") || lower.includes("all connection attempts failed")) {
    return "无法连接到服务，请检查网络、代理或 Base URL。";
  }
  return text;
}

function jobErrorSummary(item) {
  return friendlyErrorText(firstErrorLine(item));
}

function fallbackSummary(item) {
  const request = item?.request || {};
  if (!request?.fallback_used || !request?.last_profile) return "";
  return `已切换 ${request.last_profile}`;
}

function compactStatusSummary(item) {
  const error = jobErrorSummary(item);
  if (error) return error;
  return fallbackSummary(item);
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

function normalizeProfileForForm(profile = {}) {
  return {
    name: profile.name || "",
    base_url: (profile.base_url || "").replace(/\/$/, ""),
    model: profile.model || "gpt-image-2",
  };
}

function currentSettingsSelection() {
  if (state.draftProfile) return DRAFT_PROFILE_ID;
  return state.editingProfileName || state.config?.active_profile || "";
}

function formProfileSnapshot() {
  return {
    name: els.profileNameInput.value.trim(),
    base_url: els.baseUrlInput.value.trim().replace(/\/$/, ""),
    model: els.modelInput.value.trim() || "gpt-image-2",
    api_key: els.apiKeyInput.value.trim(),
  };
}

function hasUnsavedProfileChanges() {
  const original = state.profileFormOrigin || normalizeProfileForForm();
  const current = formProfileSnapshot();
  return (
    current.name !== original.name
    || current.base_url !== original.base_url
    || current.model !== original.model
    || Boolean(current.api_key)
  );
}

function draftProfileLabel() {
  const name = state.draftProfile?.name?.trim();
  return name ? `新 Profile: ${name}` : "新 Profile";
}

function syncDraftProfileState() {
  if (!state.draftProfile) return;
  const current = formProfileSnapshot();
  state.draftProfile = {
    ...state.draftProfile,
    name: current.name,
    base_url: current.base_url,
    model: current.model,
  };
  const option = els.settingsProfileSelect.querySelector(`option[value="${DRAFT_PROFILE_ID}"]`);
  if (option) option.textContent = draftProfileLabel();
}

function refreshConfigActions() {
  const selection = currentSettingsSelection();
  const dirty = hasUnsavedProfileChanges();
  const required = Boolean(els.profileNameInput.value.trim() && els.baseUrlInput.value.trim());
  els.testConfigBtn.disabled = !els.baseUrlInput.value.trim();
  els.saveConfigBtn.disabled = !required || !dirty;
  els.saveAndSwitchConfigBtn.disabled = !required || !dirty;
  els.discardProfileBtn.disabled = selection !== DRAFT_PROFILE_ID && !dirty;
  if (selection === DRAFT_PROFILE_ID) {
    els.deleteProfileBtn.disabled = false;
    els.deleteProfileBtn.textContent = "放弃草稿";
  } else {
    els.deleteProfileBtn.disabled = (state.config?.profiles || []).length <= 1;
    els.deleteProfileBtn.textContent = "删除";
  }
}

function confirmDiscardProfileChanges() {
  if (!hasUnsavedProfileChanges()) return true;
  return window.confirm("当前 Profile 有未保存修改，确定放弃吗？");
}

function validateProfileBeforeSave(profile) {
  const lowered = (profile.base_url || "").toLowerCase();
  if (/\bexample\.(test|com|org|net)\b/.test(lowered)) {
    throw new Error("Base URL 仍然是占位地址，请换成真实可用的服务地址。");
  }
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
  const settingsActive = settingsSelection || currentSettingsSelection() || active;
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
  if (state.draftProfile) {
    const draftOption = document.createElement("option");
    draftOption.value = DRAFT_PROFILE_ID;
    draftOption.textContent = draftProfileLabel();
    if (settingsActive === DRAFT_PROFILE_ID) draftOption.selected = true;
    els.settingsProfileSelect.append(draftOption);
  }
  const selected = settingsActive === DRAFT_PROFILE_ID
    ? state.draftProfile
    : profiles.find((item) => item.name === settingsActive) || activeProfile();
  fillSettingsForm(selected);
}

function fillSettingsForm(profile) {
  if (!profile) return;
  const normalized = normalizeProfileForForm(profile);
  state.editingProfileName = profile.__draft ? DRAFT_PROFILE_ID : profile.name || null;
  state.profileFormOrigin = normalized;
  els.profileNameInput.value = normalized.name;
  els.baseUrlInput.value = normalized.base_url;
  els.apiKeyInput.value = "";
  els.apiKeyInput.placeholder = profile.has_api_key ? "已保存，留空则保留" : "粘贴 API key";
  els.modelInput.value = normalized.model;
  if (profile.__draft) {
    els.configTestResult.textContent = "新 Profile 尚未保存";
    els.configTestResult.className = "config-test pending";
  } else if (profile.has_api_key) {
    els.configTestResult.textContent = "已保存 API key";
    els.configTestResult.className = "config-test ok";
  } else {
    els.configTestResult.textContent = "未配置 API key";
    els.configTestResult.className = "config-test";
  }
  refreshConfigActions();
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
    const statusLine = card.querySelector(".job-status-text");
    const verboseMessage = item.error || (item.errors || []).join("\n");
    if (verboseMessage) statusLine.title = verboseMessage;
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
    const errorSummary = record ? compactStatusSummary(record) : "";
    empty.textContent = record && isActiveJob(record)
      ? "任务运行中，单张完成后会出现在这里"
      : (errorSummary || "生成结果会出现在这里");
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
  const previousName = state.editingProfileName === DRAFT_PROFILE_ID
    ? null
    : state.editingProfileName || els.settingsProfileSelect.value;
  const profile = {
    name: els.profileNameInput.value.trim(),
    base_url: els.baseUrlInput.value.trim().replace(/\/$/, ""),
    model: els.modelInput.value.trim() || "gpt-image-2",
  };
  if (previousName) profile.previous_name = previousName;
  const key = els.apiKeyInput.value.trim();
  if (key) profile.api_key = key;
  return profile;
}

function buildProfilesPayload(profile) {
  const previousName = state.editingProfileName === DRAFT_PROFILE_ID
    ? null
    : state.editingProfileName || els.settingsProfileSelect.value;
  if (profile.name !== previousName && (state.config?.profiles || []).some((item) => item.name === profile.name)) {
    throw new Error(`Profile 已存在：${profile.name}`);
  }
  const map = new Map((state.config.profiles || []).map((item) => [item.name, item]));
  if (previousName && previousName !== profile.name) map.delete(previousName);
  map.set(profile.name, profile);
  return {
    previousName,
    profiles: Array.from(map.values()).map((item) => ({
      name: item.name,
      base_url: item.base_url,
      model: item.model || "gpt-image-2",
      ...(item.previous_name ? { previous_name: item.previous_name } : {}),
      ...(item.api_key ? { api_key: item.api_key } : {}),
    })),
  };
}

async function persistProfile({ activate }) {
  const profile = profileFromForm();
  if (!profile.name || !profile.base_url) {
    showToast("Profile 名称和 Base URL 不能为空", "fail");
    return;
  }
  try {
    validateProfileBeforeSave(profile);
    const oldActive = state.config.active_profile;
    const { previousName, profiles } = buildProfilesPayload(profile);
    const nextActive = activate
      ? profile.name
      : (oldActive === previousName ? profile.name : oldActive);
    state.config = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ active_profile: nextActive, profiles }),
    });
    state.draftProfile = null;
    state.editingProfileName = profile.name;
    renderProfiles(profile.name);
    if (oldActive === previousName || oldActive === profile.name || oldActive !== state.config.active_profile) {
      await loadStatus();
    }
    showToast(activate ? "配置已保存并切换" : "配置已保存");
  } catch (error) {
    showToast(error.message, "fail");
  }
}

async function saveConfigFromForm() {
  await persistProfile({ activate: false });
}

async function saveAndSwitchConfigFromForm() {
  await persistProfile({ activate: true });
}

async function testConfigFromForm() {
  const profile = profileFromForm();
  els.configTestResult.textContent = "测试中";
  els.configTestResult.className = "config-test pending";
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
    els.configTestResult.className = result.model_found ? "config-test ok" : (result.ok ? "config-test pending" : "config-test fail");
    refreshConfigActions();
  } catch (error) {
    els.configTestResult.textContent = error.message;
    els.configTestResult.className = "config-test fail";
  }
}

function addProfile() {
  if (!confirmDiscardProfileChanges()) return;
  state.draftProfile = {
    __draft: true,
    name: "",
    base_url: "",
    model: "gpt-image-2",
    has_api_key: false,
  };
  renderProfiles(DRAFT_PROFILE_ID);
  els.profileNameInput.focus();
  showToast("已创建 Profile 草稿");
}

function discardProfileEdits() {
  const wasDraft = state.editingProfileName === DRAFT_PROFILE_ID;
  if (!confirmDiscardProfileChanges()) return;
  if (wasDraft) {
    state.draftProfile = null;
    renderProfiles(state.config?.active_profile);
  } else {
    renderProfiles(state.editingProfileName || state.config?.active_profile);
  }
  showToast("已放弃未保存修改");
}

function closeSettingsDialog() {
  const wasDraft = state.editingProfileName === DRAFT_PROFILE_ID;
  if (!confirmDiscardProfileChanges()) return;
  if (wasDraft) {
    state.draftProfile = null;
    renderProfiles(state.config?.active_profile);
  } else {
    renderProfiles(state.editingProfileName || state.config?.active_profile);
  }
  els.settingsDialog.close();
}

async function deleteCurrentProfile() {
  const selection = currentSettingsSelection();
  if (selection === DRAFT_PROFILE_ID) {
    if (!confirmDiscardProfileChanges()) return;
    state.draftProfile = null;
    renderProfiles(state.config?.active_profile);
    showToast("已放弃未保存 Profile");
    return;
  }
  if ((state.config.profiles || []).length <= 1) {
    showToast("至少保留一个 Profile", "fail");
    return;
  }
  const name = els.settingsProfileSelect.value;
  const message = hasUnsavedProfileChanges()
    ? `确认删除 Profile「${name}」？未保存的修改也会一起丢弃。`
    : `确认删除 Profile「${name}」？`;
  if (!window.confirm(message)) return;
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
    state.draftProfile = null;
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
  for (const input of [els.profileNameInput, els.baseUrlInput, els.apiKeyInput, els.modelInput]) {
    input.addEventListener("input", () => {
      syncDraftProfileState();
      refreshConfigActions();
    });
  }
  els.profileSelect.addEventListener("change", async () => {
    const target = els.profileSelect.value;
    const previous = state.config.active_profile;
    if (els.settingsDialog.open && !confirmDiscardProfileChanges()) {
      els.profileSelect.value = previous;
      return;
    }
    if (els.settingsDialog.open && state.editingProfileName === DRAFT_PROFILE_ID) {
      state.draftProfile = null;
    }
    try {
      state.config = await api("/api/config/active", {
        method: "POST",
        body: JSON.stringify({ name: target }),
      });
      state.editingProfileName = target;
      renderProfiles(target);
      await loadStatus();
      showToast("Profile 已切换");
    } catch (error) {
      showToast(error.message, "fail");
    }
  });
  els.settingsBtn.addEventListener("click", () => {
    renderProfiles(currentSettingsSelection() || state.config?.active_profile);
    els.settingsDialog.showModal();
  });
  els.settingsProfileSelect.addEventListener("change", () => {
    const target = els.settingsProfileSelect.value;
    const current = currentSettingsSelection();
    if (target === current) return;
    if (!confirmDiscardProfileChanges()) {
      els.settingsProfileSelect.value = current;
      return;
    }
    if (current === DRAFT_PROFILE_ID) state.draftProfile = null;
    const profile = target === DRAFT_PROFILE_ID
      ? state.draftProfile
      : state.config.profiles.find((item) => item.name === target);
    fillSettingsForm(profile);
  });
  els.addProfileBtn.addEventListener("click", addProfile);
  els.deleteProfileBtn.addEventListener("click", deleteCurrentProfile);
  els.discardProfileBtn.addEventListener("click", discardProfileEdits);
  els.saveConfigBtn.addEventListener("click", saveConfigFromForm);
  els.saveAndSwitchConfigBtn.addEventListener("click", saveAndSwitchConfigFromForm);
  els.testConfigBtn.addEventListener("click", testConfigFromForm);
  els.closeSettingsBtn.addEventListener("click", (event) => {
    event.preventDefault();
    closeSettingsDialog();
  });
  els.settingsDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettingsDialog();
  });
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
