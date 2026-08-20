use tauri::Manager;
use std::sync::{Mutex, OnceLock};

// 热区：前端实时上报，坐标相对窗口 content 左上原点（与 getBoundingClientRect 对齐）
#[derive(Clone, Copy, Default)]
struct HotRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

struct HotState {
    hotspots: Vec<HotRect>,
    ignore: bool, // true = 穿透（忽略鼠标），false = 捕获（可交互）
}
static STATE: OnceLock<Mutex<HotState>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

// 启动时记录的屏幕信息（用于坐标转换）
static MONITOR_X: OnceLock<i32> = OnceLock::new();
static MONITOR_Y: OnceLock<i32> = OnceLock::new();
static SCALE: OnceLock<f64> = OnceLock::new();

// 前端调用：把当前可交互区域（宠物/面板/展开按钮）的矩形上报给 Rust
#[tauri::command]
fn set_hotspots(hotspots: Vec<serde_json::Value>) {
    let rects: Vec<HotRect> = hotspots
        .iter()
        .filter_map(|v| {
            let x = v.get("x")?.as_f64()?;
            let y = v.get("y")?.as_f64()?;
            let w = v.get("w")?.as_f64()?;
            let h = v.get("h")?.as_f64()?;
            Some(HotRect { x, y, w, h })
        })
        .collect();
    static LAST: OnceLock<Mutex<usize>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(usize::MAX));
    let mut lg = last.lock().unwrap();
    if *lg != rects.len() {
        *lg = rects.len();
        let mut log = format!("[pet] hotspots updated: count={}", rects.len());
        for (i, r) in rects.iter().take(5).enumerate() {
            log.push_str(&format!(
                " | #{}=({:.0},{:.0} {:.0}x{:.0})",
                i, r.x, r.y, r.w, r.h
            ));
        }
        eprintln!("{}", log);
    }
    if let Some(s) = STATE.get() {
        s.lock().unwrap().hotspots = rects;
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_graphics::event::{
        CallbackResult, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType,
    };
    use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};

    // 全局鼠标移动回调：判断鼠标是否落在某个热区，动态切换窗口穿透/捕获
    pub fn install() {
        let tap = match CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::Default,
            vec![CGEventType::MouseMoved],
            |_proxy, _etype, event| {
                // 先拷贝热区，避免持锁做耗时操作
                let (hotspots, current) = {
                    let st = STATE.get().unwrap().lock().unwrap();
                    (st.hotspots.clone(), st.ignore)
                };

                let loc = event.location();
                let mut target = current; // 默认不变
                if let Some(app) = APP.get() {
                    if let Some(win) = app.get_webview_window("main") {
                        if let Ok(pos) = win.outer_position() {
                            // outer_position 是物理像素；CGEvent.location 是逻辑点；
                            // 统一成逻辑点（与前端 getBoundingClientRect 一致）
                            let scale = SCALE.get().copied().unwrap_or(1.0);
                            let win_x = pos.x as f64 / scale;
                            let win_y = pos.y as f64 / scale;

                            let rel_x = loc.x - win_x;
                            let rel_y = loc.y - win_y;

                            let mut hit = false;
                            for r in &hotspots {
                                if rel_x >= r.x
                                    && rel_x <= r.x + r.w
                                    && rel_y >= r.y
                                    && rel_y <= r.y + r.h
                                {
                                    hit = true;
                                    break;
                                }
                            }
                            target = !hit;
                        }
                    }
                }

                // 命中热区 -> 需要捕获（可点击）；否则 -> 穿透
                if target != current {
                    if let Some(app) = APP.get() {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.set_ignore_cursor_events(target);
                            if let Some(s) = STATE.get() {
                                s.lock().unwrap().ignore = target;
                            }
                            eprintln!("[pet] ignore -> {}", target);
                        }
                    }
                }
                CallbackResult::Keep
            },
        ) {
            Ok(t) => t,
            Err(_) => {
                eprintln!(
                    "[pet] 创建鼠标钩子失败（可能需要在 系统设置→隐私与安全性→辅助功能 中为本程序授权）"
                );
                // 降级：钩子没了就无法动态切换，先把窗口恢复为可交互，
                // 避免窗口永远处于穿透状态导致宠物点不到
                if let Some(app) = APP.get() {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_ignore_cursor_events(false);
                    }
                }
                if let Some(s) = STATE.get() {
                    s.lock().unwrap().ignore = false;
                }
                return;
            }
        };
        let loop_source = tap
            .mach_port()
            .create_runloop_source(0)
            .expect("runloop source 创建失败");
        CFRunLoop::get_current().add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
        tap.enable();
        // 防止被 drop 导致钩子失效（进程存活期间一直需要）
        std::mem::forget(tap);
        std::mem::forget(loop_source);
        eprintln!("[pet] 鼠标钩子已安装：动态穿透/捕获切换就绪");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            STATE
                .set(Mutex::new(HotState {
                    hotspots: Vec::new(),
                    ignore: true,
                }))
                .ok();
            APP.set(app.handle().clone()).ok();

            #[cfg(target_os = "macos")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(Some(monitor)) = app.primary_monitor() {
                        let pos = *monitor.position();
                        let size = *monitor.size();
                        let _ = MONITOR_X.set(pos.x);
                        let _ = MONITOR_Y.set(pos.y);
                        let _ = SCALE.set(monitor.scale_factor() as f64);
                        let _ = win.set_size(size);
                        let _ = win.set_position(pos);
                        eprintln!(
                            "[pet] monitor pos=({},{}) size={}x{} scale={}",
                            pos.x, pos.y, size.width, size.height, monitor.scale_factor()
                        );
                    }
                }
                macos::install();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_hotspots])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
