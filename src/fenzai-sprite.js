import actionSheetUrl from "./assets/fenzai-actions.png";
import cover from "./assets/fenzai-cover.png";
import stretchSheetUrl from "./assets/fenzai-stretch.png";
import yawnSheetUrl from "./assets/fenzai-yawn.png";
import lookAroundSheetUrl from "./assets/fenzai-lookaround.png";
import sleepSheetUrl from "./assets/fenzai-sleep.png";
import eatSheetUrl from "./assets/fenzai-eat.png";
import waveSheetUrl from "./assets/fenzai-wave.png";
import jumpSheetUrl from "./assets/fenzai-jump.png";
import failedSheetUrl from "./assets/fenzai-failed.png";
import waitingSheetUrl from "./assets/fenzai-waiting.png";
import happySheetUrl from "./assets/fenzai-happy.png";
import reviewSheetUrl from "./assets/fenzai-review.png";
import workingSheetUrl from "./assets/fenzai-working.png";

const actions = {
  idle: { row: 0, start: 24, count: 24, fps: 6, loop: true },
  idleSit: { row: 0, start: 48, count: 24, fps: 6, loop: true },
  groom: { row: 0, start: 72, count: 24, fps: 7, loop: false },
  stretch: {
    src: `${stretchSheetUrl}?sprite=2`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 7,
    loop: false,
  },
  yawn: {
    src: `${yawnSheetUrl}?sprite=2`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 7,
    loop: false,
  },
  lookAround: {
    src: `${lookAroundSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: true,
  },
  sleep: {
    src: `${sleepSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: true,
  },
  eat: {
    src: `${eatSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  wave: {
    src: `${waveSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  jump: {
    src: `${jumpSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  failed: {
    src: `${failedSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  waiting: {
    src: `${waitingSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  happy: {
    src: `${happySheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: false,
  },
  review: {
    src: `${reviewSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: true,
  },
  working: {
    src: `${workingSheetUrl}?sprite=1`,
    grid: { cols: 6, rows: 4 },
    row: 0,
    start: 0,
    count: 24,
    fps: 6,
    loop: true,
  },
  walkRight: { row: 0, start: 0, count: 24, fps: 10, loop: true },
  walkLeft: { row: 0, start: 0, count: 24, fps: 10, loop: true, flipX: true },
};

// Bump this whenever the atlas gains rows so an already-open WebView never
// reuses a previous, shorter development asset from cache.
const actionSheet = `${actionSheetUrl}?sprite=6`;

export function createFenzaiProfile() {
  const sprite = {
    presetId: "fenzai-v1",
    src: actionSheet,
    cover,
    frameW: 320,
    frameH: 320,
    grid: { cols: 10, rows: 10 },
    defaultIdle: "idleSit",
    actions: JSON.parse(JSON.stringify(actions)),
  };
  return {
    name: "粉仔",
    hobby: "散步",
    personality: "安静又好奇",
    src: actionSheet,
    mode: "sprite",
    sprite,
    cover,
    status: "active",
  };
}
