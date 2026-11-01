const RUN_KEY = 'pdd_material_run_v1';
const HISTORY_KEY = 'pdd_material_history_v1';
const SETTINGS_KEY = 'pdd_material_settings_v1';
const TIMEOUT_ALARM = 'pdd_material_task_timeout';
let processing = false;
const manualBlobUrls = new Map();

const defaults = { mainImages: true, skuImages: true, detailImages: true, skuText: true, videos: true, skuCsv: true, skipHistory: true, taskIntervalSec: 8, skuIntervalMs: 800 };
const getStored = (key, fallback) => chrome.storage.local.get(key).then((data) => data[key] ?? fallback);
const setStored = (key, value) => chrome.storage.local.set({ [key]: value });
const now = () => new Date().toISOString();
function addLog(run, text, type = 'info') { run.logs = [...(run.logs || []), { time: now(), text, type }].slice(-400); }
function counts(tasks = []) { return { total: tasks.length, waiting: tasks.filter((t) => t.status === 'waiting').length, downloading: tasks.filter((t) => ['opening', 'detecting', 'packaging', 'downloading'].includes(t.status)).length, completed: tasks.filter((t) => t.status === 'completed').length, failed: tasks.filter((t) => t.status === 'failed').length }; }
async function broadcast(run) { run.stats = counts(run.tasks); await setStored(RUN_KEY, run); chrome.runtime.sendMessage({ type: 'PDD_RUN_UPDATED', run }).catch(() => {}); }
function normalizeUrl(value) { try { const url = new URL(value); url.hash = ''; return url.toString(); } catch { return value; } }
async function currentTask(run) { return run.tasks?.[run.currentIndex] || null; }
function nextDelay(run) { return Math.max(2, Math.min(120, Number(run?.options?.taskIntervalSec) || 8)) * 1000; }

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen/offscreen.html');
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length) return;
  await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['BLOBS'], justification: '下载商品图片并生成本地ZIP压缩包' });
}

async function downloadBlob(blobUrl, filename) {
  return chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
}

function skuRows(run) {
  const rows = [['商品ID', '商品标题', '商品链接', '属性1', '属性值1', '属性2', '属性值2', 'SKU名称', 'SKU价格', 'SKU图片文件名']];
  for (const task of run.tasks.filter((item) => item.result?.skus?.length)) {
    task.result.skus.forEach((sku, index) => rows.push([
      task.goodsId, task.pageTitle || task.customTitle || '', task.url,
      sku.attributes?.[0]?.key || '', sku.attributes?.[0]?.value || '', sku.attributes?.[1]?.key || '', sku.attributes?.[1]?.value || '',
      sku.attributes?.map((item) => item.value).join(' ') || sku.text, sku.price || '',
      sku.imageUrl ? `${task.goodsId}_SKU${String(index + 1).padStart(2, '0')}_${(sku.attributes?.map((item) => item.value).join('_') || sku.text).replace(/[\\/:*?"<>|\s]/g, '')}.jpg` : ''
    ]));
  }
  return rows;
}

async function finishRun(run) {
  run.status = 'completed'; run.currentTaskId = '';
  addLog(run, `全部任务完成：成功 ${counts(run.tasks).completed}，失败 ${counts(run.tasks).failed}`, 'success');
  await chrome.alarms.clear(TIMEOUT_ALARM); await broadcast(run);
  if (run.options.skuCsv && skuRows(run).length > 1) {
    try {
      await ensureOffscreen();
      const built = await chrome.runtime.sendMessage({ type: 'PDD_BUILD_CSV', rows: skuRows(run), filename: 'SKU汇总.csv' });
      if (built?.ok) {
        const downloadId = await downloadBlob(built.blobUrl, built.filename);
        run.summaryDownloadId = downloadId; run.summaryBlobUrl = built.blobUrl; addLog(run, '已生成 SKU汇总.csv', 'success'); await broadcast(run);
      }
    } catch (error) { addLog(run, `SKU汇总生成失败：${error.message}`, 'error'); await broadcast(run); }
  }
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: '素材打包任务完成', message: `成功 ${counts(run.tasks).completed}，失败 ${counts(run.tasks).failed}` });
}

