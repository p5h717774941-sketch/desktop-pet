import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { DEMO_SPRITE, SPRITE_PRESET } from "./sprite-demo.js";
import { createFenzaiProfile } from "./fenzai-sprite.js";
import { createMomoProfile } from "./momo-sprite.js";
import "./fenzai.css";
import { setupMattingComponent, buildLocalMatting } from "./local-matting.js";

// ===== 状态 =====
// 宠物档案对象：{ id, name, hobby, personality, src, mode, status, sprite?, ...运行时字段 }
//   status: 'active'（已放出，桌面游走）| 'stored'（已收回，只待在仓库）
//   mode: 'image'（单图，可用）| 'sprite'（2D 灵动帧动画，可用）| 'vrm'（3D，开发中）
//   sprite: { src, frameW, frameH, actions:{ idle/walk/eat/happy: {row,count,fps,loop} } }
let pets = [];
let idc = 0;
let store = null;
let coverTargetId = null;
const alertsDone = {};
const PATROL_MARGIN = 36;
const PATROL_WIDTH = 320;
const PATROL_HEIGHT = 220;
let mousePosition = { x: innerWidth - 120, y: innerHeight - 120 };
const IS_PANEL = getCurrentWindow().label === "main";

// 提醒全部由用户自定义：默认空列表
// 每项：{ id, label, type:'time'|'interval', time:"HH:MM", interval:分钟, message, repeat:'daily'|'weekday', enabled, lastFired }
const settings = {
  reminders: [],
  attentionMinutes: 20,
  attentionEnabled: true,
  speechStyle: "default",
  petSize: 120,
  petSizeScope: "all",
  petSizePetId: null,
};

// ===== 持久化 =====
async function initStore() {
  try {
    store = await load("settings.json", { autoSave: true });
    const s = await store.get("settings");
    if (s) Object.assign(settings, s);
    return true;
  } catch (e) {
    console.warn("store 不可用，回退 localStorage", e);
    store = null;
    try {
      const raw = localStorage.getItem("pet-backup");
      if (raw) Object.assign(settings, JSON.parse(raw).settings || {});
    } catch (e2) {}
    return false;
  }
}

// 内置动作的版本由代码管理；用户动作和用户替换版本分开保存，避免两者互相覆盖。
function officialProfileForPreset(presetId) {
  if (presetId === "fenzai-v1") return createFenzaiProfile();
  if (presetId === "momo-v1") return createMomoProfile();
  return null;
}

function officialActionNames(presetId) {
  return new Set(Object.keys(officialProfileForPreset(presetId)?.sprite?.actions || {}));
}

function persistableSprite(sprite) {
  if (!sprite) return null;
  const officialNames = officialActionNames(sprite.presetId);
  if (!officialNames.size) return sprite;
  const additions = Object.fromEntries(Object.entries(sprite.actions || {}).filter(([name, action]) => action?.userGenerated && !officialNames.has(name)));
  const actionOverrides = Object.fromEntries(Object.entries(sprite.actionOverrides || {}).filter(([name, action]) => action?.userGenerated && officialNames.has(name)));
  return { ...sprite, actions: additions, actionOverrides };
}

// 只持久化档案字段，运行时字段（el/x/y/vx/vy/...）不落盘
function petProfile(p) {
  return {
    id: p.id,
    name: p.name,
    hobby: p.hobby || "",
    personality: p.personality || "",
    src: p.src,
    mode: p.mode || "image",
    status: p.status || "active",
    sprite: persistableSprite(p.sprite),
    cover: p.cover || p.src,
    size: p.size,
  };
}

async function persist() {
  const payload = { settings, pets: pets.map(petProfile) };
  if (store) {
    try {
      await store.set("settings", settings);
      await store.set("pets", payload.pets);
      await emit("store-changed", payload);
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  try {
    localStorage.setItem("pet-backup", JSON.stringify(payload));
    await emit("store-changed", payload);
  } catch (e) {}
}

function isDataImage(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}

function dataUrlParts(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mime: match[1], data: match[2] } : null;
}

async function saveUserFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // 分块避免大图片在 String.fromCharCode 时超过调用栈限制。
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const path = await invoke("save_user_asset", { filename: file.name || "pet.png", dataBase64: btoa(binary) });
  return convertFileSrc(path);
}

async function migrateDataImage(value, filename) {
  const parsed = dataUrlParts(value);
  if (!parsed) return value;
  const extension = parsed.mime.split("/")[1] || "png";
  const path = await invoke("save_user_asset", { filename: `${filename}.${extension}`, dataBase64: parsed.data });
  return convertFileSrc(path);
}

async function migrateLegacyAssets(profiles) {
  let changed = false;
  for (const p of profiles || []) {
    // 内置资源由代码重新提供，不能也不需要迁移。
    if (["fenzai-v1", "momo-v1"].includes(p.sprite?.presetId)) continue;
    if (isDataImage(p.src)) { p.src = await migrateDataImage(p.src, p.name || "pet"); changed = true; }
    if (p.sprite && isDataImage(p.sprite.src)) { p.sprite.src = await migrateDataImage(p.sprite.src, `${p.name || "pet"}-sprite`); changed = true; }
    if (isDataImage(p.cover)) { p.cover = await migrateDataImage(p.cover, `${p.name || "pet"}-cover`); changed = true; }
  }
  return changed;
}

// ===== 仓库封面裁剪（固定 3:4，支持拖动与缩放） =====
let coverCrop = null;

function clampCoverCrop() {
  if (!coverCrop) return;
  const { viewport, image } = coverCrop;
  const maxX = image.offsetLeft + image.clientWidth - coverCrop.width;
  const maxY = image.offsetTop + image.clientHeight - coverCrop.height;
  coverCrop.x = Math.max(image.offsetLeft, Math.min(maxX, coverCrop.x));
  coverCrop.y = Math.max(image.offsetTop, Math.min(maxY, coverCrop.y));
}

function renderCoverCrop() {
  if (!coverCrop) return;
  clampCoverCrop();
  const selection = document.getElementById("cropSelection");
  selection.style.left = coverCrop.x + "px";
  selection.style.top = coverCrop.y + "px";
  selection.style.width = coverCrop.width + "px";
  selection.style.height = coverCrop.height + "px";
}

function closeCoverCropper() {
  const modal = document.getElementById("coverCropper");
  if (coverCrop?.url) URL.revokeObjectURL(coverCrop.url);
  coverCrop = null;
  modal.hidden = true;
}

function openCoverCropper(file) {
  const modal = document.getElementById("coverCropper");
  const viewport = document.getElementById("cropViewport");
  const image = document.getElementById("cropImage");
  const url = URL.createObjectURL(file);
  modal.hidden = false;
  image.onload = () => {
    const scale = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
    image.style.width = image.naturalWidth * scale + "px";
    image.style.height = image.naturalHeight * scale + "px";
    image.style.left = (viewport.clientWidth - image.naturalWidth * scale) / 2 + "px";
    image.style.top = (viewport.clientHeight - image.naturalHeight * scale) / 2 + "px";
    const maxWidth = image.naturalWidth * scale;
    const maxHeight = image.naturalHeight * scale;
    const height = Math.min(maxHeight, maxWidth / .75, 300);
    const width = height * .75;
    coverCrop = { file, url, viewport, image, scale, width, height, x: image.offsetLeft + (maxWidth - width) / 2, y: image.offsetTop + (maxHeight - height) / 2 };
    renderCoverCrop();
  };
  image.src = url;
}

function setupCoverCropper() {
  const modal = document.getElementById("coverCropper");
  const viewport = document.getElementById("cropViewport");
  const selection = document.getElementById("cropSelection");
  document.getElementById("cropCancel").addEventListener("click", closeCoverCropper);
  document.getElementById("cropCancelTop").addEventListener("click", closeCoverCropper);
  selection.addEventListener("pointerdown", (event) => {
    if (!coverCrop) return;
    selection.setPointerCapture(event.pointerId);
    const handle = event.target.closest(".crop-handle")?.className.split(" ").at(-1);
    coverCrop.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: coverCrop.x, startY: coverCrop.y, startW: coverCrop.width, handle };
    selection.classList.add("dragging");
  });
  selection.addEventListener("pointermove", (event) => {
    const drag = coverCrop?.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.handle) {
      coverCrop.x = drag.startX + dx;
      coverCrop.y = drag.startY + dy;
    } else {
      const signX = drag.handle.includes("w") ? -1 : 1;
      const signY = drag.handle.includes("n") ? -1 : 1;
      const delta = Math.abs(dx) > Math.abs(dy) ? dx * signX : dy * signY;
      const maxW = Math.min(coverCrop.image.clientWidth, coverCrop.image.clientHeight * .75);
      const width = Math.max(72, Math.min(maxW, drag.startW + delta));
      const height = width / .75;
      coverCrop.width = width;
      coverCrop.height = height;
      if (drag.handle.includes("w")) coverCrop.x = drag.startX + drag.startW - width;
      if (drag.handle.includes("n")) coverCrop.y = drag.startY + drag.startW / .75 - height;
    }
    renderCoverCrop();
  });
  const endDrag = () => { if (coverCrop) coverCrop.drag = null; selection.classList.remove("dragging"); };
  selection.addEventListener("pointerup", endDrag);
  selection.addEventListener("pointercancel", endDrag);
  document.getElementById("cropConfirm").addEventListener("click", async () => {
    if (!coverCrop) return;
    const state = coverCrop;
    const p = pets.find((item) => item.id === coverTargetId);
    if (!p) return closeCoverCropper();
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 800;
    const ratio = canvas.width / state.width;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(state.image, (state.image.offsetLeft - state.x) * ratio, (state.image.offsetTop - state.y) * ratio, state.image.clientWidth * ratio, state.image.clientHeight * ratio);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    try {
      p.cover = await saveUserFile(new File([blob], "pinkmo-cover.png", { type: "image/png" }));
      await persist();
      renderWarehouse();
      closeCoverCropper();
    } catch (err) {
      console.error("保存裁剪封面失败", err);
      alert(`无法保存封面：${String(err)}`);
    }
  });
}

// 当前放出的宠物（有 DOM 元素在桌面游走的）
function activePets() {
  return pets.filter((p) => p.status === "active" && p.el);
}

function patrolBounds(size) {
  return {
    minX: Math.max(10, innerWidth - size - PATROL_WIDTH),
    maxX: Math.max(10, innerWidth - size - PATROL_MARGIN),
    minY: Math.max(10, innerHeight - size - PATROL_HEIGHT),
    maxY: Math.max(10, innerHeight - size - PATROL_MARGIN),
  };
}

function randomPatrolPosition(size) {
  const b = patrolBounds(size);
  return {
    x: b.minX + Math.random() * Math.max(1, b.maxX - b.minX),
    y: b.minY + Math.random() * Math.max(1, b.maxY - b.minY),
  };
}

// ===== 面板交互 =====
function togglePanel() {
  document.getElementById("panel").classList.toggle("collapsed");
}

function applySettingsToUI() {
  if (!IS_PANEL) return;
  renderReminders();
  renderWarehouse();
  renderActionManager();
  const count = document.getElementById("petCount");
  if (count) count.textContent = pets.length ? `${pets.filter((p) => p.status === "active").length} 位宠物正在桌面` : "还没有领养宠物";
  const attentionInput = document.getElementById("attentionMinutes");
  if (attentionInput) attentionInput.value = settings.attentionMinutes;
  const attentionToggle = document.getElementById("attentionEnabled");
  if (attentionToggle) {
    const on = settings.attentionEnabled !== false;
    attentionToggle.classList.toggle("on", on);
    attentionToggle.setAttribute("aria-checked", String(on));
  }
  const speechStyle = document.getElementById("speechStyle");
  if (speechStyle) speechStyle.value = settings.speechStyle || "default";
  const petSize = document.getElementById("petSize");
  const scope = settings.petSizeScope === "single" ? "single" : "all";
  settings.petSizeScope = scope;
  const sizeScope = document.getElementById("petSizeScope");
  if (sizeScope) sizeScope.value = scope;
  const target = document.getElementById("petSizeTarget");
  const targetRow = document.getElementById("petSizeTargetRow");
  if (target) {
    if (!pets.some((p) => p.id === Number(settings.petSizePetId))) settings.petSizePetId = pets[0]?.id || null;
    target.innerHTML = pets.map((p) => `<option value="${p.id}">${escapeAttr(p.name)}</option>`).join("");
    target.value = String(settings.petSizePetId || "");
  }
  if (targetRow) targetRow.style.display = scope === "single" ? "flex" : "none";
  const shownSize = scope === "single" ? pets.find((p) => p.id === Number(settings.petSizePetId))?.size : settings.petSize;
  if (petSize) petSize.value = normalizedPetSize(shownSize);
  const petSizeValue = document.getElementById("petSizeValue");
  if (petSizeValue) petSizeValue.textContent = normalizedPetSize(shownSize) + " px";
}

