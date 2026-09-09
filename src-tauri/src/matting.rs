//! Optional, versioned AI component. Only the panel may operate it.
//! Model and interpreter are NOT bundled with the main app.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

const MODEL_SHA: &str = "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333";
// A separate, immutable component release; publishing is a maintainer action.
const RELEASE: &str = "https://github.com/p5h717774941-sketch/desktop-pet/releases/download/ai-matting-v1";
static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCEL_INSTALL: AtomicBool = AtomicBool::new(false);
static INSTALL_PROGRESS: OnceLock<Mutex<Value>> = OnceLock::new();
static JOB: OnceLock<Mutex<Option<Job>>> = OnceLock::new();

struct Job { id: String, dir: PathBuf, child: Option<Child>, frames: [bool; 24], preserve_props: bool }
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child { let _ = child.kill(); let _ = child.wait(); }
        // Only this process-created, exact job directory is removed.
        let _ = fs::remove_dir_all(&self.dir);
    }
}
struct InstallGuard;
impl Drop for InstallGuard { fn drop(&mut self) { INSTALLING.store(false, Ordering::SeqCst); } }
fn panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主控面板可使用动作制作组件".into()); } Ok(())
}
fn platform() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        _ => Err("当前平台暂未提供 AI 组件".into()),
    }
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("components").join("matting-v1"))
}
fn exe(dir: &Path) -> PathBuf { dir.join(if cfg!(windows) { "pinkmo-matting.exe" } else { "pinkmo-matting" }) }
fn progress(value: Value) { *INSTALL_PROGRESS.get_or_init(|| Mutex::new(json!({"stage":"idle"}))).lock().unwrap() = value; }
fn cancelled() -> Result<(), String> {
    if CANCEL_INSTALL.load(Ordering::SeqCst) { Err("已取消下载".into()) } else { Ok(()) }
}
fn sha(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop { let count = input.read(&mut buf).map_err(|e| e.to_string())?; if count == 0 { break; } digest.update(&buf[..count]); }
    Ok(format!("{:x}", digest.finalize()))
}
fn ready(dir: &Path) -> bool {
    exe(dir).is_file() && dir.join("model.onnx").is_file() && dir.join("verified.json").is_file()
}

async fn download_archive(url: String, path: &Path, expected: u64) -> Result<(), String> {
    let client = reqwest::Client::builder().https_only(true).connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(3600)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut received = 0u64;
    loop {
        cancelled()?;
        let next = tokio::time::timeout(Duration::from_secs(30), response.chunk());
        tokio::pin!(next);
        let chunk = loop {
            tokio::select! {
                result = &mut next => break result.map_err(|_| "下载连接超时，请重试")?.map_err(|e| e.to_string())?,
                _ = tokio::time::sleep(Duration::from_millis(250)) => cancelled()?,
            }
        };
        let Some(chunk) = chunk else { break; };
        received += chunk.len() as u64;
        if received > expected { return Err("组件下载大小异常".into()); }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        progress(json!({"stage":"downloading","received":received,"total":expected}));
    }
    if received != expected { return Err("组件下载不完整，请重试".into()); }
    Ok(())
}

#[tauri::command]
pub fn ai_component_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    panel(&window)?;
    let state = INSTALL_PROGRESS.get_or_init(|| Mutex::new(json!({"stage":"idle"}))).lock().unwrap().clone();
    Ok(json!({"ready":ready(&root(&app)?),"platform":platform()?,"installing":INSTALLING.load(Ordering::SeqCst),"progress":state}))
}

