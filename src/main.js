import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

// ===== 状态 =====
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

function petsData() {
  return pets.map((p) => ({ id: p.id, src: p.src, name: p.name }));
}

async function persist() {
  const payload = { settings, pets: petsData() };
  if (store) {
    try {
      await store.set("settings", settings);
      await store.set("pets", petsData());
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  try {
    localStorage.setItem("pet-backup", JSON.stringify(payload));
  } catch (e) {}
}

// ===== 面板交互 =====
function togglePanel() {
  document.getElementById("panel").classList.toggle("collapsed");
}

function applySettingsToUI() {
  renderReminders();
}

// 渲染用户自定义提醒列表
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

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ===== 宠物 =====
function spawnPet(src, name) {
  const el = document.createElement("div");
  el.className = "pet";
  const size = 90 + Math.random() * 40;
  el.innerHTML =
    '<img class="body" src="' +
    src +
    '" style="width:' +
    size +
    'px;height:auto;border-radius:14px">';
  document.getElementById("stage").appendChild(el);
  const p = {
    id: ++idc,
    el,
    src,
    name: name || "宠物" + idc,
    x: Math.random() * (innerWidth - 200) + 50,
    y: Math.random() * (innerHeight - 200) + 50,
    vx: (Math.random() - 0.5) * 1.2,
    vy: (Math.random() - 0.5) * 1.2,
    size,
    state: "wander",
    rest: 0,
    clicks: [],
    timer: null,
  };
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.addEventListener("click", () => onClick(p));
  pets.push(p);
  return p;
}

function addPets(input) {
  const files = input.files;
  if (!files.length) return;
  document.getElementById("empty").style.display = "none";
  [...files].forEach((f) => {
    const r = new FileReader();
    r.onload = (e) => {
      spawnPet(e.target.result, f.name.replace(/\.[^.]+$/, ""));
      persist();
    };
    r.readAsDataURL(f);
  });
  input.value = "";
}

// ===== 点击互动 =====
function onClick(p) {
  const now = Date.now();
  pokeInteract();
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

// ===== 游走 loop =====
function loop() {
  pets.forEach((p) => {
    if (p.state === "alert") return;
    if (p.rest > 0) {
      p.rest--;
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
  pets.forEach((p) => {
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
      // 每 N 分钟提醒：基于上次触发时间戳循环
      const gap = (parseInt(r.interval) || 1) * 60000;
      if (nowTs - (r.lastFired || 0) >= gap) {
        r.lastFired = nowTs;
        fireAlert(r.message || r.label || "提醒时间到", r.id);
        persist();
      }
      return;
    }
    // 时间节点提醒
    if (r.repeat === "weekday" && !isWeekday) return;
    if (r.time === t && !alertsDone[r.id + dayKey + t]) {
      alertsDone[r.id + dayKey + t] = 1;
      fireAlert(r.message || r.label || "提醒时间到", r.id);
    }
  });
}

function fireAlert(msg, kind) {
  if (!pets.length) return;
  const p = pets[0];
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
  // OS 级忽略鼠标事件：让透明窗下面的桌面图标/其他窗口可被点击（真穿透）
  try {
    await getCurrentWindow().setIgnoreCursorEvents(true);
  } catch (e) {
    console.warn("穿透不可用，可能缺少权限", e);
  }
  await initStore();
  applySettingsToUI();

  // 恢复宠物
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
    document.getElementById("empty").style.display = "none";
    saved.forEach((p) => spawnPet(p.src, p.name));
  }

  // 事件绑定
  document.getElementById("uploadBtn").addEventListener("click", () =>
    document.getElementById("file").click()
  );
  document.getElementById("collapseBtn").addEventListener("click", togglePanel);
  document.getElementById("toggleBtn").addEventListener("click", togglePanel);
  document.getElementById("file").addEventListener("change", (e) =>
    addPets(e.target)
  );

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

  // 提醒列表：事件委托（动态项）
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
  // 彩蛋3.2：超过5分钟没理宠物，主动冒泡（每30秒检测一次）
  setInterval(() => {
    if (pets.length && Date.now() - lastInteract > 5 * 60000) {
      const p = pets[Math.floor(Math.random() * pets.length)];
      bubble(p, EGG.neglect, false);
      lastInteract = Date.now(); // 重置，避免一直弹
    }
  }, 30000);
  setInterval(reportHotspots, 120);
  setInterval(checkAlerts, 10000);
}

init();