function renderActionManager() {
  const box = document.getElementById("actionManager");
  if (!box) return;
  if (!pets.length) {
    box.innerHTML = '<div class="empty-card">还没有宠物可管理。</div>';
    return;
  }
  if (!pets.some((p) => p.id === settings.actionPetId)) settings.actionPetId = pets[0].id;
  const p = pets.find((item) => item.id === settings.actionPetId) || pets[0];
  const actionNames = {
    idle: "站立待机", idleSit: "坐姿待机", lookAround: "好奇张望", sleep: "趴下睡觉", groom: "舔爪洗脸", stretch: "伸懒腰", yawn: "打哈欠", walkRight: "向右走", walkLeft: "向左走", wave: "挥爪", jump: "跳跃",
    failed: "委屈", waiting: "等待", working: "工作", review: "查看", happy: "开心", eat: "吃东西",
  };
  const actions = p.sprite?.actions || {};
  const officialNames = officialActionNames(p.sprite?.presetId);
  const actionOverrides = p.sprite?.actionOverrides || {};
  const picker = document.getElementById("actionPetSelect");
  if (picker) picker.innerHTML = pets.map((item) => `<option value="${item.id}"${item.id === p.id ? " selected" : ""}>${escapeAttr(item.name)}</option>`).join("");
  box.innerHTML = `<div class="action-grid">${Object.entries(actionNames).map(([name, label]) => {
      const a = actions[name];
      const source = actionOverrides[name] ? "我的版本" : officialNames.has(name) ? "内置" : "自定义";
      return a
        ? `<div class="action-card"><strong>${label}</strong><small>${source} · ${a.count} 帧 · ${a.fps || 8} fps</small>${actionOverrides[name] ? `<button class="action-restore" data-action-restore="${name}" type="button">恢复内置版本</button>` : ""}</div>`
        : `<div class="action-card locked"><strong>${label}</strong><small>未解锁</small></div>`;
    }).join("")}</div>`;
}

function attentionDelayMs() {
  const minutes = Math.max(1, Math.min(240, Number(settings.attentionMinutes) || 20));
  return minutes * 60 * 1000;
}

function normalizedPetSize(value = settings.petSize) {
  return Math.max(60, Math.min(320, Number(value) || 120));
}

function resizePet(p, size = normalizedPetSize()) {
  p.size = size;
  if (!p.el) return;
  if (p.bodyEl && p.sprite) {
    const grid = p.sprite.grid || spriteGrid(p.sprite);
    p.bodyEl.style.width = size + "px";
    p.bodyEl.style.height = size + "px";
    p.bodyEl.style.backgroundSize = grid.cols * size + "px " + grid.rows * size + "px";
  } else {
    const image = p.el.querySelector(".body");
    if (image) image.style.width = size + "px";
  }
  p.x = Math.max(0, Math.min(innerWidth - size, p.x));
  p.y = Math.max(0, Math.min(innerHeight - size, p.y));
  p.el.style.left = p.x + "px";
  p.el.style.top = p.y + "px";
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function todayKey() {
  return new Date().toDateString();
}

function reminderCompleted(r) {
  if (r.type === "interval") return Boolean(r.completedAt && r.completedAt >= (r.lastFired || 0));
  return r.completedDay === todayKey();
}

// ===== 提醒列表（渲染） =====
function renderReminders() {
  const list = document.getElementById("reminderList");
  if (!list) return;
  list.innerHTML = "";
  settings.reminders.forEach((r) => {
    const row = document.createElement("div");
    row.className = "reminder";
    row.dataset.id = r.id;
    const isInterval = r.type === "interval";
    const completed = reminderCompleted(r);
    row.innerHTML = `
      <div class="r-top">
        <input class="r-label" value="${escapeAttr(r.label || "")}" placeholder="提醒事项" />
        <button class="r-complete${completed ? " done" : ""}" title="${completed ? "已完成" : "标记完成"}">${completed ? "✓ 已完成" : "完成"}</button>
        <button class="r-del" title="删除">✕</button>
      </div>
      <div class="r-bottom">
        <select class="r-type">
          <option value="time"${!isInterval ? " selected" : ""}>到点提醒</option>
          <option value="interval"${isInterval ? " selected" : ""}>每N分钟</option>
        </select>
        <span class="r-time-wrap" style="${isInterval ? "display:none" : ""}">
          <input type="time" class="r-time" value="${r.time || "12:00"}" />
          <select class="r-repeat">
            <option value="daily"${r.repeat !== "weekday" ? " selected" : ""}>每天</option>
            <option value="weekday"${r.repeat === "weekday" ? " selected" : ""}>工作日</option>
          </select>
        </span>
        <span class="r-interval-wrap" style="${isInterval ? "" : "display:none"}">
          <input type="number" class="r-interval" min="1" value="${r.interval || 30}" style="width:54px" />分
        </span>
        <label class="r-on">
          <input type="checkbox" class="r-enabled" ${r.enabled !== false ? "checked" : ""}/>开
        </label>
      </div>
      <input class="r-msg" value="${escapeAttr(r.message || "")}" placeholder="提醒时说点啥…" />`;
    list.appendChild(row);
  });
  if (!settings.reminders.length) {
    list.innerHTML = '<div class="hint" style="margin:4px 0 8px">还没有提醒，点下面「+ 新增提醒」添加一个吧</div>';
  }
}

// ===== 宠物仓库（渲染） =====
function renderWarehouse() {
  const box = document.getElementById("petWarehouse");
  if (!box) return;
  box.innerHTML = "";
  if (!pets.length) {
    box.innerHTML = '<div class="hint" style="margin:2px 0 8px">仓库空空，上传一只宠物吧</div>';
    return;
  }
  pets.forEach((p) => {
    const active = p.status === "active";
    const official = ["fenzai-v1", "momo-v1"].includes(p.sprite?.presetId);
    const modeTag =
      p.mode === "sprite" ? "2D" : p.mode === "vrm" ? "3D" : "图";
    const card = document.createElement("div");
    card.className = "pet-card" + (active ? " is-out" : "");
    card.dataset.id = p.id;
    card.innerHTML = `
      <div class="pet-cover"><img class="p-thumb" src="${escapeAttr(p.cover || p.src)}" alt="" /></div>
      <div class="p-info">
        <div class="pet-name-line"><input class="p-name" value="${escapeAttr(p.name || "")}" placeholder="名字" ${official ? 'readonly aria-readonly="true" title="内置宠物名称不可修改"' : ""} /><span class="p-live">${active ? "桌面游走" : "已收回"}</span></div>
        <input class="p-hobby" value="${escapeAttr(p.hobby || "")}" placeholder="爱好（可选）" />
        <input class="p-personality" value="${escapeAttr(p.personality || "")}" placeholder="性格（可选）" />
      </div>
      <div class="p-actions">
        <span class="p-status"><span class="p-mode">${modeTag}</span>${official ? " 官方内置" : active ? " 正在陪伴" : " 在仓库休息"}</span>
        <button class="p-toggle" title="${active ? "收回" : "放出"}">${active ? "收回" : "放出"}</button>
        <button class="p-cover" title="更换封面">封面</button>
        ${official ? '<button class="p-del" disabled title="官方宠物不可删除">内置</button>' : '<button class="p-del" title="删除">✕</button>'}
      </div>`;
    box.appendChild(card);
  });
}

// ===== 宠物 =====
function spawnPet(profile, status) {
  const st = status || profile.status || "active";
  let pid;
  if (profile.id != null) {
    pid = profile.id;
    if (pid > idc) idc = pid;
  } else {
    pid = ++idc;
  }
  const size = normalizedPetSize(profile.size);
  const start = randomPatrolPosition(size);
  const p = {
    id: pid,
    name: profile.name || "宠物" + pid,
    hobby: profile.hobby || "",
    personality: profile.personality || "",
    src: profile.src,
    mode: profile.mode || "image",
    sprite: profile.sprite || null,
    cover: profile.cover || profile.sprite?.cover || profile.src,
    status: st,
    el: null,
    x: start.x,
    y: start.y,
    vx: (Math.random() - 0.5) * 1.2,
    vy: (Math.random() - 0.5) * 1.2,
    size,
    state: "wander",
    rest: 0,
    clicks: [],
    timer: null,
    // sprite 运行时字段
    bodyEl: null,
    anim: "idle",
    animTime: 0,
    lastTick: 0,
    transientAnim: null,
    transientUntil: 0,
    idleAnim: "idle",
    dragging: false,
    dragMoved: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragRestUntil: 0,
    stateBeforeDrag: "wander",
    suppressClickUntil: 0,
    attentionMode: false,
    nextRoutineAt: Date.now() + 9000 + Math.random() * 12000,
    routineUntil: 0,
    mood: "悠闲",
    moodUntil: 0,
    statusCard: null,
    statusTimer: null,
  };
  pets.push(p);
  if (st === "active" && !IS_PANEL) mountPet(p);
  return p;
}

// 计算 sprite 网格的行列数（用于 background-size 缩放）
function spriteGrid(sprite) {
  if (!sprite || !sprite.actions) return { rows: 1, cols: 1 };
  if (sprite.grid?.cols && sprite.grid?.rows) return sprite.grid;
  const acts = Object.values(sprite.actions);
  const rows = Math.max(...acts.map((a) => (a.row || 0) + 1));
  const cols = Math.max(...acts.map((a) => a.count || 1));
  return { rows, cols };
}

// 给宠物创建 DOM 元素并挂到 stage
function mountPet(p) {
  if (IS_PANEL || !document.getElementById("stage")) return;
  const el = document.createElement("div");
  el.className = "pet" + (p.mode === "sprite" ? " sprite-pet" : "");
  if (p.mode === "sprite" && p.sprite) {
    const grid = spriteGrid(p.sprite);
    const body = document.createElement("div");
    body.className = "sprite-body";
    body.style.width = p.size + "px";
    body.style.height = p.size + "px";
    body.style.backgroundImage = 'url("' + p.sprite.src + '")';
    body.style.backgroundRepeat = "no-repeat";
    body.style.backgroundSize = grid.cols * p.size + "px " + grid.rows * p.size + "px";
    el.appendChild(body);
    p.bodyEl = body;
    p.sprite.grid = grid;
    p.anim = "idle";
    p.animTime = 0;
    p.lastTick = performance.now();
  } else {
    el.innerHTML =
      '<img class="body" src="' +
      p.src +
      '" style="width:' +
      p.size +
      'px;height:auto;border-radius:14px">';
  }
  document.getElementById("stage").appendChild(el);
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  p.el = el;
  el.addEventListener("click", () => onClick(p));
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showPetActionMenu(p, event.clientX, event.clientY);
  });
  el.addEventListener("pointerenter", () => {
    clearTimeout(p.statusTimer);
    p.statusTimer = setTimeout(() => showStatusCard(p), 450);
  });
  el.addEventListener("pointerleave", () => {
    clearTimeout(p.statusTimer);
    hideStatusCard(p);
  });
  installPetDrag(p);
  p.status = "active";
}

const BUBBLE_PACKS = {
  default: { drag: ["你要带我去哪里呀？", "轻点，我自己会走~", "慢一点嘛~"], single: ["在呢~", "想我啦？", "戳我干啥", "哼"], double: ["嘿嘿", "喜欢我呀", "转个圈~"], multi: ["好开心！", "你也好可爱", "转晕啦~"], attention: ["理理我嘛~"], return: ["好嘛，我回去等你~"] },
  chatty: { drag: ["哇，出发咯！", "这边的风景也要看看~", "慢慢走，我想多待一会！"], single: ["我在我在！", "欸？叫我吗？", "今天也想和你玩~", "再摸一下也可以呀！"], double: ["嘿嘿，被发现啦！", "好耶好耶！", "要不要一起转圈？"], multi: ["太开心啦！！", "你最好了！", "再陪我一会嘛~"], attention: ["我有好多话想说！", "理理我嘛~", "我在这儿等你呀！"], return: ["好吧，我先回小角落啦~"] },
  quiet: { drag: ["……慢一点。", "嗯，知道了。"], single: ["嗯。", "我在。", "听见了。"], double: ["……好。", "别转太快。"], multi: ["有点晕。", "还行。"], attention: ["……看我一眼。"], return: ["嗯，我回去了。"] },
  lively: { drag: ["出发！", "带我去玩！"], single: ["嘿！", "我在！"], double: ["转圈圈！"], multi: ["太好玩啦！"], attention: ["理理我嘛~"], return: ["我回去等你！"] },
  cool: { drag: ["别摔着。", "随你。"], single: ["嗯？", "有事？"], double: ["知道了。"], multi: ["……够了。"], attention: ["……"], return: ["回去了。"] },
};

function bubblePack(p) {
  const personality = String(p.personality || "").trim();
  if (personality.includes("活泼")) return BUBBLE_PACKS.lively;
  if (personality.includes("高冷")) return BUBBLE_PACKS.cool;
  return BUBBLE_PACKS[settings.speechStyle] || BUBBLE_PACKS.default;
}

const ROUTINE_TALK = {
  eat: ["补充一点小能量~", "嗯，这口刚刚好。"],
  working: ["我也认真一会儿。", "专注陪伴中……"],
  review: ["让我想想看。", "发一小会儿呆。"],
  idle: ["今天天气不错。", "安静待在你身边。"],
  sleep: ["我先眯一会儿。", "安静休息一下。"],
};

function scheduleNextRoutine(p) {
  p.nextRoutineAt = Date.now() + 25000 + Math.random() * 40000;
}

