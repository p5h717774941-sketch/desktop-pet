// 示例 sprite sheet：用代码生成一个粉色小史莱姆，4 动作 × 4 帧
// 纯 SVG 矢量，0 积分，不依赖外部资源
// 网格 4 列 × 4 行，每帧 128×128，总 512×512

const PINK = "#ff8fab";
const PINK_D = "#e5739b";
const EYE = "#2b2f38";
const STAR = "#ffd86b";

// 画一帧史莱姆：cx/cy 身体中心，rx/ry 椭圆半径，tilt 倾斜角，mouth 嘴形，extra 额外装饰
function slime(cx, cy, rx, ry, tilt, mouth, extra) {
  const body = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${PINK}"/><ellipse cx="${cx}" cy="${cy + ry * 0.5}" rx="${rx * 0.9}" ry="${ry * 0.45}" fill="${PINK_D}" opacity="0.45"/>`;
  const ex = rx * 0.36;
  const ey = cy - ry * 0.12;
  const eyes = `<circle cx="${cx - ex}" cy="${ey}" r="4.2" fill="${EYE}"/><circle cx="${cx + ex}" cy="${ey}" r="4.2" fill="${EYE}"/><circle cx="${cx - ex + 1.5}" cy="${ey - 1.6}" r="1.6" fill="#fff"/><circle cx="${cx + ex + 1.5}" cy="${ey - 1.6}" r="1.6" fill="#fff"/>`;
  let m = "";
  if (mouth === "smile") m = `<path d="M ${cx - 8} ${cy + 7} Q ${cx} ${cy + 15} ${cx + 8} ${cy + 7}" stroke="${EYE}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  else if (mouth === "open") m = `<ellipse cx="${cx}" cy="${cy + 10}" rx="6" ry="5" fill="${EYE}"/>`;
  else if (mouth === "big") m = `<ellipse cx="${cx}" cy="${cy + 12}" rx="9" ry="8" fill="${EYE}"/><ellipse cx="${cx}" cy="${cy + 14}" rx="6" ry="4" fill="#ff6f8f"/>`;
  else m = `<path d="M ${cx - 6} ${cy + 10} Q ${cx} ${cy + 8} ${cx + 6} ${cy + 10}" stroke="${EYE}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  return `<g transform="rotate(${tilt} ${cx} ${cy})">${body}${eyes}${m}${extra || ""}</g>`;
}

const flash = `<circle cx="34" cy="40" r="3" fill="${STAR}"/><circle cx="94" cy="48" r="2.5" fill="${STAR}"/><circle cx="86" cy="34" r="2" fill="${STAR}"/>`;

// 16 帧：行0 idle / 行1 walk / 行2 eat / 行3 happy
const frames = [
  // row 0 idle —— 呼吸（身体高低微变）
  slime(64, 76, 34, 30, 0, "smile"),
  slime(64, 74, 33, 32, 0, "smile"),
  slime(64, 78, 35, 28, 0, "smile"),
  slime(64, 74, 33, 32, 0, "smile"),
  // row 1 walk —— 左右晃动 + 压扁回弹
  slime(60, 78, 33, 28, -7, "smile"),
  slime(68, 74, 35, 32, 0, "smile"),
  slime(60, 78, 33, 28, 7, "smile"),
  slime(68, 74, 35, 32, 0, "smile"),
  // row 2 eat —— 张嘴闭嘴
  slime(64, 76, 34, 30, 0, "smile"),
  slime(64, 76, 34, 30, 0, "open"),
  slime(64, 76, 34, 30, 0, "big"),
  slime(64, 76, 34, 30, 0, "open"),
  // row 3 happy —— 弹跳 + 闪光
  slime(64, 82, 36, 26, 0, "big", ""),
  slime(64, 62, 33, 34, 0, "big", flash),
  slime(64, 52, 32, 36, 0, "big", flash),
  slime(64, 62, 33, 34, 0, "big", flash),
];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`;
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 4; c++) {
    svg += `<g transform="translate(${c * 128},${r * 128})">${frames[r * 4 + c]}</g>`;
  }
}
svg += `</svg>`;

const DEMO_SPRITE_SRC = "data:image/svg+xml;utf8," + encodeURIComponent(svg);

// sprite 配置：动作按行排，每行 4 帧
export const DEMO_SPRITE = {
  src: DEMO_SPRITE_SRC,
  frameW: 128,
  frameH: 128,
  actions: {
    idle: { row: 0, count: 4, fps: 6, loop: true },
    walk: { row: 1, count: 4, fps: 10, loop: true },
    eat: { row: 2, count: 4, fps: 8, loop: true },
    happy: { row: 3, count: 4, fps: 12, loop: true },
  },
};

// 2D 自定义上传时套用的默认配置（假设用户传的也是 4 行 × 4 列 128 网格）
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