fn extract_archive(archive: &Path, staging: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > 30000 { return Err("组件文件数异常".into()); }
    let mut size = 0u64;
    for index in 0..zip.len() {
        cancelled()?;
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("组件包含不安全的路径")?.to_owned();
        if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err("组件路径不合法".into());
        }
        if entry.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) { return Err("组件不允许符号链接".into()); }
        size = size.checked_add(entry.size()).ok_or("组件过大")?;
        if size > 2_500_000_000 { return Err("组件解压大小超出限制".into()); }
        let output = staging.join(relative);
        if entry.is_dir() { fs::create_dir_all(&output).map_err(|e| e.to_string())?; continue; }
        fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&output).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(if entry.unix_mode().unwrap_or(0) & 0o111 != 0 { 0o755 } else { 0o644 })).map_err(|e| e.to_string())?;
        }
    }
    let meta: Value = serde_json::from_slice(&fs::read(staging.join("component.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if meta["protocol"] != 1 || meta["platform"] != platform()? || meta["modelSha256"] != MODEL_SHA || !exe(staging).is_file() {
        return Err("组件平台或版本不匹配".into());
    }
    progress(json!({"stage":"verifying"}));
    if sha(&staging.join("model.onnx"))? != MODEL_SHA { return Err("模型校验失败，请重新下载".into()); }
    fs::write(staging.join("verified.json"), meta.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let target = root(app)?;
    if ready(&target) { return Ok(()); }
    let parent = target.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let staging = parent.join(format!("matting-install-{nonce}"));
    let archive = parent.join(format!("matting-download-{nonce}.zip"));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let client = reqwest::blocking::Client::builder().https_only(true).connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(3600)).build().map_err(|e| e.to_string())?;
        let stem = format!("pinkmo-matting-v1-{}", platform()?);
        progress(json!({"stage":"connecting"}));
        let response = client.get(format!("{RELEASE}/{stem}.json")).timeout(Duration::from_secs(30)).send().map_err(|e| format!("无法连接组件下载源：{e}"))?;
        if response.status().as_u16() == 404 { return Err("此平台的组件尚未发布，请等待新版组件发布后重试".into()); }
        let manifest: Value = response.error_for_status().map_err(|e| e.to_string())?.json().map_err(|e| e.to_string())?;
        let expected = manifest["size"].as_u64().filter(|v| *v > 0 && *v < 1_500_000_000).ok_or("组件大小不合法")?;
        let checksum = manifest["sha256"].as_str().filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or("组件校验信息不完整")?;
        if manifest["protocol"] != 1 || manifest["platform"] != platform()? || manifest["filename"] != format!("{stem}.zip") { return Err("组件清单不匹配".into()); }
        tauri::async_runtime::block_on(download_archive(format!("{RELEASE}/{stem}.zip"), &archive, expected))?;
        if sha(&archive)? != checksum { return Err("组件下载校验失败，请重试".into()); }
        progress(json!({"stage":"extracting"}));
        extract_archive(&archive, &staging)?;
        cancelled()?;
        if target.exists() { return Err("组件目录已存在但不完整，请联系维护者检查".into()); }
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_dir_all(&staging);
    result
}

#[tauri::command]
pub async fn ai_component_install(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    panel(&window)?;
    if INSTALLING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("组件正在下载".into()); }
    CANCEL_INSTALL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = InstallGuard;
        let result = install(&app);
        progress(match &result { Ok(_) => json!({"stage":"ready"}), Err(error) => json!({"stage":"error","error":error}) });
        result
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ai_component_cancel(window: tauri::WebviewWindow) -> Result<(), String> {
    panel(&window)?; CANCEL_INSTALL.store(true, Ordering::SeqCst); Ok(())
}

#[tauri::command]
pub fn ai_job_begin(window: tauri::WebviewWindow, app: tauri::AppHandle, preserve_props: bool) -> Result<String, String> {
    panel(&window)?;
    let component = root(&app)?;
    if !ready(&component) { return Err("请先下载本地 AI 动作制作组件".into()); }
    let mut current = JOB.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if current.is_some() { return Err("已有动作正在处理，请先取消".into()); }
    let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos().to_string();
    let dir = component.join("jobs").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    *current = Some(Job { id: id.clone(), dir, child: None, frames: [false; 24], preserve_props });
    Ok(id)
}

#[tauri::command]
pub async fn ai_job_frame(window: tauri::WebviewWindow, id: String, index: usize, data_base64: String) -> Result<(), String> {
    panel(&window)?;
    if index >= 24 || data_base64.len() > 8 * 1024 * 1024 { return Err("视频帧超出限制".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = JOB.get_or_init(|| Mutex::new(None)).lock().unwrap();
        let job = current.as_mut().filter(|j| j.id == id).ok_or("任务已取消")?;
        if job.child.is_some() { return Err("任务已开始处理".into()); }
        let bytes = STANDARD.decode(data_base64).map_err(|e| e.to_string())?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("无效的 PNG 帧".into()); }
        fs::write(job.dir.join(format!("frame-{index:02}.png")), bytes).map_err(|e| e.to_string())?;
        job.frames[index] = true;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn ai_job_start(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<(), String> {
    panel(&window)?;
    let mut current = JOB.get_or_init(|| Mutex::new(None)).lock().unwrap();
    let job = current.as_mut().filter(|j| j.id == id).ok_or("任务已取消")?;
    if job.child.is_some() || !job.frames.iter().all(|f| *f) { return Err("视频帧不完整或任务已经启动".into()); }
    let component = root(&app)?;
    let log = fs::File::create(job.dir.join("worker.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(exe(&component));
    command.arg("--job").arg(&job.dir).arg("--model").arg(component.join("model.onnx"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(log));
    if job.preserve_props { command.arg("--preserve-props"); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    job.child = Some(command.spawn().map_err(|e| format!("无法启动 AI 组件：{e}"))?);
    Ok(())
}

#[tauri::command]
pub fn ai_job_poll(window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    panel(&window)?;
    let mut current = JOB.get_or_init(|| Mutex::new(None)).lock().unwrap();
    let job = current.as_mut().filter(|j| j.id == id).ok_or("任务已取消")?;
    let state: Value = fs::read(job.dir.join("progress.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({"stage":"loading","current":0,"total":24}));
    if let Some(child) = &mut job.child {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            if !exit.success() { return Err(state["error"].as_str().unwrap_or("AI 组件异常退出，可能内存不足，请关闭其他大型软件后重试").into()); }
            if state["stage"] != "done" { return Err("AI 组件未生成完整动作".into()); }
            let sheet = fs::read(job.dir.join("sheet.png")).map_err(|e| e.to_string())?;
            if sheet.len() > 25 * 1024 * 1024 { return Err("生成的动作过大".into()); }
            return Ok(json!({"stage":"done","sheet":STANDARD.encode(sheet)}));
        }
    }
    // Worker may have written done just before process exit. Wait for exit before returning sheet.
    if state["stage"] == "done" { return Ok(json!({"stage":"composing","current":24,"total":24})); }
    Ok(state)
}

#[tauri::command]
pub fn ai_job_cancel(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    panel(&window)?;
    let mut current = JOB.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if current.as_ref().map(|j| j.id == id).unwrap_or(false) { current.take(); }
    Ok(())
}

pub fn shutdown() {
    CANCEL_INSTALL.store(true, Ordering::SeqCst);
    if let Some(job) = JOB.get() { job.lock().unwrap().take(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supported_platform_and_uninstalled_state() {
        assert!(platform().is_ok());
        assert!(!ready(Path::new("not-an-installed-component")));
    }
    #[test]
    fn archive_rejects_path_traversal() {
        let base = std::env::temp_dir().join(format!("pinkmo-zip-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&base).unwrap();
        let path = base.join("bad.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("../outside", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"unsafe").unwrap(); zip.finish().unwrap();
        assert!(extract_archive(&path, &base.join("output")).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    #[ignore = "requires a locally built component archive"]
    fn local_archive_install() {
        let archive = PathBuf::from(std::env::var("PINKMO_TEST_ARCHIVE").expect("archive path"));
        let output = PathBuf::from(std::env::var("PINKMO_TEST_INSTALL_DIR").expect("new temporary output path"));
        let manifest: Value = serde_json::from_slice(&fs::read(archive.with_extension("json")).unwrap()).unwrap();
        assert_eq!(manifest["sha256"], sha(&archive).unwrap());
        assert_eq!(manifest["size"], fs::metadata(&archive).unwrap().len());
        fs::create_dir(&output).unwrap();
        extract_archive(&archive, &output).unwrap();
        assert!(ready(&output));
        assert!(output.join("licenses/BiRefNet-LICENSE.txt").is_file());
    }
}