function startRoutine(p) {
  if (p.dragging || p.attentionMode || p.state !== "wander" || p.rest > 0) return;
  const choices = ["eat", "working", "review", "idle", "idleSit", "lookAround", "sleep"].filter((name) => hasPetAnim(p, name));
  if (!choices.length) { scheduleNextRoutine(p); return; }
  const action = pick(choices);
  p.idleAnim = action;
  p.rest = Math.floor(180 + Math.random() * 240);
  p.routineUntil = Date.now() + (p.rest / 60) * 1000;
  setMood(p, action === "eat" ? "正在吃点心" : action === "working" ? "认真陪伴中" : action === "sleep" ? "正在小憩" : "悠闲发呆中", (p.rest / 60) * 1000);
  bubble(p, pick(ROUTINE_TALK[action]), false);
  scheduleNextRoutine(p);
}

function moodFor(p) {
  if (p.moodUntil && Date.now() < p.moodUntil) return p.mood;
  if (p.attentionMode) return "有点无聊";
  if (p.state === "alert") return "在提醒你";
  return "悠闲散步中";
}

function setMood(p, mood, duration = 4000) {
  p.mood = mood;
  p.moodUntil = Date.now() + duration;
  if (p.statusCard) updateStatusCard(p);
}

function updateStatusCard(p) {
  if (!p.statusCard) return;
  const personality = String(p.personality || "").trim() || ({ chatty: "话唠", quiet: "安静", default: "温柔" }[settings.speechStyle] || "温柔");
  p.statusCard.querySelector("strong").textContent = p.name;
  p.statusCard.querySelector(".status-personality").textContent = personality;
  p.statusCard.querySelector(".status-mood").textContent = moodFor(p);
  const r = p.el.getBoundingClientRect();
  p.statusCard.style.left = Math.max(8, Math.min(innerWidth - 190, r.left + r.width / 2 - 95)) + "px";
  p.statusCard.style.top = Math.max(8, r.top - 64) + "px";
}

function showStatusCard(p) {
  if (!p.el || p.dragging) return;
  if (!p.statusCard) {
    const card = document.createElement("div");
    card.className = "pet-status-card";
    card.innerHTML = '<strong></strong><span class="status-personality"></span><small class="status-mood"></small>';
    document.body.appendChild(card);
    p.statusCard = card;
  }
  updateStatusCard(p);
  p.statusCard.classList.add("visible");
}

function hideStatusCard(p) {
  if (p.statusCard) p.statusCard.classList.remove("visible");
}

function installPetDrag(p) {
  const el = p.el;
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = el.getBoundingClientRect();
    p.dragging = true;
    p.dragMoved = false;
    p.dragStartX = event.clientX;
    p.dragStartY = event.clientY;
    p.dragOffsetX = event.clientX - rect.left;
    p.dragOffsetY = event.clientY - rect.top;
    p.stateBeforeDrag = p.state;
    p.state = "dragging";
    p.rest = 0;
    el.classList.add("dragging");
    el.setPointerCapture(event.pointerId);
    reportHotspots(true);
  });
  el.addEventListener("pointermove", (event) => {
    if (!p.dragging) return;
    if (!p.dragMoved && Math.hypot(event.clientX - p.dragStartX, event.clientY - p.dragStartY) >= 5) {
      p.dragMoved = true;
      pokeInteract();
      bubble(p, pick(bubblePack(p).drag), false);
      playPetAnim(p, "waiting", 1200);
    }
    if (!p.dragMoved) return;
    p.x = Math.max(0, Math.min(innerWidth - p.size, event.clientX - p.dragOffsetX));
    p.y = Math.max(0, Math.min(innerHeight - p.size, event.clientY - p.dragOffsetY));
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
  });
  const finishDrag = (event) => {
    if (!p.dragging) return;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    p.dragging = false;
    el.classList.remove("dragging");
    if (p.dragMoved) {
      p.state = "drag-rest";
      p.dragRestUntil = Date.now() + 10000;
      p.suppressClickUntil = Date.now() + 350;
      p.vx = 0;
      p.vy = 0;
      p.idleAnim = p.sprite?.defaultIdle || "idle";
    } else {
      p.state = p.stateBeforeDrag || "wander";
    }
    reportHotspots(true);
  };
  el.addEventListener("pointerup", finishDrag);
  el.addEventListener("pointercancel", finishDrag);
}

// 收回：从桌面移除 DOM，宠物留在仓库
function storePet(id) {
  const p = pets.find((x) => x.id === id);
  if (!p || p.status !== "active") return;
  if (p.el) {
    p.el.remove();
    p.el = null;
    p.bodyEl = null;
  }
  p.statusCard?.remove();
  p.statusCard = null;
  p.status = "stored";
  persist();
  renderWarehouse();
}

// 放出：从仓库重新挂到桌面
function releasePet(id) {
  const p = pets.find((x) => x.id === id);
  if (!p || p.status !== "stored") return;
  p.status = "active";
  if (!IS_PANEL) mountPet(p);
  persist();
  renderWarehouse();
}

// 删除：彻底移除（两段式确认，在事件层处理）
function deletePet(id) {
  const p = pets.find((x) => x.id === id);
  if (!p || ["fenzai-v1", "momo-v1"].includes(p.sprite?.presetId)) return;
  if (p.el) p.el.remove();
  p.statusCard?.remove();
  pets = pets.filter((x) => x.id !== id);
  persist();
  renderWarehouse();
}

async function addPets(input) {
  const files = input.files;
  if (!files.length) return;
  for (const f of [...files]) {
    try {
      const src = await saveUserFile(f);
      spawnPet({ name: f.name.replace(/\.[^.]+$/, ""), src, mode: "image" });
    } catch (e) {
      console.error("保存宠物图片失败", e);
      alert(`无法导入「${f.name}」：${String(e)}`);
    }
  }
  await persist();
  renderWarehouse();
  input.value = "";
}

// 2D 精灵：示例（内置）或自定义上传
function spawnSpritePet(profile) {
  spawnPet({
    name: profile.name,
    src: profile.sprite.src,
    mode: "sprite",
    sprite: profile.sprite,
    cover: profile.cover || profile.sprite.cover,
  });
  persist();
  renderWarehouse();
}

// 规范化用户自定义 config.json → 内部 sprite 配置 {src, frameW, frameH, actions}
// 支持 Pinkmo 标准动作；旧素材仍可只提供 idle/walk/eat/happy。
function normalizeSpriteConfig(cfg, src) {
  const frameW = cfg && Number(cfg.frameW) > 0 ? Number(cfg.frameW) : SPRITE_PRESET.frameW;
  const frameH = cfg && Number(cfg.frameH) > 0 ? Number(cfg.frameH) : SPRITE_PRESET.frameH;
  const actions = {};
  if (cfg && cfg.actions && typeof cfg.actions === "object") {
    Object.entries(cfg.actions).forEach(([k, v]) => {
      if (!v || typeof v !== "object") return;
      const row = Number(v.row);
      const count = Number(v.count);
      if (Number.isNaN(row) || Number.isNaN(count) || count < 1) return;
      actions[k] = {
        row,
        count,
        fps: Number(v.fps) > 0 ? Number(v.fps) : 8,
        loop: v.loop !== false,
      };
    });
  }
  if (!Object.keys(actions).length) {
    // 无有效 config → 用默认预设（4 动作 × 4 帧）
    return { src, frameW, frameH, actions: JSON.parse(JSON.stringify(SPRITE_PRESET.actions)) };
  }
  if (!actions.idle) actions.idle = Object.assign({}, SPRITE_PRESET.actions.idle);
  return { src, frameW, frameH, actions };
}

// 2D 自定义：一次可选传 sprite sheet 图 + config.json（图按 image 分类，.json 当配置）
function addSpritePets(input) {
  const files = [...input.files];
  if (!files.length) return;
  const imgs = files.filter((f) => f.type && f.type.startsWith("image/"));
  if (!imgs.length) return;
  const cfgFile = files.find(
    (f) => f.name.toLowerCase().endsWith(".json") || f.type === "application/json"
  );

  const readConfig = cfgFile
    ? new Promise((res) => {
        const r = new FileReader();
        r.onload = (e) => {
          try {
            res(JSON.parse(e.target.result));
          } catch (err) {
            res(null);
          }
        };
        r.onerror = () => res(null);
        r.readAsText(cfgFile);
      })
    : Promise.resolve(null);

  readConfig.then(async (cfg) => {
    for (const f of imgs) {
      try {
        const src = await saveUserFile(f);
        const sprite = normalizeSpriteConfig(cfg, src);
        spawnSpritePet({ name: f.name.replace(/\.[^.]+$/, ""), sprite });
      } catch (e) {
        console.error("保存 sprite 失败", e);
        alert(`无法导入「${f.name}」：${String(e)}`);
      }
    }
  });

  input.value = "";
}

// ===== 动作视频 → Pinkmo 动作包 =====
// WebView 抽帧，可选独立本地 AI 组件精细抠图，拼成 6×4 Sprite Sheet，
// 然后复用现有的“每个动作一张 sheet”播放器。视频文件本身不会写入设置或上传网络。
const VIDEO_FRAME_SIZE = 320;
const VIDEO_FRAME_COUNT = 24;
const VIDEO_GRID = { cols: 6, rows: 4 };
const VIDEO_WORK_SIZE = 512;
let videoPetDraft = null;
let selectedActionVideo = null;
let videoActionProcessing = false;
let pendingVideoAction = null;
let videoPreviewTimer = null;
let mattingComponent = null;
let videoAbortController = null;

const VIDEO_ACTION_META = {
  idle: { label: "站立待机", fps: 6, loop: true },
  idleSit: { label: "坐姿待机", fps: 6, loop: true },
  walkRight: { label: "向右走", fps: 8, loop: true },
  lookAround: { label: "好奇张望", fps: 6, loop: true },
  stretch: { label: "伸懒腰", fps: 6, loop: false },
  yawn: { label: "打哈欠", fps: 6, loop: false },
  sleep: { label: "趴下睡觉", fps: 6, loop: true },
  groom: { label: "舔爪洗脸", fps: 6, loop: false },
  eat: { label: "吃东西", fps: 6, loop: false },
  wave: { label: "挥爪", fps: 6, loop: false },
  jump: { label: "跳跃", fps: 6, loop: false },
  happy: { label: "开心", fps: 6, loop: false },
  waiting: { label: "等待", fps: 6, loop: false },
  failed: { label: "委屈", fps: 6, loop: false },
  working: { label: "工作", fps: 6, loop: true },
  review: { label: "查看", fps: 6, loop: true },
};

function videoBuilderElements() {
  return {
    modal: document.getElementById("videoActionBuilder"),
    target: document.getElementById("videoPetTarget"),
    nameRow: document.getElementById("videoPetNameRow"),
    name: document.getElementById("videoPetName"),
    action: document.getElementById("videoActionName"),
    file: document.getElementById("actionVideoFile"),
    selected: document.getElementById("selectedActionVideo"),
    greenKey: document.getElementById("videoGreenKey"),
    keepProps: document.getElementById("videoKeepProps"),
    matteStrength: document.getElementById("videoMatteStrength"),
    progress: document.getElementById("videoActionProgress"),
    previewWrap: document.getElementById("videoActionPreviewWrap"),
    preview: document.getElementById("videoActionPreview"),
    confirm: document.getElementById("videoConfirmAction"),
    list: document.getElementById("videoActionList"),
    add: document.getElementById("videoAddAction"),
    finish: document.getElementById("videoFinishPet"),
  };
}

function videoBuilderTargetPet() {
  const id = Number(videoBuilderElements().target.value);
  return Number.isFinite(id) && id > 0 ? pets.find((p) => p.id === id && p.mode === "sprite") : null;
}

function refreshVideoBuilderTargetOptions() {
  const el = videoBuilderElements();
  const spritePets = pets.filter((p) => p.mode === "sprite");
  el.target.innerHTML = `<option value="new">创建新宠物</option>${spritePets.map((p) => `<option value="${p.id}">给「${escapeAttr(p.name)}」追加动作</option>`).join("")}`;
  // 最常见的使用场景是为仓库里已有的宠物补动作；优先选中墨墨，其次第一只 2D 宠物。
  const preferred = spritePets.find((p) => p.sprite?.presetId === "momo-v1") || spritePets[0];
  el.target.value = preferred ? String(preferred.id) : "new";
}

function updateVideoBuilderTarget() {
  const el = videoBuilderElements();
  const target = videoBuilderTargetPet();
  videoPetDraft.targetId = target?.id || null;
  el.nameRow.hidden = Boolean(target);
  if (target) {
    videoPetDraft.name = target.name;
    el.name.value = target.name;
    el.progress.textContent = `动作会追加到「${target.name}」，不会新建重复宠物。`;
  } else {
    videoPetDraft.name = el.name.value.trim() || "新朋友";
    el.progress.textContent = "先选择一个动作视频。";
  }
  renderVideoActionDraft();
}