async function openCurrentTask() {
  if (processing) return; processing = true;
  try {
    const run = await getStored(RUN_KEY, null); if (!run || run.status !== 'running') return;
    while (run.currentIndex < run.tasks.length && ['completed', 'failed', 'skipped'].includes(run.tasks[run.currentIndex].status)) run.currentIndex++;
    if (run.currentIndex >= run.tasks.length) return finishRun(run);
    const task = run.tasks[run.currentIndex]; task.status = 'opening'; task.error = ''; run.currentTaskId = task.id;
    addLog(run, `正在打开 ${String(task.index).padStart(3, '0')}：${task.goodsId || '待识别商品ID'}`); await broadcast(run);
    let tab;
    if (Number.isInteger(run.runnerTabId)) { try { tab = await chrome.tabs.update(run.runnerTabId, { url: task.url, active: false }); } catch {} }
    if (!tab) tab = await chrome.tabs.create({ url: task.url, active: false });
    run.runnerTabId = tab.id; await broadcast(run); chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: 1.5 });
  } finally { processing = false; }
}

async function failCurrent(reason) {
  const run = await getStored(RUN_KEY, null); if (!run || !['running', 'paused'].includes(run.status)) return;
  const task = await currentTask(run); if (!task || ['completed', 'failed'].includes(task.status)) return;
  task.status = 'failed'; task.error = reason || '未知错误'; task.completedAt = now(); addLog(run, `${String(task.index).padStart(3, '0')} 失败：${task.error}`, 'error');
  run.currentIndex++; run.activeDownloadId = null; await broadcast(run); if (run.status === 'running') { addLog(run, `等待 ${nextDelay(run) / 1000} 秒后处理下一个商品`); await broadcast(run); setTimeout(openCurrentTask, nextDelay(run)); }
}

async function handleMaterial(payload, sender) {
  const run = await getStored(RUN_KEY, null); if (!run || run.status !== 'running' || sender.tab?.id !== run.runnerTabId) return;
  const task = await currentTask(run); if (!task || ['packaging', 'downloading'].includes(task.status)) return;
  task.goodsId = payload.goodsId || task.goodsId; task.pageTitle = payload.pageTitle || task.pageTitle; task.result = payload; task.status = 'packaging';
  task.materialCounts = payload.counts || {}; task.warnings = payload.warnings || [];
  addLog(run, `解析数量：主图 ${task.materialCounts.mainImages || 0}，SKU图 ${task.materialCounts.skuImages || 0}，详情图 ${task.materialCounts.detailImages || 0}，SKU文字 ${task.materialCounts.skuText || 0}，视频 ${task.materialCounts.videos || 0}`);
  for (const warning of task.warnings) addLog(run, warning, 'error');
  addLog(run, `开始打包：${task.goodsId}.zip`); await broadcast(run);
  try {
    await ensureOffscreen();
    const built = await chrome.runtime.sendMessage({ type: 'PDD_BUILD_PACKAGE', payload, options: run.options });
    if (!built?.ok) throw new Error(built?.error || '压缩包生成失败');
    const downloadId = await downloadBlob(built.blobUrl, built.filename);
    task.filename = built.filename; task.fileCount = built.fileCount; task.downloadId = downloadId; task.status = 'downloading';
    run.activeDownloadId = downloadId; run.activeBlobUrl = built.blobUrl; addLog(run, `压缩包包含 ${built.fileCount} 个文件`); await broadcast(run);
    chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: 10 });
  } catch (error) { await failCurrent(error.message); }
}

async function pauseForVerification(reason = '拼多多要求人工验证') {
  const run = await getStored(RUN_KEY, null); if (!run || run.status !== 'running') return;
  const task = await currentTask(run); if (!task) return;
  task.status = 'verification'; task.error = reason; run.status = 'paused';
  addLog(run, `${String(task.index).padStart(3, '0')} 检测到验证，任务已自动暂停`, 'error');
  await chrome.alarms.clear(TIMEOUT_ALARM); await broadcast(run);
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: '需要人工验证', message: '请在拼多多任务页面完成验证，然后点击“继续”。' });
}

