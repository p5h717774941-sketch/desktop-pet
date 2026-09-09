import { invoke } from '@tauri-apps/api/core';

export function setupMattingComponent(onState) {
  const text = document.getElementById('aiComponentStatus');
  const install = document.getElementById('aiComponentInstall');
  const cancel = document.getElementById('aiComponentCancel');
  let ready = false, installing = false, refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const state = await invoke('ai_component_status');
      ready = state.ready;
      installing = state.installing;
      const p = state.progress || {};
      const labels = { connecting: '正在连接组件下载源…', extracting: '正在安装组件…', verifying: '正在校验模型…' };
      text.textContent = ready ? '本地 AI 组件已就绪 · 仅制作动作时运行'
        : installing ? p.stage === 'downloading'
          ? `正在下载 ${Math.round(p.received / 1024 / 1024)} / ${Math.round(p.total / 1024 / 1024)} MB`
          : labels[p.stage] || '正在准备组件…'
        : p.stage === 'error' ? p.error : '首次使用需下载模型和运行组件；无需安装 Python，之后可离线使用。';
    } catch (error) {
      ready = false;
      text.textContent = `组件暂不可用：${String(error)}`;
    } finally {
      refreshing = false;
      install.hidden = ready || installing;
      cancel.hidden = !installing;
      onState();
    }
  };
  install.addEventListener('click', async () => {
    if (installing) return;
    if (!confirm('下载本地 AI 动作制作组件？\n\n包含约 224MB 模型及运行环境，总下载量为数百 MB，请使用稳定网络。制作动作会暂时占用较多内存，视频不会上传。')) return;
    installing = true;
    install.hidden = true;
    cancel.hidden = false;
    text.textContent = '正在连接组件下载源…';
    onState();
    const timer = setInterval(refresh, 800);
    try { await invoke('ai_component_install'); }
    catch (error) { text.textContent = `下载未完成：${String(error)}`; }
    finally { clearInterval(timer); installing = false; await refresh(); }
  });
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    text.textContent = '正在取消，请等待当前网络请求结束…';
    try { await invoke('ai_component_cancel'); }
    finally { cancel.disabled = false; }
  });
  return { refresh, isReady: () => ready, isInstalling: () => installing };
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消处理', 'AbortError');
}

export async function buildLocalMatting(video, seek, preserveProps, onProgress, signal) {
  checkAbort(signal);
  const id = await invoke('ai_job_begin', { preserveProps });
  const cancel = () => { invoke('ai_job_cancel', { id }).catch(console.warn); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkAbort(signal);
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(video.videoWidth * scale));
    frame.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = frame.getContext('2d');
    for (let index = 0; index < 24; index += 1) {
      checkAbort(signal);
      // 与普通处理路径一致，避开开场空帧；seek() 会等待 WebView 真正提交该帧。
      await seek(video, video.duration * ((index + 1) / 25));
      checkAbort(signal);
      ctx.drawImage(video, 0, 0, frame.width, frame.height);
      await invoke('ai_job_frame', { id, index, dataBase64: frame.toDataURL('image/png').split(',')[1] });
      onProgress?.(index + 1, 24, 'extract');
    }
    checkAbort(signal);
    await invoke('ai_job_start', { id });
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      checkAbort(signal);
      const state = await invoke('ai_job_poll', { id });
      if (state.stage === 'error') throw new Error(state.error || 'AI 抠图失败');
      if (state.stage === 'done') {
        const image = new Image();
        image.src = `data:image/png;base64,${state.sheet}`;
        await image.decode();
        checkAbort(signal);
        if (image.width !== 1920 || image.height !== 1280) throw new Error('AI 组件返回了错误的动作尺寸');
        const sheet = document.createElement('canvas');
        sheet.width = image.width; sheet.height = image.height;
        sheet.getContext('2d').drawImage(image, 0, 0);
        return sheet;
      }
      onProgress?.(state.current || 0, 24, state.stage);
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    throw new Error('处理超时，请缩短视频或关闭其他大型软件后重试');
  } finally {
    signal?.removeEventListener('abort', cancel);
    await invoke('ai_job_cancel', { id }).catch(console.warn); // Also cleans successful job inputs/outputs.
  }
}