function resetVideoActionBuilder() {
  videoPetDraft = { name: "新朋友", actions: {}, cover: null, targetId: null };
  selectedActionVideo = null;
  clearPendingVideoAction();
  const el = videoBuilderElements();
  el.name.value = videoPetDraft.name;
  el.action.value = "idleSit";
  el.file.value = "";
  el.selected.textContent = "尚未选择";
  el.greenKey.checked = true;
  el.keepProps.checked = false;
  el.matteStrength.value = "ai";
  refreshVideoBuilderTargetOptions();
  updateVideoBuilderTarget();
}

function renderVideoActionDraft() {
  const el = videoBuilderElements();
  const actions = Object.entries(videoPetDraft?.actions || {});
  const target = videoBuilderTargetPet();
  const existingCount = target ? Object.keys(target.sprite?.actions || {}).length : 0;
  const officialNames = officialActionNames(target?.sprite?.presetId);
  const summary = target ? `<span class="video-action-existing">「${escapeAttr(target.name)}」已有 ${existingCount} 个动作</span>` : "";
  const additions = actions.length
    ? actions.map(([name, action]) => `<span class="video-action-chip">${officialNames.has(name) ? "替换内置" : "新增"} · ${escapeAttr(VIDEO_ACTION_META[name]?.label || name)} · ${action.count} 帧</span>`).join("")
    : '<span class="video-action-empty">本次还没有新增动作</span>';
  el.list.innerHTML = summary + additions;
  // 追加到已有精灵时，其待机动作已经存在；新建宠物才必须先生成一个待机动作。
  const canFinish = !pendingVideoAction && actions.length && (target || ["idle", "idleSit"].some((name) => videoPetDraft?.actions?.[name]));
  el.finish.disabled = videoActionProcessing || !canFinish;
  el.finish.textContent = target ? `加入「${target.name}」的动作库` : "加入宠物仓库";
  // 第一段动作生成后锁定目标，避免同一份草稿误追加到另一只宠物。
  el.target.disabled = videoActionProcessing || actions.length > 0 || Boolean(pendingVideoAction);
  updateVideoProcessingControls();
}

function updateVideoProcessingControls() {
  const el = videoBuilderElements();
  const usesAI = el.greenKey.checked && el.matteStrength.value === "ai";
  document.getElementById("aiComponent").hidden = !usesAI;
  el.add.disabled = videoActionProcessing || (usesAI && !mattingComponent?.isReady());
  for (const input of [el.name, el.action, el.greenKey, el.matteStrength, el.file, document.getElementById("pickActionVideo")]) input.disabled = videoActionProcessing;
  el.keepProps.disabled = videoActionProcessing || !usesAI;
  el.confirm.disabled = videoActionProcessing;
  document.getElementById("videoBuilderCancel").textContent = videoAbortController ? "取消处理" : "取消";
}

function openVideoActionBuilder() {
  resetVideoActionBuilder();
  videoBuilderElements().modal.hidden = false;
  mattingComponent?.refresh();
}

function closeVideoActionBuilder() {
  if (videoActionProcessing) {
    if (videoAbortController) {
      videoAbortController.abort();
      videoBuilderElements().progress.textContent = "正在取消处理…";
    } else videoBuilderElements().progress.textContent = "正在保存动作，请稍候…";
    return;
  }
  videoBuilderElements().modal.hidden = true;
  selectedActionVideo = null;
  clearPendingVideoAction();
  videoPetDraft = null;
}

function clearPendingVideoAction() {
  pendingVideoAction = null;
  if (videoPreviewTimer) clearInterval(videoPreviewTimer);
  videoPreviewTimer = null;
  const el = videoBuilderElements();
  if (el.previewWrap) el.previewWrap.hidden = true;
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("视频无法读取，请换成 MP4（H.264）后再试")); };
    const timeout = setTimeout(fail, 30000);
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener(eventName, done); video.removeEventListener("error", fail); };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener("error", fail, { once: true });
  });
}

async function seekVideoFrame(video, time) {
  const target = Math.max(0, Math.min(Math.max(0, video.duration - 0.02), time));
  if (Math.abs(video.currentTime - target) < 0.003) return;
  const ready = waitForVideoEvent(video, "seeked");
  video.currentTime = target;
  await ready;
  // WebKit 有时会先触发 seeked、下一次视频合成才提交真实画面；此时立刻
  // drawImage 会抽到空帧，导致本地 AI 误报「没有识别到主体」。优先等待
  // 视频帧回调，不支持时再给两个绘制帧的余量。暂停的视频在部分 macOS
  // WebKit 上不会触发 requestVideoFrameCallback，因此必须有很短的回退，
  // 绝不能让单帧把整个动作制作卡死。
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      let callbackId = null;
      const finish = () => {
        clearTimeout(fallback);
        if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(callbackId);
        resolve();
      };
      const fallback = setTimeout(finish, 180);
      callbackId = video.requestVideoFrameCallback(finish);
    });
  } else {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
}

function videoSampleTime(video, index, total) {
  // 留出首尾缓冲，避开生成视频常见的开场空帧和收尾重复帧。
  return video.duration * ((index + 1) / (total + 1));
}

function opaqueBounds(data, width, height, minAlpha = 20) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (data[(y * width + x) * 4 + 3] < minAlpha) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX >= minX ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
}

function median(values) {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] || 0;
}

function edgeStripColor(data, width, bounds, y, fromLeft) {
  const strip = Math.max(8, Math.min(18, Math.round(bounds.width * 0.035)));
  const start = fromLeft ? bounds.minX : Math.max(bounds.minX, bounds.maxX - strip + 1);
  const end = fromLeft ? Math.min(bounds.maxX, bounds.minX + strip - 1) : bounds.maxX;
  const channels = [[], [], []];
  for (let yy = Math.max(bounds.minY, y - 2); yy <= Math.min(bounds.maxY, y + 2); yy += 1) {
    for (let x = start; x <= end; x += 1) {
      const i = (yy * width + x) * 4;
      if (data[i + 3] < 20) continue;
      channels[0].push(data[i]); channels[1].push(data[i + 1]); channels[2].push(data[i + 2]);
    }
  }
  return channels.map(median);
}

function buildEdgeBackgroundRows(data, width, bounds) {
  const rows = new Array(bounds.maxY - bounds.minY + 1);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    rows[y - bounds.minY] = {
      left: edgeStripColor(data, width, bounds, y, true),
      right: edgeStripColor(data, width, bounds, y, false),
    };
  }
  return rows;
}

function pixelMatchesBackground(data, index, background, strength) {
  const limits = {
    protect: { rgb: 42, chroma: 17, luma: 42 },
    standard: { rgb: 58, chroma: 25, luma: 60 },
    strong: { rgb: 72, chroma: 32, luma: 78 },
  }[strength] || { rgb: 42, chroma: 17, luma: 42 };
  const r = data[index], g = data[index + 1], b = data[index + 2];
  const [br, bg, bb] = background;
  const luma = r * 0.299 + g * 0.587 + b * 0.114;
  const backgroundLuma = br * 0.299 + bg * 0.587 + bb * 0.114;
  const rgbDistance = Math.hypot(r - br, g - bg, b - bb);
  const chromaDistance = Math.hypot((r - g) - (br - bg), (b - g) - (bb - bg));
  // 黑色毛发一律保护；但亮度仍达到背景约 36%、色相又几乎相同的暗边通常是绿幕阴影。
  // 允许这小部分继续被边缘连通抠除，避免宠物外围留下一圈青绿色轮廓。
  if (backgroundLuma - luma > Math.max(38, backgroundLuma * 0.30)) {
    return luma >= backgroundLuma * 0.36 && chromaDistance <= limits.chroma * 0.82;
  }
  return rgbDistance <= limits.rgb || (chromaDistance <= limits.chroma && Math.abs(luma - backgroundLuma) <= limits.luma);
}

function despillForegroundEdges(data, width, visible, rows, removed) {
  const maxDistance = 10;
  const edgeDistance = new Uint8Array(width * (visible.maxY + 1));
  const queue = new Int32Array(visible.width * visible.height);
  let head = 0, tail = 0;
  const isInside = (x, y) => x >= visible.minX && x <= visible.maxX && y >= visible.minY && y <= visible.maxY;
  const isForeground = (point) => !removed[point] && data[point * 4 + 3] > 0;
  // 先找紧贴透明背景的第一圈主体像素，再向主体内部做一个最多 10px 的距离场。
  for (let y = visible.minY; y <= visible.maxY; y += 1) for (let x = visible.minX; x <= visible.maxX; x += 1) {
    const point = y * width + x;
    if (!isForeground(point)) continue;
    const touchesBackground = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => isInside(nx, ny) && removed[ny * width + nx]);
    if (!touchesBackground) continue;
    edgeDistance[point] = 1;
    queue[tail++] = point;
  }
  while (head < tail) {
    const point = queue[head++];
    const distance = edgeDistance[point];
    if (distance >= maxDistance) continue;
    const x = point % width, y = Math.floor(point / width);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (!isInside(nx, ny)) continue;
      const next = ny * width + nx;
      if (!isForeground(next) || edgeDistance[next]) continue;
      edgeDistance[next] = distance + 1;
      queue[tail++] = next;
    }
  }
  for (let y = visible.minY; y <= visible.maxY; y += 1) for (let x = visible.minX; x <= visible.maxX; x += 1) {
    const point = y * width + x;
    if (removed[point] || data[point * 4 + 3] === 0) continue;
    const distance = edgeDistance[point];
    if (!distance) continue;
    const row = rows[y - visible.minY];
    const mix = visible.width <= 1 ? 0 : (x - visible.minX) / (visible.width - 1);
    const background = row.left.map((value, channel) => value + (row.right[channel] - value) * mix);
    const bgMean = (background[0] + background[1] + background[2]) / 3;
    const bgChroma = background.map((value) => value - bgMean);
    const bgChromaPower = bgChroma.reduce((sum, value) => sum + value * value, 0);
    if (bgChromaPower < 80) continue;
    const index = point * 4;
    const pixelMean = (data[index] + data[index + 1] + data[index + 2]) / 3;
    const pixelChroma = [data[index] - pixelMean, data[index + 1] - pixelMean, data[index + 2] - pixelMean];
    const pixelChromaPower = pixelChroma.reduce((sum, value) => sum + value * value, 0);
    if (pixelChromaPower < 9) continue;
    const alignment = pixelChroma.reduce((sum, value, channel) => sum + value * bgChroma[channel], 0) / Math.sqrt(pixelChromaPower * bgChromaPower);
    if (alignment <= 0.02) continue;
    // 视频中的幕布反光不一定与采样背景完全同色（青幕常在黑毛上偏蓝）。
    // 因此沿背景色方向判断“像不像溢色”，命中后把整段色偏拉回中性，而不是只减绿色通道。
    const edgeWeight = 1 - (distance - 1) / maxDistance;
    const chromaWeight = Math.min(1, Math.sqrt(pixelChromaPower) / (Math.sqrt(bgChromaPower) * 0.24));
    const alignmentWeight = Math.min(1, (alignment - 0.02) / 0.58);
    const amount = Math.min(0.96, edgeWeight * chromaWeight * alignmentWeight * 1.15);
    for (let channel = 0; channel < 3; channel += 1) {
      data[index + channel] = Math.max(0, Math.min(255, Math.round(data[index + channel] + (pixelMean - data[index + channel]) * amount)));
    }
  }
}

// 按每一行左右边缘建立背景模型，适应蓝/绿幕的明暗渐变；仅抠除与画面边缘连通的区域。
// 阈值固定且偏保守，不再根据背景变化无限放宽，避免青绿色溢色吞掉黑色毛发。
function removeAutoSampledBackground(ctx, width, height, strength = "protect") {
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;
  const visible = opaqueBounds(data, width, height, 1);
  if (!visible) return;
  const rows = buildEdgeBackgroundRows(data, width, visible);
  const isBackgroundLike = (x, y, pixelIndex) => {
    if (data[pixelIndex + 3] === 0) return false;
    const row = rows[y - visible.minY];
    const mix = visible.width <= 1 ? 0 : (x - visible.minX) / (visible.width - 1);
    const predicted = row.left.map((value, channel) => value + (row.right[channel] - value) * mix);
    return pixelMatchesBackground(data, pixelIndex, predicted, strength);
  };
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const add = (x, y) => {
    if (x < visible.minX || x > visible.maxX || y < visible.minY || y > visible.maxY) return;
    const point = y * width + x;
    if (visited[point]) return;
    const pixel = point * 4;
    if (!isBackgroundLike(x, y, pixel)) return;
    visited[point] = 1;
    queue[tail++] = point;
  };
  for (let x = visible.minX; x <= visible.maxX; x += 1) { add(x, visible.minY); add(x, visible.maxY); }
  for (let y = visible.minY; y <= visible.maxY; y += 1) { add(visible.minX, y); add(visible.maxX, y); }
  while (head < tail) {
    const point = queue[head++];
    const x = point % width, y = Math.floor(point / width);
    const index = point * 4;
    // 透明像素的 RGB 也必须清空；否则缩放 Sprite Sheet 时，插值会把隐藏的幕布颜色
    // 重新混进半透明毛发边缘，形成一圈蓝绿光边。
    data[index] = 0;
    data[index + 1] = 0;
    data[index + 2] = 0;
    data[index + 3] = 0;
    add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1);
  }
  despillForegroundEdges(data, width, visible, rows, visited);
  ctx.putImageData(image, 0, 0);
}

