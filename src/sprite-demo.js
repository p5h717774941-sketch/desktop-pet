// Pinkmo 内置示例宠物：代码生成的透明 SVG 粉色史莱姆。
// 不依赖外部图片或生成积分。网格 6 列 × 11 行，每帧 128×128。
const FRAME = 128;
const COLS = 6;
const PINK = "#ff8fab";
const PINK_D = "#e5739b";
const BLUSH = "#ff6f91";
const EYE = "#2b2f38";

function face(cx, cy, rx, ry, expression = "smile", gaze = 0) {
  const ex = rx * 0.36;
  const ey = cy - ry * 0.12;
  const pupil = (x) => `<circle cx="${x + gaze}" cy="${ey}" r="4.2" fill="${EYE}"/><circle cx="${x + gaze + 1.4}" cy="${ey - 1.5}" r="1.5" fill="#fff"/>`;
  let eyes = pupil(cx - ex) + pupil(cx + ex);
  let mouth = `<path d="M ${cx - 8} ${cy + 7} Q ${cx} ${cy + 15} ${cx + 8} ${cy + 7}" stroke="${EYE}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  if (expression === "blink") {
    eyes = `<path d="M ${cx - ex - 4} ${ey} Q ${cx - ex} ${ey + 3} ${cx - ex + 4} ${ey}" stroke="${EYE}" stroke-width="2.5" fill="none"/><path d="M ${cx + ex - 4} ${ey} Q ${cx + ex} ${ey + 3} ${cx + ex + 4} ${ey}" stroke="${EYE}" stroke-width="2.5" fill="none"/>`;
  } else if (expression === "open") {
    mouth = `<ellipse cx="${cx}" cy="${cy + 11}" rx="6" ry="6" fill="${EYE}"/>`;
  } else if (expression === "happy") {
    eyes = `<path d="M ${cx - ex - 5} ${ey + 2} Q ${cx - ex} ${ey - 4} ${cx - ex + 5} ${ey + 2}" stroke="${EYE}" stroke-width="2.8" fill="none"/><path d="M ${cx + ex - 5} ${ey + 2} Q ${cx + ex} ${ey - 4} ${cx + ex + 5} ${ey + 2}" stroke="${EYE}" stroke-width="2.8" fill="none"/>`;
    mouth = `<ellipse cx="${cx}" cy="${cy + 12}" rx="9" ry="7" fill="${EYE}"/><path d="M ${cx - 5} ${cy + 15} Q ${cx} ${cy + 11} ${cx + 5} ${cy + 15}" fill="${BLUSH}"/>`;
  } else if (expression === "sad") {
    mouth = `<path d="M ${cx - 7} ${cy + 14} Q ${cx} ${cy + 6} ${cx + 7} ${cy + 14}" stroke="${EYE}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  } else if (expression === "focus") {
    eyes = `<path d="M ${cx - ex - 5} ${ey - 4} L ${cx - ex + 4} ${ey - 1}" stroke="${EYE}" stroke-width="2.5"/><path d="M ${cx + ex + 5} ${ey - 4} L ${cx + ex - 4} ${ey - 1}" stroke="${EYE}" stroke-width="2.5"/>${pupil(cx - ex)}${pupil(cx + ex)}`;
    mouth = `<path d="M ${cx - 5} ${cy + 11} L ${cx + 5} ${cy + 11}" stroke="${EYE}" stroke-width="2.4" stroke-linecap="round"/>`;
  }
  return eyes + mouth;
}

function slime({ cx = 64, cy = 76, rx = 34, ry = 30, tilt = 0, expression = "smile", gaze = 0, extra = "" } = {}) {
  const body = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${PINK}"/><ellipse cx="${cx}" cy="${cy + ry * 0.5}" rx="${rx * 0.9}" ry="${ry * 0.45}" fill="${PINK_D}" opacity="0.45"/><ellipse cx="${cx - rx * 0.36}" cy="${cy + 7}" rx="5" ry="3" fill="${BLUSH}" opacity="0.45"/><ellipse cx="${cx + rx * 0.36}" cy="${cy + 7}" rx="5" ry="3" fill="${BLUSH}" opacity="0.45"/>`;
  return `<g transform="rotate(${tilt} ${cx} ${cy})">${body}${face(cx, cy, rx, ry, expression, gaze)}${extra}</g>`;
}

