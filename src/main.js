import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { DEMO_SPRITE, SPRITE_PRESET } from "./sprite-demo.js";

// ===== 状态 =====
// 宠物档案对象：{ id, name, hobby, personality, src, mode, status, sprite?, ...运行时字段 }
//   status: 'active'（已放出，桌面游走）| 'stored'（已收回，只待在仓库）
//   mode: 'image'（单图，可用）| 'sprite'（2D 灵动帧动画，可用）| 'vrm'（3D，开发中）
//   sprite: { src, frameW, frameH, actions:{ idle/walk/eat/happy: {row,count,fps,loop} } }
let pets = [];
let idc = 0;
let store = null;
const alertsDone = {};

// 提醒全部由用户自定义：默认空列表
// 每项：{ id, label, type:'time'|'interval', time:"HH:MM", interval:分钟, message, repeat:'daily'|'weekday', enabled, lastFired }
const settings = {
  reminders: [],
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
  };
}

async function persist() {
  const payload = { settings, pets: pets.map(petProfile) };
  if (store) {
    try {
      await store.set("settings", settings);
      await store.set("pets", payload.pets);
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  try {
    localStorage.setItem("pet-backup", JSON.stringify(payload));
  } catch (e) {}
}

// 当前放出的宠物（有 DOM 元素在桌面游走的）
function activePets() {
  return pets.filter((p) => p.status === "active" && p.el);
}

// ===== 面板交互 =====
function togglePanel() {
  document.getElementById("panel").classList.toggle("collapsed");
}

function applySettingsToUI() {
  renderReminders();
  renderWarehouse();
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
    row.innerHTML = `
      <div class="r-top">
        <input class="r-label" value="${escapeAttr(r.label || "")}" placeholder="提醒事项" />
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
    const modeTag =
      p.mode === "sprite" ? "2D" : p.mode === "vrm" ? "3D" : "图";
    const card = document.createElement("div");
    card.className = "pet-card" + (active ? " is-out" : "");
    card.dataset.id = p.id;
    card.innerHTML = `
      <img class="p-thumb" src="${escapeAttr(p.src)}" alt="" />
      <div class="p-info">
        <input class="p-name" value="${escapeAttr(p.name || "")}" placeholder="名字" />
        <input class="p-hobby" value="${escapeAttr(p.hobby || "")}" placeholder="爱好（可选）" />
        <input class="p-personality" value="${escapeAttr(p.personality || "")}" placeholder="性格（可选）" />
      </div>
      <div class="p-actions">
        <span class="p-status"><span class="p-mode">${modeTag}</span>${active ? " 已放出" : " 已收回"}</span>
        <button class="p-toggle" title="${active ? "收回" : "放出"}">${active ? "收回" : "放出"}</button>
        <button class="p-del" title="删除">✕</button>
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
  const p = {
    id: pid,
    name: profile.name || "宠物" + pid,
    hobby: profile.hobby || "",
    personality: profile.personality || "",
    src: profile.src,
    mode: profile.mode || "image",
    sprite: profile.sprite || null,
    status: st,
    el: null,
    x: Math.random() * (innerWidth - 200) + 50,
    y: Math.random() * (innerHeight - 200) + 50,
    vx: (Math.random() - 0.5) * 1.2,
    vy: (Math.random() - 0.5) * 1.2,
    size: 90 + Math.random() * 40,
    state: "wander",
    rest: 0,
    clicks: [],
    timer: null,
    // sprite 运行时字段
    bodyEl: null,
    anim: "idle",
    animTime: 0,
    lastTick: 0,
    happyUntil: 0,
  };
  pets.push(p);
  if (st === "active") mountPet(p);
  return p;
}

// 计算 sprite 网格的行列数（用于 background-size 缩放）
function spriteGrid(sprite) {
  if (!sprite || !sprite.actions) return { rows: 1, cols: 1 };
  const acts = Object.values(sprite.actions);
  const rows = Math.max(...acts.map((a) => (a.row || 0) + 1));
  const cols = Math.max(...acts.map((a) => a.count || 1));
  return { rows, cols };
}

// 给宠物创建 DOM 元素并挂到 stage
function mountPet(p) {
  const el = document.createElement("div");
  el.className = "pet";
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
  el.addEventListener("click", () => onClick(p));
  p.el = el;
  p.status = "active";
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
  p.status = "stored";
  persist();
  renderWarehouse();
  updateEmpty();
}

// 放出：从仓库重新挂到桌面
function releasePet(id) {
  const p = pets.find((x) => x.id === id);
  if (!p || p.status !== "stored") return;
  mountPet(p);
  persist();
  renderWarehouse();
  updateEmpty();
}

// 删除：彻底移除（两段式确认，在事件层处理）
function deletePet(id) {
  const p = pets.find((x) => x.id === id);
  if (!p) return;
  if (p.el) p.el.remove();
  pets = pets.filter((x) => x.id !== id);
  persist();
  renderWarehouse();
  updateEmpty();
}

let emptyTimer = null;
function updateEmpty() {
  const empty = document.getElementById("empty");
  const act = activePets();
  if (act.length) {
    clearTimeout(emptyTimer);
    empty.style.display = "none";
    return;
  }
  if (pets.length === 0) {
    empty.querySelector(".big").textContent = "🐾";
    empty.querySelector(".txt").textContent = "点左上角「上传宠物」添加第一只";
    empty.style.display = "flex";
    return;
  }
  empty.querySelector(".big").textContent = "🏠";
  empty.querySelector(".txt").textContent = "宠物都收回仓库啦，去面板放出来吧";
  empty.style.display = "flex";
  clearTimeout(emptyTimer);
  emptyTimer = setTimeout(() => {
    empty.style.display = "none";
  }, 3000);
}

function addPets(input) {
  const files = input.files;
  if (!files.length) return;
  [...files].forEach((f) => {
    const r = new FileReader();
    r.onload = (e) => {
      spawnPet({ name: f.name.replace(/\.[^.]+$/, ""), src: e.target.result, mode: "image" });
      persist();
      renderWarehouse();
      updateEmpty();
    };
    r.readAsDataURL(f);
  });
  input.value = "";
  document.getElementById("modePicker").style.display = "none";
}

// 2D 精灵：示例（内置）或自定义上传
function spawnSpritePet(profile) {
  spawnPet({
    name: profile.name,
    src: profile.sprite.src,
    mode: "sprite",
    sprite: profile.sprite,
  });
  persist();
  renderWarehouse();
  updateEmpty();
}

// 规范化用户自定义 config.json → 内部 sprite 配置 {src, frameW, frameH, actions}
// 约定：actions 的 key 建议用 idle/walk/eat/happy（引擎自动触发的四种），其余 key 先存着等状态机扩充
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

  readConfig.then((cfg) => {
    imgs.forEach((f) => {
      const r = new FileReader();
      r.onload = (e) => {
        const sprite = normalizeSpriteConfig(cfg, e.target.result);
        spawnSpritePet({ name: f.name.replace(/\.[^.]+$/, ""), sprite });
      };
      r.readAsDataURL(f);
    });
  });

  input.value = "";
  document.getElementById("modePicker").style.display = "none";
}

// ===== 点击互动 =====
function onClick(p) {
  const now = Date.now();
  pokeInteract();
  if (p.sprite) p.happyUntil = Date.now() + 1300; // sprite 宠物点一下播 happy 动作
  p.clicks = p.clicks.filter((t) => now - t < 800);
  p.clicks.push(now);
  const n = p.clicks.length;
  if (n >= 5) {
    // 彩蛋3.1：连点狂戳
    p.el.classList.remove("shake", "spin", "bounce");
    void p.el.offsetWidth;
    p.el.classList.add("shake");
    bubble(p, EGG.poke, false);
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

const TALK = {
  single: ["在呢~", "喵？", "想我啦？", "戳我干啥", "哼"],
  double: ["嘿嘿", "喜欢我呀", "转个圈~"],
  multi: ["好开心！", "你也好可爱", "转晕啦~"],
  crazy: ["别戳啦！痒！", "再戳生气了", "轻点呀~"],
};
function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

// 彩蛋文案
const EGG = {
  poke: "别戳我啦！去找黑鼠吧",
  neglect: "去群聊里吧，黑鼠找你",
};

let lastInteract = Date.now();
function pokeInteract() {
  lastInteract = Date.now();
}

function react(p, type) {
  p.el.classList.remove("shake", "spin", "bounce");
  void p.el.offsetWidth;
  let txt = "";
  if (type === "single") {
    p.el.classList.add("bounce");
    txt = pick(TALK.single);
  } else if (type === "double") {
    p.el.classList.add("spin");
    txt = pick(TALK.double);
  } else if (type === "multi") {
    p.el.classList.add("bounce");
    txt = pick(TALK.multi);
  } else {
    p.el.classList.add("shake");
    txt = pick(TALK.crazy);
  }
  bubble(p, txt, false);
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

// ===== sprite 帧动画：状态机 + 切帧 =====
// 根据宠物当前状态决定播放哪个动作
function spriteAnimFor(p) {
  const s = p.sprite;
  if (!s) return "idle";
  if (p.happyUntil && Date.now() < p.happyUntil) return "happy";
  if (p.state === "alert") return "happy";
  if (p.rest > 0) return "idle";
  if (Math.abs(p.vx) > 0.05 || Math.abs(p.vy) > 0.05) return "walk";
  return "idle";
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
  const x = -(idx * p.size);
  const y = -((act.row || 0) * p.size);
  p.bodyEl.style.backgroundPosition = x + "px " + y + "px";
}

// ===== 游走 loop =====
function loop() {
  const now = performance.now();
  activePets().forEach((p) => {
    if (p.state === "alert") {
      if (p.sprite) tickSprite(p, now);
      return;
    }
    if (p.rest > 0) {
      p.rest--;
      if (p.sprite) tickSprite(p, now);
      return;
    }
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 10) {
      p.x = 10;
      p.vx *= -1;
    }
    if (p.x > innerWidth - p.size - 10) {
      p.x = innerWidth - p.size - 10;
      p.vx *= -1;
    }
    if (p.y < 10) {
      p.y = 10;
      p.vy *= -1;
    }
    if (p.y > innerHeight - p.size - 10) {
      p.y = innerHeight - p.size - 10;
      p.vy *= -1;
    }
    if (Math.random() < 0.004) {
      p.vx = (Math.random() - 0.5) * 1.4;
      p.vy = (Math.random() - 0.5) * 1.4;
    }
    if (Math.random() < 0.003)
      p.rest = Math.floor(60 + Math.random() * 180);
    p.el.style.left = p.x + "px";
    p.el.style.top = p.y + "px";
    if (p.sprite) tickSprite(p, now);
  });
  requestAnimationFrame(loop);
}

// 把当前可交互区域（宠物/面板/展开按钮）的矩形上报给 Rust，用于动态切换穿透/捕获
let lastReport = 0;
function reportHotspots() {
  const now = Date.now();
  if (now - lastReport < 120) return;
  lastReport = now;
  const hs = [];
  activePets().forEach((p) => {
    const r = p.el.getBoundingClientRect();
    if (r.width && r.height)
      hs.push({ x: r.left - 10, y: r.top - 10, w: r.width + 20, h: r.height + 20 });
  });
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
  // 仅 macOS 开启"默认全窗穿透 + 全局钩子动态切换"；
  // Windows/Linux 没有对应的全局鼠标钩子，若开启穿透将永远点不到宠物，
  // 因此保持窗口默认可交互（透明空白区会挡住桌面点击，属已知取舍）
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  if (isMac) {
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
    saved.forEach((p) => spawnPet(p, p.status));
  }
  renderWarehouse();
  updateEmpty();

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

  loop();
  setInterval(() => {
    const act = activePets();
    if (act.length && Date.now() - lastInteract > 5 * 60000) {
      const p = act[Math.floor(Math.random() * act.length)];
      bubble(p, EGG.neglect, false);
      lastInteract = Date.now();
    }
  }, 30000);
  setInterval(reportHotspots, 120);
  setInterval(checkAlerts, 10000);
}

init();