function extractVideoFrame(video, useAutoBackground, matteStrength) {
  const frame = document.createElement("canvas");
  frame.width = VIDEO_WORK_SIZE;
  frame.height = VIDEO_WORK_SIZE;
  const ctx = frame.getContext("2d", { willReadFrequently: useAutoBackground });
  const scale = Math.min(VIDEO_WORK_SIZE / video.videoWidth, VIDEO_WORK_SIZE / video.videoHeight);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  ctx.drawImage(video, Math.round((VIDEO_WORK_SIZE - width) / 2), Math.round((VIDEO_WORK_SIZE - height) / 2), width, height);
  if (useAutoBackground) removeAutoSampledBackground(ctx, VIDEO_WORK_SIZE, VIDEO_WORK_SIZE, matteStrength);
  return frame;
}

function composeNormalizedVideoSheet(frames) {
  const bounds = frames.map((frame) => {
    const ctx = frame.getContext("2d");
    return opaqueBounds(ctx.getImageData(0, 0, VIDEO_WORK_SIZE, VIDEO_WORK_SIZE).data, VIDEO_WORK_SIZE, VIDEO_WORK_SIZE);
  }).filter(Boolean);
  if (!bounds.length) throw new Error("没有识别到宠物主体，请换成与背景反差更明显的视频");
  const union = bounds.reduce((all, box) => ({
    minX: Math.min(all.minX, box.minX), minY: Math.min(all.minY, box.minY),
    maxX: Math.max(all.maxX, box.maxX), maxY: Math.max(all.maxY, box.maxY),
  }), { ...bounds[0] });
  const rawWidth = union.maxX - union.minX + 1;
  const rawHeight = union.maxY - union.minY + 1;
  const padX = Math.max(24, Math.round(rawWidth * 0.12));
  const padY = Math.max(24, Math.round(rawHeight * 0.10));
  const crop = {
    x: Math.max(0, union.minX - padX), y: Math.max(0, union.minY - padY),
    width: Math.min(VIDEO_WORK_SIZE, union.maxX + padX + 1) - Math.max(0, union.minX - padX),
    height: Math.min(VIDEO_WORK_SIZE, union.maxY + padY + 1) - Math.max(0, union.minY - padY),
  };
  const scale = Math.min((VIDEO_FRAME_SIZE - 24) / crop.width, (VIDEO_FRAME_SIZE - 24) / crop.height);
  const drawWidth = Math.round(crop.width * scale), drawHeight = Math.round(crop.height * scale);
  const sheet = document.createElement("canvas");
  sheet.width = VIDEO_GRID.cols * VIDEO_FRAME_SIZE;
  sheet.height = VIDEO_GRID.rows * VIDEO_FRAME_SIZE;
  const ctx = sheet.getContext("2d");
  frames.forEach((frame, index) => {
    const cellX = (index % VIDEO_GRID.cols) * VIDEO_FRAME_SIZE;
    const cellY = Math.floor(index / VIDEO_GRID.cols) * VIDEO_FRAME_SIZE;
    ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, cellX + Math.round((VIDEO_FRAME_SIZE - drawWidth) / 2), cellY + Math.round((VIDEO_FRAME_SIZE - drawHeight) / 2), drawWidth, drawHeight);
  });
  return sheet;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成 Sprite Sheet")), "image/png"));
}

async function buildActionSheetFromVideo(file, useAutoBackground, matteStrength, preserveProps, onProgress, signal) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const metadata = waitForVideoEvent(video, "loadedmetadata");
    video.src = url;
    await metadata;
    if (!Number.isFinite(video.duration) || video.duration < 0.35 || !video.videoWidth || !video.videoHeight) {
      throw new Error("视频太短或没有有效画面，请选择约 4 秒的单动作视频");
    }
    if (signal?.aborted) throw new DOMException("已取消处理", "AbortError");
    if (useAutoBackground && matteStrength === "ai") return await buildLocalMatting(video, seekVideoFrame, preserveProps, onProgress, signal);
    const frames = [];
    for (let i = 0; i < VIDEO_FRAME_COUNT; i += 1) {
      if (signal?.aborted) throw new DOMException("已取消处理", "AbortError");
      // 取每个等分的中间点，避开视频开头/结尾常见的淡入淡出或重复帧。
      await seekVideoFrame(video, videoSampleTime(video, i, VIDEO_FRAME_COUNT));
      frames.push(extractVideoFrame(video, useAutoBackground, matteStrength));
      onProgress?.(i + 1, VIDEO_FRAME_COUNT, "frames");
    }
    onProgress?.(VIDEO_FRAME_COUNT, VIDEO_FRAME_COUNT, "crop");
    return composeNormalizedVideoSheet(frames);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function addVideoActionToDraft() {
  if (videoActionProcessing) return;
  const el = videoBuilderElements();
  const file = selectedActionVideo;
  if (!file) return alert("请先选择一个动作视频。");
  if (!videoPetDraft) return;
  const actionName = el.action.value;
  if (videoPetDraft.actions[actionName] && !confirm(`「${VIDEO_ACTION_META[actionName]?.label || actionName}」已经存在，要替换它吗？`)) return;
  videoActionProcessing = true;
  videoAbortController = new AbortController();
  updateVideoProcessingControls();
  el.target.disabled = true;
  el.add.disabled = true;
  el.finish.disabled = true;
  try {
    el.progress.textContent = "正在读取视频…";
    clearPendingVideoAction();
    const sheet = await buildActionSheetFromVideo(file, el.greenKey.checked, el.matteStrength.value, el.keepProps.checked, (current, total, stage) => {
      const messages = { loading: "正在加载本地 AI 模型，首次处理可能需要稍候…", extract: `正在准备视频帧 ${current}/${total}…`, matting: `AI 正在精细处理第 ${Math.min(current + 1, total)}/${total} 帧，请稍候…`, composing: "正在统一裁切并生成动作…", crop: "正在统一裁切并居中宠物…" };
      el.progress.textContent = messages[stage] || `正在处理第 ${current}/${total} 帧…`;
    }, videoAbortController.signal);
    pendingVideoAction = { sheet, actionName, file };
    showVideoActionPreview(sheet, VIDEO_ACTION_META[actionName]?.fps || 6);
    el.progress.textContent = "预览已生成。请检查宠物的身体、尾巴和毛发边缘，确认后再保存。";
  } catch (error) {
    console.error("动作视频处理失败", error);
    el.progress.textContent = videoAbortController?.signal.aborted ? "已取消处理，已有动作未改变。" : `处理失败：${error.message || String(error)}`;
  } finally {
    videoActionProcessing = false;
    videoAbortController = null;
    el.add.disabled = false;
    renderVideoActionDraft();
  }
}

function showVideoActionPreview(sheet, fps) {
  const el = videoBuilderElements();
  el.previewWrap.hidden = false;
  const ctx = el.preview.getContext("2d");
  let frame = 0;
  const draw = () => {
    ctx.clearRect(0, 0, VIDEO_FRAME_SIZE, VIDEO_FRAME_SIZE);
    const sx = (frame % VIDEO_GRID.cols) * VIDEO_FRAME_SIZE;
    const sy = Math.floor(frame / VIDEO_GRID.cols) * VIDEO_FRAME_SIZE;
    ctx.drawImage(sheet, sx, sy, VIDEO_FRAME_SIZE, VIDEO_FRAME_SIZE, 0, 0, VIDEO_FRAME_SIZE, VIDEO_FRAME_SIZE);
    frame = (frame + 1) % VIDEO_FRAME_COUNT;
  };
  draw();
  videoPreviewTimer = setInterval(draw, 1000 / fps);
}

async function confirmVideoActionPreview() {
  if (videoActionProcessing || !pendingVideoAction || !videoPetDraft) return;
  const el = videoBuilderElements();
  const { sheet, actionName } = pendingVideoAction;
  videoActionProcessing = true;
  updateVideoProcessingControls();
  el.confirm.disabled = true;
  el.add.disabled = true;
  el.finish.disabled = true;
  try {
    el.progress.textContent = "正在保存动作 Sprite Sheet…";
    const sheetBlob = await canvasToBlob(sheet);
    const stem = (videoPetDraft.name || "pinkmo-pet").trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-") || "pinkmo-pet";
    const actionSrc = await saveUserFile(new File([sheetBlob], `${stem}-${actionName}-24frames.png`, { type: "image/png" }));
    const meta = VIDEO_ACTION_META[actionName] || { fps: 6, loop: false };
    videoPetDraft.actions[actionName] = {
      src: actionSrc,
      grid: { ...VIDEO_GRID },
      row: 0,
      start: 0,
      count: VIDEO_FRAME_COUNT,
      fps: meta.fps,
      loop: meta.loop,
      userGenerated: true,
    };
    // 行走向右的源片可安全镜像为向左走，少做一条视频即可满足桌面游走。
    if (actionName === "walkRight") {
      videoPetDraft.actions.walkLeft = { ...videoPetDraft.actions.walkRight, flipX: true };
    }
    if (!videoPetDraft.cover) {
      const cover = document.createElement("canvas");
      cover.width = VIDEO_FRAME_SIZE;
      cover.height = VIDEO_FRAME_SIZE;
      const coverCtx = cover.getContext("2d");
      coverCtx.drawImage(sheet, 0, 0, VIDEO_FRAME_SIZE, VIDEO_FRAME_SIZE, 0, 0, VIDEO_FRAME_SIZE, VIDEO_FRAME_SIZE);
      const coverBlob = await canvasToBlob(cover);
      videoPetDraft.cover = await saveUserFile(new File([coverBlob], `${stem}-cover.png`, { type: "image/png" }));
    }
    selectedActionVideo = null;
    el.file.value = "";
    el.selected.textContent = "尚未选择";
    clearPendingVideoAction();
    el.progress.textContent = `「${meta.label || actionName}」已生成。还可以继续添加其他动作。`;
    renderVideoActionDraft();
  } catch (error) {
    console.error("动作视频处理失败", error);
    el.progress.textContent = `处理失败：${error.message || String(error)}`;
  } finally {
    videoActionProcessing = false;
    el.confirm.disabled = false;
    el.add.disabled = false;
    renderVideoActionDraft();
  }
}

async function finishVideoPetDraft() {
  if (!videoPetDraft || !Object.keys(videoPetDraft.actions).length) return;
  const target = videoBuilderTargetPet();
  if (!target && !["idle", "idleSit"].some((name) => videoPetDraft.actions[name])) {
    return alert("请先生成「站立待机」或「坐姿待机」，宠物才有日常待机动作。");
  }
  if (target) {
    const officialNames = officialActionNames(target.sprite?.presetId);
    const replacementEntries = Object.entries(videoPetDraft.actions).filter(([name]) => officialNames.has(name));
    if (replacementEntries.length) {
      const labels = replacementEntries.map(([name]) => VIDEO_ACTION_META[name]?.label || name).join("、");
      if (!confirm(`将「${labels}」设为「我的版本」吗？\n\n内置版本会保留，可随时在动作管理中恢复。`)) return;
    }
    const additions = Object.fromEntries(Object.entries(videoPetDraft.actions).filter(([name]) => !officialNames.has(name)));
    const actionOverrides = Object.fromEntries(replacementEntries);
    target.sprite = target.sprite || {};
    target.sprite.actions = { ...(target.sprite.actions || {}), ...additions, ...actionOverrides };
    target.sprite.actionOverrides = { ...(target.sprite.actionOverrides || {}), ...actionOverrides };
    target.sprite.grid = target.sprite.grid || { ...VIDEO_GRID };
    target.sprite.frameW = target.sprite.frameW || VIDEO_FRAME_SIZE;
    target.sprite.frameH = target.sprite.frameH || VIDEO_FRAME_SIZE;
    target.sprite.src = target.sprite.src || Object.values(videoPetDraft.actions)[0].src;
    await persist();
    renderWarehouse();
    renderActionManager();
    closeVideoActionBuilder();
    document.querySelector('[data-view="actions"]')?.click();
    return;
  }
  const name = videoBuilderElements().name.value.trim() || "新朋友";
  const defaultIdle = videoPetDraft.actions.idleSit ? "idleSit" : "idle";
  const sprite = {
    src: videoPetDraft.actions[defaultIdle].src,
    frameW: VIDEO_FRAME_SIZE,
    frameH: VIDEO_FRAME_SIZE,
    grid: { ...VIDEO_GRID },
    defaultIdle,
    actions: videoPetDraft.actions,
  };
  spawnPet({ name, src: sprite.src, mode: "sprite", sprite, cover: videoPetDraft.cover, status: "active" });
  await persist();
  renderWarehouse();
  closeVideoActionBuilder();
  document.querySelector('[data-view="warehouse"]')?.click();
}