const arm = (side, lift) => {
  const x = side === "left" ? 36 : 92;
  const dir = side === "left" ? -1 : 1;
  return `<path d="M ${x} 70 Q ${x + dir * 13} ${62 - lift} ${x + dir * 8} ${48 - lift}" stroke="${PINK}" stroke-width="10" fill="none" stroke-linecap="round"/>`;
};
const tear = `<path d="M 86 72 Q 80 82 86 88 Q 92 82 86 72" fill="#72c7f4"/>`;
const frames = [];
const addRow = (...row) => frames.push(row);

addRow(
  slime(), slime({ cy: 74, rx: 33, ry: 32 }), slime({ cy: 75, expression: "blink" }),
  slime({ cy: 78, rx: 35, ry: 28 }), slime({ cy: 74, rx: 33, ry: 32 }), slime()
);
addRow(
  slime({ cx: 66, cy: 79, rx: 36, ry: 27, tilt: 7, gaze: 2 }), slime({ cx: 68, cy: 72, rx: 32, ry: 34, tilt: 4, gaze: 2 }),
  slime({ cx: 69, cy: 77, rx: 35, ry: 29, tilt: -3, gaze: 2 }), slime({ cx: 67, cy: 73, rx: 33, ry: 33, tilt: -6, gaze: 2 }),
  slime({ cx: 66, cy: 79, rx: 36, ry: 27, tilt: 5, gaze: 2 }), slime({ cx: 68, cy: 72, rx: 32, ry: 34, gaze: 2 })
);
addRow(
  slime({ cx: 62, cy: 79, rx: 36, ry: 27, tilt: -7, gaze: -2 }), slime({ cx: 60, cy: 72, rx: 32, ry: 34, tilt: -4, gaze: -2 }),
  slime({ cx: 59, cy: 77, rx: 35, ry: 29, tilt: 3, gaze: -2 }), slime({ cx: 61, cy: 73, rx: 33, ry: 33, tilt: 6, gaze: -2 }),
  slime({ cx: 62, cy: 79, rx: 36, ry: 27, tilt: -5, gaze: -2 }), slime({ cx: 60, cy: 72, rx: 32, ry: 34, gaze: -2 })
);
addRow(
  slime({ extra: arm("right", 0) }), slime({ tilt: -3, extra: arm("right", 8) }), slime({ tilt: 2, expression: "happy", extra: arm("right", 14) }),
  slime({ tilt: -2, expression: "happy", extra: arm("right", 7) }), slime({ tilt: 2, extra: arm("right", 13) }), slime({ extra: arm("right", 0) })
);
addRow(
  slime({ cy: 82, rx: 38, ry: 24 }), slime({ cy: 70, rx: 32, ry: 35, expression: "open" }), slime({ cy: 53, rx: 31, ry: 36, expression: "happy" }),
  slime({ cy: 48, rx: 31, ry: 36, expression: "happy" }), slime({ cy: 65, rx: 33, ry: 34, expression: "open" }), slime({ cy: 83, rx: 39, ry: 23 })
);
addRow(
  slime({ expression: "sad" }), slime({ cy: 78, rx: 35, ry: 28, expression: "sad" }), slime({ cy: 80, rx: 37, ry: 26, expression: "sad", extra: tear }),
  slime({ cy: 82, rx: 39, ry: 24, expression: "sad", extra: tear }), slime({ cy: 81, rx: 38, ry: 25, expression: "sad" }), slime({ cy: 79, rx: 36, ry: 27, expression: "sad" })
);
addRow(
  slime({ gaze: 2 }), slime({ cx: 67, tilt: 4, gaze: 2 }), slime({ cx: 68, tilt: 5, expression: "open", gaze: 2, extra: arm("right", 3) }),
  slime({ cx: 68, tilt: 3, gaze: 2, extra: arm("right", 7) }), slime({ cx: 66, expression: "blink", extra: arm("right", 2) }), slime()
);
addRow(
  slime({ cx: 61, rx: 33, ry: 31, expression: "focus", gaze: -2 }), slime({ cx: 63, cy: 74, expression: "focus", gaze: -1 }), slime({ cx: 65, rx: 35, ry: 29, expression: "focus" }),
  slime({ cx: 67, cy: 74, expression: "focus", gaze: 1 }), slime({ cx: 65, rx: 33, ry: 31, expression: "focus", gaze: 2 }), slime({ cx: 63, expression: "focus" })
);
addRow(
  slime({ tilt: -4, expression: "focus", gaze: -3 }), slime({ tilt: -3, expression: "focus", gaze: -2 }), slime({ tilt: -1, expression: "focus", gaze: -1 }),
  slime({ tilt: 1, expression: "focus", gaze: 1 }), slime({ tilt: 3, expression: "focus", gaze: 2 }), slime({ tilt: 4, expression: "blink", gaze: 3 })
);
addRow(
  slime({ cy: 82, rx: 37, ry: 25, expression: "happy" }), slime({ cy: 68, rx: 33, ry: 34, expression: "happy" }), slime({ cy: 55, rx: 32, ry: 36, expression: "happy" }),
  slime({ cy: 50, rx: 31, ry: 37, expression: "happy" }), slime({ cy: 64, rx: 33, ry: 34, expression: "happy" }), slime({ cy: 80, rx: 37, ry: 26, expression: "happy" })
);
addRow(
  slime(), slime({ expression: "open" }), slime({ cy: 77, rx: 35, ry: 29, expression: "open" }),
  slime({ cy: 78, rx: 36, ry: 28, expression: "happy" }), slime({ expression: "blink" }), slime()
);

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * FRAME}" height="${frames.length * FRAME}" viewBox="0 0 ${COLS * FRAME} ${frames.length * FRAME}">`;
frames.forEach((row, r) => row.forEach((frame, c) => {
  svg += `<g transform="translate(${c * FRAME},${r * FRAME})">${frame}</g>`;
}));
svg += "</svg>";

