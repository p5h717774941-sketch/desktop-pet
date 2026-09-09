import cover from "./assets/momo-cover.png";
import idleSitSheetUrl from "./assets/momo-idle-sit.png";
import walkRightSheetUrl from "./assets/momo-walk-right.png";
import lookAroundSheetUrl from "./assets/momo-lookaround.png";
import stretchSheetUrl from "./assets/momo-stretch.png";
import yawnSheetUrl from "./assets/momo-yawn.png";
import sleepSheetUrl from "./assets/momo-sleep.png";
import groomSheetUrl from "./assets/momo-groom.png";
import eatSheetUrl from "./assets/momo-eat.png";
import workingSheetUrl from "./assets/momo-working.png";
import idleSheetUrl from "./assets/momo-idle.png";
import waveSheetUrl from "./assets/momo-wave.png";
import jumpSheetUrl from "./assets/momo-jump.png";
import failedSheetUrl from "./assets/momo-failed.png";
import waitingSheetUrl from "./assets/momo-waiting.png";
import happySheetUrl from "./assets/momo-happy.png";
import reviewSheetUrl from "./assets/momo-review.png";

const grid = { cols: 6, rows: 4 };

export function createMomoProfile() {
  const sprite = {
    presetId: "momo-v1",
    src: `${idleSitSheetUrl}?sprite=1`,
    cover,
    frameW: 320,
    frameH: 320,
    grid,
    defaultIdle: "idleSit",
    actions: {
      idle: { src: `${idleSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      idleSit: { src: `${idleSitSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      lookAround: { src: `${lookAroundSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      stretch: { src: `${stretchSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      yawn: { src: `${yawnSheetUrl}?sprite=1&v=momo-yawn-blue-2`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      sleep: { src: `${sleepSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      groom: { src: `${groomSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      eat: { src: `${eatSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      wave: { src: `${waveSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      jump: { src: `${jumpSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      failed: { src: `${failedSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      waiting: { src: `${waitingSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      happy: { src: `${happySheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: false },
      review: { src: `${reviewSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      working: { src: `${workingSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      walkRight: { src: `${walkRightSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true },
      walkLeft: { src: `${walkRightSheetUrl}?sprite=1`, grid, row: 0, start: 0, count: 24, fps: 6, loop: true, flipX: true },
    },
  };
  return {
    name: "墨墨",
    hobby: "观察",
    personality: "安静又谨慎",
    src: sprite.src,
    mode: "sprite",
    sprite,
    cover,
    status: "stored",
  };
}