function setupVideoActionBuilder() {
  const el = videoBuilderElements();
  mattingComponent = setupMattingComponent(updateVideoProcessingControls);
  document.getElementById("modeVideoActions").addEventListener("click", openVideoActionBuilder);
  document.getElementById("pickActionVideo").addEventListener("click", () => el.file.click());
  el.target.addEventListener("change", updateVideoBuilderTarget);
  el.file.addEventListener("change", () => {
    const file = el.file.files?.[0];
    selectedActionVideo = file || null;
    clearPendingVideoAction();
    el.selected.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "尚未选择";
    renderVideoActionDraft();
  });
  const changed = () => { clearPendingVideoAction(); renderVideoActionDraft(); };
  el.action.addEventListener("change", () => {
    if (el.action.value === "eat") el.keepProps.checked = true;
    changed();
  });
  el.greenKey.addEventListener("change", changed);
  el.keepProps.addEventListener("change", changed);
  el.matteStrength.addEventListener("change", changed);
  document.getElementById("videoAddAction").addEventListener("click", addVideoActionToDraft);
  document.getElementById("videoConfirmAction").addEventListener("click", confirmVideoActionPreview);
  document.getElementById("videoFinishPet").addEventListener("click", finishVideoPetDraft);
  document.getElementById("videoBuilderCancel").addEventListener("click", closeVideoActionBuilder);
  document.getElementById("videoBuilderClose").addEventListener("click", closeVideoActionBuilder);
}

// ===== 点击互动 =====
function petAnimationDuration(p, name, fallback = 1000) {
  const action = p.sprite?.actions?.[name];
  return action ? ((action.count || 1) / (action.fps || 8)) * 1000 + 200 : fallback;
}

function onClick(p) {
  if (Date.now() < p.suppressClickUntil) return;
  const now = Date.now();
  pokeInteract();
  setMood(p, "好开心！", 6000);
  if (p.attentionMode) {
    p.attentionMode = false;
    p.state = "returning-home";
    p.rest = 0;
    p.vx = 0;
    p.vy = 0;
    playPetAnim(p, "happy", petAnimationDuration(p, "happy", 1000));
    bubble(p, pick(bubblePack(p).return), false);
    return;
  }
  p.clicks = p.clicks.filter((t) => now - t < 800);
  p.clicks.push(now);
  const n = p.clicks.length;
  if (n >= 5) {
    // 彩蛋3.1：连点狂戳
    p.el.classList.remove("shake", "spin", "bounce");
    void p.el.offsetWidth;
    p.el.classList.add("shake");
    bubble(p, EGG.poke, false);
    playPetAnim(p, "failed", 1300);
    p.clicks = [];
    return;
  }
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    const m = p.clicks.length;
    if (m === 1) react(p, "single");
    else if (m === 2) react(p, "double");
    else react(p, "multi");
    p.clicks = [];
  }, 340);
}

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

// 彩蛋文案
const EGG = {
  poke: "别戳我啦！去找黑鼠吧",
};

let lastInteract = Date.now();
function pokeInteract() {
  lastInteract = Date.now();
}

function startAttention(p) {
  if (!p || p.dragging || p.state === "alert" || p.attentionMode) return;
  p.attentionMode = true;
  p.state = "following";
  p.rest = 0;
  setMood(p, "有点无聊", 10000);
  bubble(p, pick(bubblePack(p).attention), false);
  const waiting = p.sprite?.actions?.waiting;
  const waitingDuration = waiting ? ((waiting.count || 1) / (waiting.fps || 8)) * 1000 + 200 : 1600;
  playPetAnim(p, "waiting", waitingDuration);
}

function react(p, type) {
  p.el.classList.remove("shake", "spin", "bounce");
  void p.el.offsetWidth;
  let txt = "";
  if (type === "single") {
    if (!hasPetAnim(p, "jump")) p.el.classList.add("bounce");
    const jump = p.sprite?.actions?.jump;
    const jumpDuration = jump ? ((jump.count || 1) / (jump.fps || 8)) * 1000 + 200 : 900;
    playPetAnim(p, "jump", jumpDuration);
    txt = pick(bubblePack(p).single);
  } else if (type === "double") {
    if (!hasPetAnim(p, "wave")) p.el.classList.add("spin");
    const wave = p.sprite?.actions?.wave;
    const waveDuration = wave ? ((wave.count || 1) / (wave.fps || 8)) * 1000 + 200 : 1100;
    playPetAnim(p, "wave", waveDuration);
    txt = pick(bubblePack(p).double);
  } else if (type === "multi") {
    if (!hasPetAnim(p, "happy")) p.el.classList.add("bounce");
    playPetAnim(p, "happy", petAnimationDuration(p, "happy", 1300));
    txt = pick(bubblePack(p).multi);
  } else {
    p.el.classList.add("shake");
    playPetAnim(p, "failed", 1300);
    txt = pick(TALK.crazy);
  }
  bubble(p, txt, false);
  setMood(p, type === "multi" ? "开心转圈中" : "被摸摸啦", 5000);
}

function hasPetAnim(p, name) {
  return Boolean(p.sprite && p.sprite.actions && p.sprite.actions[name]);
}

function playPetAnim(p, name, duration) {
  // Built-in pets can unlock actions gradually. Never leave a generic
  // interaction stranded on a frozen frame just because its named animation
  // has not been created for that pet yet.
  const fallback = {
    waiting: "idleSit",
    jump: "stretch",
    wave: "groom",
    happy: "stretch",
    failed: "idleSit",
  };
  const action = hasPetAnim(p, name) ? name : fallback[name];
  if (!action || !hasPetAnim(p, action)) return;
  p.transientAnim = action;
  p.transientUntil = Date.now() + duration;
}

function bubble(p, txt, alert) {
  const b = document.createElement("div");
  b.className = "bubble" + (alert ? " alert" : "");
  b.textContent = txt;
  document.body.appendChild(b);
  const pr = p.el.getBoundingClientRect();
  b.style.left = pr.left + pr.width / 2 - b.offsetWidth / 2 + "px";
  b.style.top = pr.top - 38 + "px";
  setTimeout(() => b.remove(), alert ? 3200 : 1800);
}

const PET_ACTION_LABELS = {
  idle: "站立待机", idleSit: "坐姿待机", lookAround: "好奇张望", sleep: "趴下睡觉", groom: "舔爪洗脸", stretch: "伸懒腰", yawn: "打哈欠", walkRight: "向右走", walkLeft: "向左走", walk: "走一走",
  wave: "挥爪", jump: "跳跃", failed: "委屈", waiting: "等待",
  working: "工作", review: "查看", happy: "开心", eat: "吃东西",
};

const PET_ACTION_TALKS = {
  idle: "我就在这儿陪你。",
  idleSit: "坐一会儿，看看你。",
  lookAround: "让我四处看看。",
  sleep: "我要趴下睡会。",
  groom: "整理一下毛毛。",
  stretch: "伸个懒腰，舒服多啦。",
  yawn: "有点困啦……",
  walkRight: "去那边走走。",
  walkLeft: "换个方向逛逛。",
  walk: "散散步去。",
  wave: "嗨，和你打个招呼！",
  jump: "看我跳一下！",
  failed: "别戳太用力嘛。",
  waiting: "我在等你呀。",
  working: "我也认真一会儿。",
  review: "让我想想看。",
  happy: "今天心情很好！",
  eat: "补充一点小能量。",
};

let actionMenu = null;
let actionMenuTimer = null;

function closePetActionMenu() {
  clearTimeout(actionMenuTimer);
  actionMenu?.remove();
  actionMenu = null;
  reportHotspots(true);
}

function showPetActionMenu(p, x, y) {
  closePetActionMenu();
  const actions = Object.entries(p.sprite?.actions || {});
  if (!actions.length) {
    bubble(p, "我暂时还没有可用动作。", false);
    return;
  }
  const menu = document.createElement("div");
  menu.className = "pet-action-menu";
  menu.innerHTML = `<div class="pet-action-menu-title">${escapeAttr(p.name)} 的动作</div>${actions.map(([name]) =>
    `<button type="button" data-action="${escapeAttr(name)}">${escapeAttr(PET_ACTION_LABELS[name] || name)}</button>`
  ).join("")}`;
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(innerWidth - width - 8, x)) + "px";
  menu.style.top = Math.max(8, Math.min(innerHeight - height - 8, y)) + "px";
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const name = button.dataset.action;
    const config = p.sprite.actions[name];
    const duration = Math.max(900, ((config.count || 1) / (config.fps || 8)) * 1000 + 350);
    p.rest = 0;
    p.idleAnim = p.sprite?.defaultIdle || "idle";
    playPetAnim(p, name, duration);
    setMood(p, `正在${PET_ACTION_LABELS[name] || name}`, duration);
    bubble(p, PET_ACTION_TALKS[name] || "这个动作送给你。", false);
    closePetActionMenu();
  });
  actionMenu = menu;
  reportHotspots(true);
  actionMenuTimer = setTimeout(closePetActionMenu, 7000);
}

// ===== sprite 帧动画：状态机 + 切帧 =====
// 根据宠物当前状态决定播放哪个动作
function spriteAnimFor(p) {
  const s = p.sprite;
  if (!s) return "idle";
  if (p.transientAnim && Date.now() < p.transientUntil) return p.transientAnim;
  if (p.transientAnim) p.transientAnim = null;
  if (p.state === "alert") return hasPetAnim(p, "waiting") ? "waiting" : "happy";
  if (p.rest > 0) return hasPetAnim(p, p.idleAnim) ? p.idleAnim : "idle";
  if (Math.abs(p.vx) > 0.05 || Math.abs(p.vy) > 0.05) {
    if (p.vx < -0.05 && hasPetAnim(p, "walkLeft")) return "walkLeft";
    if (p.vx > 0.05 && hasPetAnim(p, "walkRight")) return "walkRight";
    return hasPetAnim(p, "walk") ? "walk" : "idle";
  }
  const defaultIdle = s.defaultIdle && hasPetAnim(p, s.defaultIdle) ? s.defaultIdle : "idle";
  return defaultIdle;
}

// 每帧推进动画时钟，按 fps 切 background-position
function tickSprite(p, now) {
  const s = p.sprite;
  if (!s || !p.bodyEl) return;
  const want = spriteAnimFor(p);
  if (p.anim !== want) {
    p.anim = want;
    p.animTime = 0;
  }
  const act = s.actions[want] || s.actions.idle;
  if (!act) return;
  const dt = now - (p.lastTick || now);
  p.lastTick = now;
  p.animTime += dt;
  const frameDur = 1000 / (act.fps || 8);
  let idx = Math.floor(p.animTime / frameDur);
  if (idx >= act.count) {
    if (act.loop !== false) {
      p.animTime = 0;
      idx = 0;
    } else {
      idx = act.count - 1;
    }
  }
  const grid = act.grid || s.grid || spriteGrid(s);
  const source = act.src || s.src;
  const sheetKey = `${source}|${grid.cols}x${grid.rows}|${p.size}`;
  if (p.spriteSheetKey !== sheetKey) {
    p.bodyEl.style.backgroundImage = 'url("' + source + '")';
    p.bodyEl.style.backgroundSize = grid.cols * p.size + "px " + grid.rows * p.size + "px";
    p.spriteSheetKey = sheetKey;
  }
  const frameIndex = (act.start || 0) + idx;
  const x = -((frameIndex % grid.cols) * p.size);
  const y = -(((act.row || 0) + Math.floor(frameIndex / grid.cols)) * p.size);
  p.bodyEl.style.transform = act.flipX ? "scaleX(-1)" : "";
  p.bodyEl.style.backgroundPosition = x + "px " + y + "px";
}

// ===== 游走 loop =====
function movePetToward(p, targetX, targetY, speed) {
  const dx = targetX - p.x;
  const dy = targetY - p.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= speed) {
    p.x = targetX;
    p.y = targetY;
    p.vx = 0;
    p.vy = 0;
    return true;
  }
  p.vx = (dx / distance) * speed;
  p.vy = (dy / distance) * speed;
  p.x += p.vx;
  p.y += p.vy;
  return false;
}

// ===== 多宠物社交 =====
// 只保存为运行时状态：互动结束后各自继续原有的游走，不影响用户的档案与设置。
let nextSocialAt = Date.now() + 8000;

function socialEligible(p) {
  return p.el && p.state === "wander" && !p.dragging && !p.attentionMode && !p.social;
}

function socialPoint(p, x, y) {
  return {
    x: Math.max(8, Math.min(innerWidth - p.size - 8, x)),
    y: Math.max(8, Math.min(innerHeight - p.size - 8, y)),
  };
}

function socialAnimation(p, duration) {
  const choices = ["wave", "happy", "jump", "stretch", "lookAround", "idleSit", "idle"];
  const action = choices.find((name) => hasPetAnim(p, name));
  if (action) playPetAnim(p, action, duration);
}

function beginSocialMoment(a, b) {
  if (!a.social || !b.social || a.social.phase !== "approach" || b.social.phase !== "approach") return;
  const now = Date.now();
  const duration = 2600;
  a.social.phase = "perform";
  b.social.phase = "perform";
  a.social.until = now + duration;
  b.social.until = now + duration;
  const play = a.social.type === "play";
  socialAnimation(a, duration);
  socialAnimation(b, duration);
  setMood(a, play ? `正在和${b.name}玩耍` : `正在和${b.name}打招呼`, duration);
  setMood(b, play ? `正在和${a.name}玩耍` : `正在和${a.name}打招呼`, duration);
  bubble(a, play ? "一起玩一会吧！" : "嗨，你好呀~", false);
  bubble(b, play ? "好呀好呀！" : "见到你啦！", false);
}