const DEMO_SPRITE_SRC = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#fff0f4"/>${slime({ cy: 72, rx: 39, ry: 34, expression: "happy" })}</svg>`;
export const DEMO_COVER_SRC = "data:image/svg+xml;utf8," + encodeURIComponent(coverSvg);

export const DEMO_SPRITE = {
  presetId: "pinkmo-slime-v2",
  src: DEMO_SPRITE_SRC,
  cover: DEMO_COVER_SRC,
  frameW: FRAME,
  frameH: FRAME,
  actions: {
    idle: { row: 0, count: 6, fps: 5, loop: true },
    walkRight: { row: 1, count: 6, fps: 10, loop: true },
    walkLeft: { row: 2, count: 6, fps: 10, loop: true },
    wave: { row: 3, count: 6, fps: 8, loop: false },
    jump: { row: 4, count: 6, fps: 10, loop: false },
    failed: { row: 5, count: 6, fps: 6, loop: false },
    waiting: { row: 6, count: 6, fps: 6, loop: true },
    working: { row: 7, count: 6, fps: 9, loop: true },
    review: { row: 8, count: 6, fps: 5, loop: true },
    happy: { row: 9, count: 6, fps: 11, loop: false },
    eat: { row: 10, count: 6, fps: 7, loop: false },
  },
};

// 旧自定义素材继续使用宽松的 4×4 默认协议。
export const SPRITE_PRESET = {
  frameW: 128,
  frameH: 128,
  actions: {
    idle: { row: 0, count: 4, fps: 6, loop: true },
    walk: { row: 1, count: 4, fps: 10, loop: true },
    eat: { row: 2, count: 4, fps: 8, loop: true },
    happy: { row: 3, count: 4, fps: 12, loop: true },
  },
};
