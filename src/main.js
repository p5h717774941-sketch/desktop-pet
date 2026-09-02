import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { DEMO_SPRITE, SPRITE_PRESET } from "./sprite-demo.js";
import { createFenzaiProfile } from "./fenzai-sprite.js";
import "./fenzai.css";

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
    sprite: p.sprite || null,
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
    if (p.sprite?.presetId === "fenzai-v1") continue;
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
  const picker = document.getElementById("actionPetSelect");
  if (picker) picker.innerHTML = pets.map((item) => `<option value="${item.id}"${item.id === p.id ? " selected" : ""}>${escapeAttr(item.name)}</option>`).join("");
  box.innerHTML = `<div class="action-grid">${Object.entries(actionNames).map(([name, label]) => {
      const a = actions[name];
      return a
        ? `<div class="action-card"><strong>${label}</strong><small>已解锁 · ${a.count} 帧 · ${a.fps || 8} fps</small></div>`
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
    const official = p.sprite?.presetId === "fenzai-v1";
    const modeTag =
      p.mode === "sprite" ? "2D" : p.mode === "vrm" ? "3D" : "图";
    const card = document.createElement("div");
    card.className = "pet-card" + (active ? " is-out" : "");
    card.dataset.id = p.id;
    card.innerHTML = `
      <div class="pet-cover"><img class="p-thumb" src="${escapeAttr(p.cover || p.src)}" alt="" /></div>
      <div class="p-info">
        <div class="pet-name-line"><input class="p-name" value="${escapeAttr(p.name || "")}" placeholder="名字" /><span class="p-live">${active ? "桌面游走" : "已收回"}</span></div>
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
  if (!p || p.sprite?.presetId === "fenzai-v1") return;
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
    bubble(p, `来一个${PET_ACTION_LABELS[name] || name}~`, false);
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
    pets.forEach((p) => { p.el?.remove(); p.statusCard?.remove(); });
    pets = [];
    idc = 0;
    (profiles || []).forEach((p) => {
      if (p.sprite?.presetId === "fenzai-v1") {
        const official = createFenzaiProfile();
        // 内置动作配置随版本更新，但用户在仓库里换过的封面必须保留。
        p = { ...p, src: official.src, cover: p.cover || official.cover, sprite: official.sprite };
      }
      const isOldDemo = p.name === "示例精灵" && p.mode === "sprite" && p.sprite && String(p.sprite.src || "").startsWith("data:image/svg+xml");
      if (isOldDemo) { p.src = DEMO_SPRITE.src; p.sprite = DEMO_SPRITE; p.cover = DEMO_SPRITE.cover; p.name = "莓啵"; }
      spawnPet(p, p.status);
    });
  }
  // 旧版把上传内容存成 Base64；只由主窗迁移一次，避免双窗口重复写文件。
  const migratedLegacyAssets = IS_PANEL && await migrateLegacyAssets(saved);
  loadProfiles(saved);
  if (migratedLegacyAssets) await persist();
  // 仅控制面板负责补齐内置宠物，避免两个窗口同时持久化部分 pets 数组。
  if (IS_PANEL && !pets.some((p) => p.sprite?.presetId === "fenzai-v1")) {
    spawnPet(createFenzaiProfile());
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
  wh.addEventListener("input", (e) => { const card = e.target.closest(".pet-card"); const p = card && pets.find((x) => x.id == card.dataset.id); if (!p) return; if (e.target.classList.contains("p-name")) p.name = e.target.value; else if (e.target.classList.contains("p-hobby")) p.hobby = e.target.value; else if (e.target.classList.contains("p-personality")) p.personality = e.target.value; persist(); });
  wh.addEventListener("click", (e) => { const card = e.target.closest(".pet-card"); const p = card && pets.find((x) => x.id == card.dataset.id); if (!p) return; if (e.target.classList.contains("p-toggle")) p.status === "active" ? storePet(p.id) : releasePet(p.id); else if (e.target.classList.contains("p-cover")) { coverTargetId = p.id; document.getElementById("coverFile").click(); } else if (e.target.classList.contains("p-del") && !e.target.disabled) { if (card.classList.contains("confirming")) deletePet(p.id); else { card.classList.add("confirming"); e.target.textContent = "确认?"; setTimeout(() => { if (card.isConnected) { card.classList.remove("confirming"); e.target.textContent = "✕"; } }, 2000); } } });
  document.getElementById("coverFile").addEventListener("change", (e) => { const file = e.target.files?.[0]; const p = pets.find((item) => item.id === coverTargetId); if (file && p) openCoverCropper(file); e.target.value = ""; });
  document.getElementById("addReminder").addEventListener("click", () => { settings.reminders.push({ id: "r" + Date.now(), label: "", type: "time", time: "12:00", interval: 30, message: "", repeat: "daily", enabled: true }); renderReminders(); persist(); });
  const list = document.getElementById("reminderList");
  const changeReminder = (e) => { const row = e.target.closest(".reminder"); const r = row && settings.reminders.find((x) => x.id === row.dataset.id); if (!r) return; if (e.target.classList.contains("r-label")) r.label = e.target.value; else if (e.target.classList.contains("r-time")) r.time = e.target.value; else if (e.target.classList.contains("r-msg")) r.message = e.target.value; else if (e.target.classList.contains("r-repeat")) r.repeat = e.target.value; else if (e.target.classList.contains("r-interval")) r.interval = parseInt(e.target.value) || 1; else if (e.target.classList.contains("r-enabled")) r.enabled = e.target.checked; else if (e.target.classList.contains("r-type")) { r.type = e.target.value; renderReminders(); } persist(); };
  list.addEventListener("input", changeReminder); list.addEventListener("change", changeReminder); list.addEventListener("click", (e) => { const row = e.target.closest(".reminder"); const reminder = row && settings.reminders.find((x) => x.id === row.dataset.id); if (!reminder) return; if (e.target.classList.contains("r-complete")) { if (reminder.type === "interval") reminder.completedAt = Date.now(); else reminder.completedDay = todayKey(); renderReminders(); persist(); return; } if (e.target.classList.contains("r-del")) { settings.reminders = settings.reminders.filter((x) => x.id !== row.dataset.id); renderReminders(); persist(); } });
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