function endSocialMoment(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const length = Math.hypot(dx, dy) || 1;
  [[a, dx / length, dy / length], [b, -dx / length, -dy / length]].forEach(([p, vx, vy]) => {
    p.social = null;
    if (p.state === "social") p.state = "wander";
    p.vx = vx * 1.1;
    p.vy = vy * 0.8;
  });
}

function tickSocialInteraction(p) {
  const social = p.social;
  const partner = social && pets.find((item) => item.id === social.partnerId && item.el);
  if (!social || !partner || !partner.social) {
    p.social = null;
    if (p.state === "social") p.state = "wander";
    return false;
  }
  if (social.phase === "approach") {
    social.arrived = movePetToward(p, social.target.x, social.target.y, 3.1);
    p.el.style.left = p.x + "px";
    p.el.style.top = p.y + "px";
    if (social.arrived && partner.social.arrived) beginSocialMoment(p, partner);
    return true;
  }
  if (social.phase === "perform") {
    p.vx = 0;
    p.vy = 0;
    if (Date.now() >= social.until) endSocialMoment(p, partner);
    return true;
  }
  return false;
}

function startSocialInteraction(a, b) {
  const now = Date.now();
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const midpointX = (a.x + b.x) / 2;
  const midpointY = (a.y + b.y) / 2;
  const gap = Math.max(a.size, b.size) * 0.7;
  a.social = {
    partnerId: b.id,
    phase: "approach",
    arrived: false,
    type: Math.random() < 0.5 ? "greet" : "play",
    target: socialPoint(a, midpointX - (dx / length) * gap, midpointY - (dy / length) * gap),
  };
  b.social = {
    partnerId: a.id,
    phase: "approach",
    arrived: false,
    type: a.social.type,
    target: socialPoint(b, midpointX + (dx / length) * gap, midpointY + (dy / length) * gap),
  };
  a.state = "social";
  b.state = "social";
  a.rest = 0;
  b.rest = 0;
  setMood(a, `想找${b.name}玩`, 7000);
  setMood(b, `注意到${a.name}`, 7000);
}

function maybeStartSocialInteraction() {
  const now = Date.now();
  if (now < nextSocialAt) return;
  nextSocialAt = now + 40000 + Math.random() * 40000;
  const candidates = activePets().filter(socialEligible);
  if (candidates.length < 2) return;
  let pair = null;
  let nearest = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const distance = Math.hypot(candidates[i].x - candidates[j].x, candidates[i].y - candidates[j].y);
      if (distance < nearest) {
        nearest = distance;
        pair = [candidates[i], candidates[j]];
      }
    }
  }
  if (pair && nearest < 520) startSocialInteraction(pair[0], pair[1]);
}

function loop() {
  // Schedule first: a transient DOM/texture error must never permanently stop
  // the desktop pet on its current sprite frame.
  requestAnimationFrame(loop);
  try {
    const now = performance.now();
    maybeStartSocialInteraction();
    activePets().forEach((p) => {
    if (p.dragging) {
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.state === "alert") {
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.social && tickSocialInteraction(p)) {
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.state === "drag-rest") {
      if (Date.now() >= p.dragRestUntil) p.state = "returning-home";
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.attentionMode) {
      const tx = Math.max(8, Math.min(innerWidth - p.size - 8, mousePosition.x - p.size / 2));
      const ty = Math.max(8, Math.min(innerHeight - p.size - 8, mousePosition.y - p.size - 24));
      movePetToward(p, tx, ty, 4.2);
      p.el.style.left = p.x + "px";
      p.el.style.top = p.y + "px";
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.state === "returning-home") {
      const b = patrolBounds(p.size);
      const arrived = movePetToward(p, b.maxX - 70, b.maxY - 35, 5.2);
      p.el.style.left = p.x + "px";
      p.el.style.top = p.y + "px";
      if (arrived) {
        p.state = "wander";
        p.vx = (Math.random() - 0.5) * 1.1;
        p.vy = (Math.random() - 0.5) * 0.8;
      }
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (Date.now() >= p.nextRoutineAt) startRoutine(p);
    if (p.rest > 0) {
      p.rest--;
      if (p.sprite) tickSprite(p, now);
      return;
    }
    p.x += p.vx;
    p.y += p.vy;
    const bounds = patrolBounds(p.size);
    if (p.x < bounds.minX) {
      p.x = bounds.minX;
      p.vx *= -1;
    }
    if (p.x > bounds.maxX) {
      p.x = bounds.maxX;
      p.vx *= -1;
    }
    if (p.y < bounds.minY) {
      p.y = bounds.minY;
      p.vy *= -1;
    }
    if (p.y > bounds.maxY) {
      p.y = bounds.maxY;
      p.vy *= -1;
    }
    if (Math.random() < 0.004) {
      p.vx = (Math.random() - 0.5) * 1.4;
      p.vy = (Math.random() - 0.5) * 1.4;
    }
    p.el.style.left = p.x + "px";
    p.el.style.top = p.y + "px";
    if (p.sprite) tickSprite(p, now);
    });
  } catch (error) {
    console.error("[pet] animation frame recovered", error);
  }
}

// 把当前可交互区域（宠物/面板/展开按钮）的矩形上报给 Rust，用于动态切换穿透/捕获
let lastReport = 0;
function reportHotspots(force = false) {
  const now = Date.now();
  if (!force && now - lastReport < 120) return;
  lastReport = now;
  const hs = [];
  const dragging = activePets().some((p) => p.dragging);
  if (dragging) {
    hs.push({ x: 0, y: 0, w: innerWidth, h: innerHeight });
  }
  activePets().forEach((p) => {
    const r = p.el.getBoundingClientRect();
    if (r.width && r.height)
      hs.push({ x: r.left - 10, y: r.top - 10, w: r.width + 20, h: r.height + 20 });
  });
  if (actionMenu) {
    const r = actionMenu.getBoundingClientRect();
    if (r.width && r.height) hs.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const panel = document.getElementById("panel");
  if (panel && !panel.classList.contains("collapsed")) {
    const r = panel.getBoundingClientRect();
    if (r.width && r.height) hs.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  } else {
    const tb = document.getElementById("toggleBtn");
    if (tb && getComputedStyle(tb).display !== "none") {
      const r = tb.getBoundingClientRect();
      if (r.width && r.height) hs.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
  }
  try {
    invoke("set_hotspots", { hotspots: hs });
  } catch (e) {}
}

// ===== 提醒 =====
function checkAlerts() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const t = hh + ":" + mm;
  const dayKey = now.toDateString();
  const dow = now.getDay();
  const isWeekday = dow >= 1 && dow <= 5;
  const nowTs = Date.now();
  settings.reminders.forEach((r) => {
    if (r.enabled === false) return;
    if (r.type === "interval") {
      const gap = (parseInt(r.interval) || 1) * 60000;
      if (nowTs - (r.lastFired || 0) >= gap) {
        r.lastFired = nowTs;
        fireAlert(r.message || r.label || "提醒时间到", r.id);
        persist();
      }
      return;
    }
    if (r.repeat === "weekday" && !isWeekday) return;
    if (r.time === t && !alertsDone[r.id + dayKey + t]) {
      alertsDone[r.id + dayKey + t] = 1;
      fireAlert(r.message || r.label || "提醒时间到", r.id);
    }
  });
}

function fireAlert(msg, kind) {
  const act = activePets();
  if (!act.length) return;
  const p = act[0];
  p.state = "alert";
  p.el.classList.add("alert");
  const tx = innerWidth / 2 - p.size / 2;
  const ty = innerHeight / 2 - p.size / 2;
  p.el.style.transition = "left .6s, top .6s, transform .6s";
  p.el.style.left = tx + "px";
  p.el.style.top = ty + "px";
  p.el.style.transform = "scale(1.4)";
  bubble(p, msg, true);
  setTimeout(() => {
    p.el.style.transition = "";
    p.el.style.transform = "";
    p.el.classList.remove("alert");
    p.state = "wander";
  }, 3400);
}

// ===== 启动 =====
async function init() {
  if (!IS_PANEL) {
    // macOS 和 Windows 都依赖原生钩子在宠物热区与透明区域之间切换。
    // 必须先实际开启穿透；否则 Windows 在没有宠物热区时会认为已经穿透，
    // 但全屏透明宠物窗仍会盖住控制面板。
    const supportsNativeClickThrough = /Mac|iPhone|iPad|Win/i.test(navigator.platform || navigator.userAgent);
    if (supportsNativeClickThrough) {
      try { await getCurrentWindow().setIgnoreCursorEvents(true); } catch (e) { console.warn("穿透不可用", e); }
    }
  }
  await initStore();
  let saved = null;
  try { saved = store ? await store.get("pets") : JSON.parse(localStorage.getItem("pet-backup") || "{}").pets; } catch (e) {}
  function loadProfiles(profiles) {
    let droppedStaleOfficialActions = false;
    pets.forEach((p) => { p.el?.remove(); p.statusCard?.remove(); });
    pets = [];
    idc = 0;
    (profiles || []).forEach((p) => {
      if (p.sprite?.presetId === "fenzai-v1") {
        const official = createFenzaiProfile();
        // 旧版把同名用户动作直接写进 actions；迁移后改为 actionOverrides，明确标记为“我的版本”。
        const additions = Object.fromEntries(Object.entries(p.sprite.actions || {}).filter(([name, action]) => {
          const overridesOfficial = action?.userGenerated && official.sprite.actions[name];
          if (overridesOfficial) droppedStaleOfficialActions = true;
          return action?.userGenerated && !official.sprite.actions[name];
        }));
        const actionOverrides = Object.fromEntries(Object.entries(p.sprite.actionOverrides || {}).filter(([name, action]) => action?.userGenerated && official.sprite.actions[name]));
        p = { ...p, name: official.name, src: official.src, cover: p.cover || official.cover, sprite: { ...official.sprite, actions: { ...official.sprite.actions, ...additions, ...actionOverrides }, actionOverrides } };
      }
      if (p.sprite?.presetId === "momo-v1") {
        const official = createMomoProfile();
        const additions = Object.fromEntries(Object.entries(p.sprite.actions || {}).filter(([name, action]) => {
          const overridesOfficial = action?.userGenerated && official.sprite.actions[name];
          if (overridesOfficial) droppedStaleOfficialActions = true;
          return action?.userGenerated && !official.sprite.actions[name];
        }));
        const actionOverrides = Object.fromEntries(Object.entries(p.sprite.actionOverrides || {}).filter(([name, action]) => action?.userGenerated && official.sprite.actions[name]));
        p = { ...p, name: official.name, src: official.src, cover: p.cover || official.cover, sprite: { ...official.sprite, actions: { ...official.sprite.actions, ...additions, ...actionOverrides }, actionOverrides } };
      }
      const isOldDemo = p.name === "示例精灵" && p.mode === "sprite" && p.sprite && String(p.sprite.src || "").startsWith("data:image/svg+xml");
      if (isOldDemo) { p.src = DEMO_SPRITE.src; p.sprite = DEMO_SPRITE; p.cover = DEMO_SPRITE.cover; p.name = "莓啵"; }
      spawnPet(p, p.status);
    });
    return droppedStaleOfficialActions;
  }
  // 旧版把上传内容存成 Base64；只由主窗迁移一次，避免双窗口重复写文件。
  const migratedLegacyAssets = IS_PANEL && await migrateLegacyAssets(saved);
  const droppedStaleOfficialActions = loadProfiles(saved);
  if (migratedLegacyAssets || droppedStaleOfficialActions) await persist();
  // 仅控制面板负责补齐内置宠物，避免两个窗口同时持久化部分 pets 数组。
  if (IS_PANEL && !pets.some((p) => p.sprite?.presetId === "fenzai-v1")) {
    spawnPet(createFenzaiProfile());
    await persist();
  }
  if (IS_PANEL && !pets.some((p) => p.sprite?.presetId === "momo-v1")) {
    spawnPet(createMomoProfile(), "stored");
    await persist();
  }
  applySettingsToUI();
  await listen("store-changed", (event) => {
    const payload = event.payload || {};
    Object.assign(settings, payload.settings || {});
    loadProfiles(payload.pets || []);
    if (IS_PANEL) {
      applySettingsToUI();
      return;
    }
  });
  if (!IS_PANEL) {
    document.addEventListener("pointermove", (event) => { mousePosition = { x: event.clientX, y: event.clientY }; });
    loop();
    setInterval(() => { const act = activePets(); if (settings.attentionEnabled !== false && act.length && Date.now() - lastInteract >= attentionDelayMs() && !act.some((p) => p.attentionMode)) startAttention(act[Math.floor(Math.random() * act.length)]); }, 5000);
    setInterval(async () => { try { const cursor = await invoke("get_cursor_position"); if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) mousePosition = cursor; } catch (e) {} }, 120);
    setInterval(reportHotspots, 120);
    setInterval(checkAlerts, 10000);
    return;
  }
  setupPanel();
}

function setupPanel() {
  setupCoverCropper();
  setupVideoActionBuilder();
  const viewCopy = {
    upload: ["上传宠物", "把喜欢的伙伴带到桌面上吧"], warehouse: ["宠物仓库", "管理每一位桌面伙伴"],
    actions: ["动作管理", "查看精灵的动作配置"], reminders: ["提醒事项", "让宠物在需要时来叫你"], settings: ["设置", "调整陪伴节奏"],
  };
  const showView = (name) => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    document.getElementById("viewTitle").textContent = viewCopy[name][0]; document.getElementById("viewSub").textContent = viewCopy[name][1];
  };
  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
  document.getElementById("modeImage").addEventListener("click", () => document.getElementById("file").click());
  document.getElementById("modeSpriteDemo").addEventListener("click", () => spawnSpritePet({ name: "莓啵", sprite: DEMO_SPRITE }));
  document.getElementById("modeSpriteUpload").addEventListener("click", () => document.getElementById("spriteFile").click());
  document.getElementById("file").addEventListener("change", (e) => addPets(e.target));
  document.getElementById("spriteFile").addEventListener("change", (e) => addSpritePets(e.target));
  document.getElementById("attentionMinutes").addEventListener("change", (e) => { settings.attentionMinutes = Math.max(1, Math.min(240, parseInt(e.target.value) || 20)); e.target.value = settings.attentionMinutes; persist(); });
  document.getElementById("attentionEnabled").addEventListener("click", (e) => { settings.attentionEnabled = !e.currentTarget.classList.contains("on"); e.currentTarget.classList.toggle("on", settings.attentionEnabled); e.currentTarget.setAttribute("aria-checked", String(settings.attentionEnabled)); persist(); });
  document.getElementById("speechStyle").addEventListener("change", (e) => { settings.speechStyle = e.target.value; persist(); });
  document.getElementById("actionPetSelect").addEventListener("change", (e) => { settings.actionPetId = Number(e.target.value); renderActionManager(); });
  document.getElementById("actionManager").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-action-restore]");
    if (!button) return;
    const p = pets.find((item) => item.id === settings.actionPetId);
    const name = button.dataset.actionRestore;
    const official = officialProfileForPreset(p?.sprite?.presetId);
    if (!p?.sprite?.actionOverrides?.[name] || !official?.sprite.actions[name]) return;
    if (!confirm(`恢复「${PET_ACTION_LABELS[name] || name}」的内置版本吗？\n\n你的当前版本会停止使用。`)) return;
    delete p.sprite.actionOverrides[name];
    p.sprite.actions[name] = official.sprite.actions[name];
    await persist();
    renderActionManager();
  });
  const applyPetSize = (value) => {
    const size = normalizedPetSize(value);
    if (settings.petSizeScope === "single") {
      const p = pets.find((item) => item.id === Number(settings.petSizePetId));
      if (p) resizePet(p, size);
    } else {
      settings.petSize = size;
      pets.forEach((p) => resizePet(p, size));
    }
    document.getElementById("petSizeValue").textContent = size + " px";
  };
  document.getElementById("petSizeScope").addEventListener("change", (e) => { settings.petSizeScope = e.target.value; if (settings.petSizeScope === "single" && !pets.some((p) => p.id === Number(settings.petSizePetId))) settings.petSizePetId = pets[0]?.id || null; applySettingsToUI(); persist(); });
  document.getElementById("petSizeTarget").addEventListener("change", (e) => { settings.petSizePetId = Number(e.target.value); applySettingsToUI(); persist(); });
  document.getElementById("petSize").addEventListener("input", (e) => applyPetSize(e.target.value));
  document.getElementById("petSize").addEventListener("change", () => persist());
  const wh = document.getElementById("petWarehouse");
  const updatePetCard = (e) => { const card = e.target.closest(".pet-card"); const p = card && pets.find((x) => x.id == card.dataset.id); if (!p) return false; if (e.target.classList.contains("p-name")) { if (["fenzai-v1", "momo-v1"].includes(p.sprite?.presetId)) return false; p.name = e.target.value; } else if (e.target.classList.contains("p-hobby")) p.hobby = e.target.value; else if (e.target.classList.contains("p-personality")) p.personality = e.target.value; else return false; return true; };
  // 输入时不广播，否则主窗会收到自己的 store-changed 并重绘卡片，导致输入框失焦。
  wh.addEventListener("input", updatePetCard);
  wh.addEventListener("change", (e) => { if (updatePetCard(e)) persist(); });
  wh.addEventListener("click", (e) => { const card = e.target.closest(".pet-card"); const p = card && pets.find((x) => x.id == card.dataset.id); if (!p) return; if (e.target.classList.contains("p-toggle")) p.status === "active" ? storePet(p.id) : releasePet(p.id); else if (e.target.classList.contains("p-cover")) { coverTargetId = p.id; document.getElementById("coverFile").click(); } else if (e.target.classList.contains("p-del") && !e.target.disabled) { if (card.classList.contains("confirming")) deletePet(p.id); else { card.classList.add("confirming"); e.target.textContent = "确认?"; setTimeout(() => { if (card.isConnected) { card.classList.remove("confirming"); e.target.textContent = "✕"; } }, 2000); } } });
  document.getElementById("coverFile").addEventListener("change", (e) => { const file = e.target.files?.[0]; const p = pets.find((item) => item.id === coverTargetId); if (file && p) openCoverCropper(file); e.target.value = ""; });
  document.getElementById("addReminder").addEventListener("click", () => { settings.reminders.push({ id: "r" + Date.now(), label: "", type: "time", time: "12:00", interval: 30, message: "", repeat: "daily", enabled: true }); renderReminders(); persist(); });
  const list = document.getElementById("reminderList");
  const updateReminder = (e) => { const row = e.target.closest(".reminder"); const r = row && settings.reminders.find((x) => x.id === row.dataset.id); if (!r) return false; if (e.target.classList.contains("r-label")) r.label = e.target.value; else if (e.target.classList.contains("r-time")) r.time = e.target.value; else if (e.target.classList.contains("r-msg")) r.message = e.target.value; else if (e.target.classList.contains("r-repeat")) r.repeat = e.target.value; else if (e.target.classList.contains("r-interval")) r.interval = parseInt(e.target.value) || 1; else if (e.target.classList.contains("r-enabled")) r.enabled = e.target.checked; else if (e.target.classList.contains("r-type")) { r.type = e.target.value; renderReminders(); } else return false; return true; };
  list.addEventListener("input", updateReminder); list.addEventListener("change", (e) => { if (updateReminder(e)) persist(); }); list.addEventListener("click", (e) => { const row = e.target.closest(".reminder"); const reminder = row && settings.reminders.find((x) => x.id === row.dataset.id); if (!reminder) return; if (e.target.classList.contains("r-complete")) { if (reminder.type === "interval") reminder.completedAt = Date.now(); else reminder.completedDay = todayKey(); renderReminders(); persist(); return; } if (e.target.classList.contains("r-del")) { settings.reminders = settings.reminders.filter((x) => x.id !== row.dataset.id); renderReminders(); persist(); } });
}