async function manualDownload(blobUrl, filename) {
  const downloadId = await downloadBlob(blobUrl, filename); manualBlobUrls.set(downloadId, blobUrl); return downloadId;
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard/dashboard.html'); const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url);
  existing ? chrome.tabs.update(existing.id, { active: true }) : chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || ['PDD_BUILD_PACKAGE', 'PDD_BUILD_CSV', 'PDD_REVOKE_URL'].includes(message.type)) return false;
  (async () => {
    if (message.type === 'PDD_GET_RUN') return { ok: true, run: await getStored(RUN_KEY, null), history: await getStored(HISTORY_KEY, []), settings: await getStored(SETTINGS_KEY, defaults) };
    if (message.type === 'PDD_SAVE_SETTINGS') { await setStored(SETTINGS_KEY, { ...defaults, ...message.settings }); return { ok: true }; }
    if (message.type === 'PDD_IMPORT_TASKS') {
      const history = await getStored(HISTORY_KEY, []); const options = { ...defaults, ...await getStored(SETTINGS_KEY, defaults) };
      const done = new Set(history.filter((item) => item.status === 'completed').map((item) => normalizeUrl(item.url)));
      const tasks = message.tasks.map((task) => ({ ...task, status: options.skipHistory && done.has(normalizeUrl(task.url)) ? 'skipped' : 'waiting' }));
      const run = { id: crypto.randomUUID(), sourceName: message.sourceName || '', status: 'ready', currentIndex: 0, currentTaskId: '', runnerTabId: null, activeDownloadId: null, tasks, options, logs: [] };
      addLog(run, `已导入 ${tasks.length} 条唯一商品链接`); await broadcast(run); return { ok: true, run };
    }
    if (message.type === 'PDD_START') { const run = await getStored(RUN_KEY, null); if (!run?.tasks?.length) return { ok: false, error: '请先导入任务文件' }; run.options = { ...defaults, ...await getStored(SETTINGS_KEY, defaults) }; if (!run.options.mainImages && !run.options.skuImages && !run.options.detailImages && !run.options.skuText && !run.options.videos) return { ok: false, error: '请至少勾选一项下载内容' }; run.status = 'running'; addLog(run, '任务开始'); await broadcast(run); setTimeout(openCurrentTask, 0); return { ok: true }; }
    if (message.type === 'PDD_PAUSE') { const run = await getStored(RUN_KEY, null); if (run) { run.status = 'paused'; addLog(run, '任务已暂停'); await broadcast(run); } return { ok: true }; }
    if (message.type === 'PDD_RESUME') { const run = await getStored(RUN_KEY, null); if (run) { run.status = 'running'; addLog(run, '任务继续'); await broadcast(run); if (run.tasks[run.currentIndex]?.status !== 'downloading') setTimeout(openCurrentTask, 0); } return { ok: true }; }
    if (message.type === 'PDD_STOP') { const run = await getStored(RUN_KEY, null); if (run) { run.status = 'stopped'; addLog(run, '任务已停止'); await broadcast(run); } await chrome.alarms.clear(TIMEOUT_ALARM); return { ok: true }; }
    if (message.type === 'PDD_RETRY_FAILED') {
      const run = await getStored(RUN_KEY, null); if (!run) return { ok: false, error: '当前没有任务' };
      let changed = 0; for (const task of run.tasks) if (['failed', 'skipped', 'verification'].includes(task.status)) { task.status = 'waiting'; task.error = ''; changed++; }
      if (!changed) return { ok: false, error: '当前没有失败、跳过或待验证任务' };
      run.currentIndex = Math.max(0, run.tasks.findIndex((task) => task.status === 'waiting')); run.status = 'ready'; addLog(run, `已将 ${changed} 条任务重新加入队列`); await broadcast(run); return { ok: true, run };
    }
    if (message.type === 'PDD_REPACKAGE_TASK') {
      const run = await getStored(RUN_KEY, null); const task = run?.tasks?.find((item) => item.id === message.taskId);
      if (!task?.result) return { ok: false, error: '该记录还没有可用的解析结果' };
      await ensureOffscreen(); const options = { ...defaults, ...await getStored(SETTINGS_KEY, defaults) };
      const built = await chrome.runtime.sendMessage({ type: 'PDD_BUILD_PACKAGE', payload: task.result, options });
      if (!built?.ok) return { ok: false, error: built?.error || '重新打包失败' };
      await manualDownload(built.blobUrl, built.filename); addLog(run, `手动重新打包：${built.filename}`, 'success'); await broadcast(run); return { ok: true };
    }
    if (message.type === 'PDD_REPARSE_TASK') {
      const run = await getStored(RUN_KEY, null); if (!run) return { ok: false, error: '当前没有任务' };
      if (run.status === 'running') return { ok: false, error: '请先暂停当前批次再重新解析' };
      const index = run.tasks.findIndex((item) => item.id === message.taskId); if (index < 0) return { ok: false, error: '没有找到该任务' };
      const task = run.tasks[index]; task.status = 'waiting'; task.error = ''; task.result = null; task.materialCounts = null; task.warnings = []; task.fileCount = 0;
      run.currentIndex = index; run.status = 'ready'; addLog(run, `${String(task.index).padStart(3, '0')} 已设置为重新解析`); await broadcast(run); return { ok: true, run };
    }
    if (message.type === 'PDD_EXPORT_SKU_CSV') {
      const run = await getStored(RUN_KEY, null); const rows = run ? skuRows(run) : [];
      if (rows.length <= 1) return { ok: false, error: '当前没有已解析的SKU记录' };
      await ensureOffscreen(); const built = await chrome.runtime.sendMessage({ type: 'PDD_BUILD_CSV', rows, filename: 'SKU汇总_当前记录.csv' });
      if (!built?.ok) return { ok: false, error: built?.error || '汇总生成失败' };
      await manualDownload(built.blobUrl, built.filename); return { ok: true };
    }
    if (message.type === 'PDD_CLEAR') { await chrome.alarms.clear(TIMEOUT_ALARM); await chrome.storage.local.remove([RUN_KEY, HISTORY_KEY]); return { ok: true }; }
    if (message.type === 'PDD_RUNNER_READY') { const run = await getStored(RUN_KEY, null); if (run?.status === 'running' && sender.tab?.id === run.runnerTabId) { const task = await currentTask(run); if (task) { task.status = 'detecting'; addLog(run, '页面已加载，正在解析所选素材'); await broadcast(run); chrome.tabs.sendMessage(sender.tab.id, { type: 'PDD_COLLECT_MATERIAL', options: run.options }); } } return { ok: true }; }
    if (message.type === 'PDD_MATERIAL_READY') { await handleMaterial(message.payload || {}, sender); return { ok: true }; }
    if (message.type === 'PDD_MATERIAL_FAILED') { await failCurrent(message.error); return { ok: true }; }
    if (message.type === 'PDD_VERIFICATION_REQUIRED') { await pauseForVerification(message.error); return { ok: true }; }
    return { ok: false };
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state && !delta.error) return;
  if (manualBlobUrls.has(delta.id) && (delta.state?.current === 'complete' || delta.state?.current === 'interrupted' || delta.error)) {
    const url = manualBlobUrls.get(delta.id); manualBlobUrls.delete(delta.id); chrome.runtime.sendMessage({ type: 'PDD_REVOKE_URL', url }).catch(() => {}); return;
  }
  const run = await getStored(RUN_KEY, null); if (!run) return;
  if (delta.id === run.summaryDownloadId && (delta.state?.current === 'complete' || delta.state?.current === 'interrupted')) {
    if (run.summaryBlobUrl) chrome.runtime.sendMessage({ type: 'PDD_REVOKE_URL', url: run.summaryBlobUrl }).catch(() => {});
    run.summaryBlobUrl = ''; await broadcast(run); return;
  }
  if (delta.id !== run.activeDownloadId) return;
  const task = await currentTask(run); if (!task) return;
  if (delta.state?.current === 'complete') {
    task.status = 'completed'; task.completedAt = now(); run.activeDownloadId = null;
    if (run.activeBlobUrl) chrome.runtime.sendMessage({ type: 'PDD_REVOKE_URL', url: run.activeBlobUrl }).catch(() => {}); run.activeBlobUrl = '';
    addLog(run, `下载完成：${task.filename}`, 'success');
    const history = await getStored(HISTORY_KEY, []); history.push({ goodsId: task.goodsId, url: task.url, filename: task.filename, status: 'completed', completedAt: task.completedAt }); await setStored(HISTORY_KEY, history.slice(-5000));
    run.currentIndex++; await broadcast(run); if (run.status === 'running') { addLog(run, `等待 ${nextDelay(run) / 1000} 秒后处理下一个商品`); await broadcast(run); setTimeout(openCurrentTask, nextDelay(run)); }
  } else if (delta.state?.current === 'interrupted' || delta.error) await failCurrent(delta.error?.current || '下载被中断');
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === TIMEOUT_ALARM) failCurrent('任务执行超时'); });
chrome.tabs.onRemoved.addListener(async (tabId) => { const run = await getStored(RUN_KEY, null); if (run?.runnerTabId === tabId && run.status === 'running') failCurrent('任务页面被关闭'); });