/* legacy single-window init kept below during migration */
async function legacyInit() {
  // macOS 与 Windows 都有原生全局鼠标钩子，因此透明区域默认穿透。
  // Linux 暂保持可交互，避免无钩子时宠物永远点不到。
  const supportsNativeClickThrough = /Mac|iPhone|iPad|Win/i.test(navigator.platform || navigator.userAgent);
  if (supportsNativeClickThrough) {
    try {
      await getCurrentWindow().setIgnoreCursorEvents(true);
    } catch (e) {
      console.warn("穿透不可用，可能缺少权限", e);
    }
  }
  await initStore();
  applySettingsToUI();

  let saved = null;
  if (store) {
    try {
      saved = await store.get("pets");
    } catch (e) {}
  } else {
    try {
      const raw = localStorage.getItem("pet-backup");
      saved = raw ? JSON.parse(raw).pets : null;
    } catch (e) {}
  }
  if (saved && saved.length) {
    saved.forEach((p) => {
      const isOldDemo =
        p.name === "示例精灵" &&
        p.mode === "sprite" &&
        p.sprite &&
        !p.sprite.presetId &&
        String(p.sprite.src || "").startsWith("data:image/svg+xml");
      if (isOldDemo) {
        p.src = DEMO_SPRITE.src;
        p.sprite = DEMO_SPRITE;
      }
      spawnPet(p, p.status);
    });
  }
  renderWarehouse();

  // 上传：先展开模式选择
  document.getElementById("uploadBtn").addEventListener("click", () => {
    const mp = document.getElementById("modePicker");
    mp.style.display = mp.style.display === "none" ? "flex" : "none";
  });
  // 单图模式
  document.getElementById("modeImage").addEventListener("click", () => {
    document.getElementById("file").click();
  });
  // 2D 灵动：示例精灵（内置）
  document.getElementById("modeSpriteDemo").addEventListener("click", () => {
    spawnSpritePet({ name: "示例精灵", sprite: DEMO_SPRITE });
    document.getElementById("modePicker").style.display = "none";
  });
  // 2D 灵动：自定义上传 sprite sheet
  document.getElementById("modeSpriteUpload").addEventListener("click", () => {
    document.getElementById("spriteFile").click();
  });

  document.getElementById("collapseBtn").addEventListener("click", togglePanel);
  document.getElementById("toggleBtn").addEventListener("click", togglePanel);
  document.getElementById("file").addEventListener("change", (e) => addPets(e.target));
  document.getElementById("spriteFile").addEventListener("change", (e) => addSpritePets(e.target));
  document.getElementById("attentionMinutes").addEventListener("change", (e) => {
    settings.attentionMinutes = Math.max(1, Math.min(240, parseInt(e.target.value) || 20));
    e.target.value = settings.attentionMinutes;
    persist();
  });

  // 仓库：事件委托
  const wh = document.getElementById("petWarehouse");
  wh.addEventListener("input", (e) => {
    const card = e.target.closest(".pet-card");
    if (!card) return;
    const p = pets.find((x) => x.id == card.dataset.id);
    if (!p) return;
    if (e.target.classList.contains("p-name")) p.name = e.target.value;
    else if (e.target.classList.contains("p-hobby")) p.hobby = e.target.value;
    else if (e.target.classList.contains("p-personality"))
      p.personality = e.target.value;
    persist();
  });
  wh.addEventListener("click", (e) => {
    const card = e.target.closest(".pet-card");
    if (!card) return;
    const p = pets.find((x) => x.id == card.dataset.id);
    if (!p) return;
    if (e.target.classList.contains("p-toggle")) {
      if (p.status === "active") storePet(p.id);
      else releasePet(p.id);
    } else if (e.target.classList.contains("p-del")) {
      if (card.classList.contains("confirming")) {
        deletePet(p.id);
      } else {
        card.classList.add("confirming");
        e.target.textContent = "确认?";
        setTimeout(() => {
          if (card.isConnected) {
            card.classList.remove("confirming");
            e.target.textContent = "✕";
          }
        }, 2000);
      }
    }
  });

  // 新增提醒
  document.getElementById("addReminder").addEventListener("click", () => {
    settings.reminders.push({
      id: "r" + Date.now() + Math.floor(Math.random() * 1000),
      label: "",
      type: "time",
      time: "12:00",
      interval: 30,
      message: "",
      repeat: "daily",
      enabled: true,
    });
    renderReminders();
    persist();
  });

  // 提醒列表：事件委托
  const list = document.getElementById("reminderList");
  const onListChange = (e) => {
    const row = e.target.closest(".reminder");
    if (!row) return;
    const r = settings.reminders.find((x) => x.id === row.dataset.id);
    if (!r) return;
    if (e.target.classList.contains("r-label")) r.label = e.target.value;
    else if (e.target.classList.contains("r-time")) r.time = e.target.value;
    else if (e.target.classList.contains("r-msg")) r.message = e.target.value;
    else if (e.target.classList.contains("r-repeat")) r.repeat = e.target.value;
    else if (e.target.classList.contains("r-interval"))
      r.interval = parseInt(e.target.value) || 1;
    else if (e.target.classList.contains("r-enabled"))
      r.enabled = e.target.checked;
    else if (e.target.classList.contains("r-type")) {
      r.type = e.target.value;
      if (r.type === "interval") r.lastFired = Date.now();
      renderReminders();
      persist();
      return;
    }
    persist();
  };
  list.addEventListener("input", onListChange);
  list.addEventListener("change", onListChange);
  list.addEventListener("click", (e) => {
    if (!e.target.classList.contains("r-del")) return;
    const row = e.target.closest(".reminder");
    if (!row) return;
    settings.reminders = settings.reminders.filter((x) => x.id !== row.dataset.id);
    renderReminders();
    persist();
  });

  document.addEventListener("pointermove", (event) => {
    mousePosition = { x: event.clientX, y: event.clientY };
  });

  loop();
  setInterval(() => {
    const act = activePets();
    if (act.length && Date.now() - lastInteract >= attentionDelayMs() && !act.some((p) => p.attentionMode)) {
      startAttention(act[Math.floor(Math.random() * act.length)]);
    }
  }, 5000);
  setInterval(async () => {
    try {
      const cursor = await invoke("get_cursor_position");
      if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) mousePosition = cursor;
    } catch (e) {}
  }, 120);
  setInterval(reportHotspots, 120);
  setInterval(checkAlerts, 10000);
}

init();
