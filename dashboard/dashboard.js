import { parseTaskRows, parseTaskText } from '../shared/task-parser.js';
import { parseXlsx } from '../shared/xlsx-parser.js';

const $ = (id) => document.getElementById(id);
let currentHistory = [];
const labels = { ready:'待开始', running:'运行中', paused:'已暂停', stopped:'已停止', completed:'已完成', waiting:'等待', skipped:'历史跳过', verification:'等待人工验证', opening:'打开页面', detecting:'解析素材', packaging:'生成压缩包', downloading:'下载中', failed:'失败' };
const optionIds = ['mainImages', 'skuImages', 'detailImages', 'skuText', 'videos', 'skuCsv', 'skipHistory'];
const numberDefaults = { taskIntervalSec: 8, skuIntervalMs: 800 };
function call(type, extra = {}) { return chrome.runtime.sendMessage({ type, ...extra }); }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }

function render(run) {
  $('runState').textContent = run ? (labels[run.status] || run.status) : '未导入';
  $('sourceName').textContent = run?.sourceName || '尚未选择文件';
  const stats = run?.stats || { total:0, waiting:0, downloading:0, completed:0, failed:0 };
  for (const key of ['total','waiting','downloading','completed','failed']) $(key).textContent = stats[key] || 0;
  const task = run?.tasks?.[run.currentIndex];
  $('currentTask').textContent = task ? `${String(task.index).padStart(3,'0')}　${task.customTitle || task.pageTitle || '待识别标题'}　商品ID：${task.goodsId || '待识别'}　${labels[task.status] || task.status}` : '暂无任务';
  $('taskCount').textContent = `${run?.tasks?.length || 0} 条`;
  $('taskRows').innerHTML = (run?.tasks || []).map((item) => { const c=item.materialCounts||{}; const countText=item.result?`主${c.mainImages||0} / SKU图${c.skuImages||0} / 详${c.detailImages||0} / SKU${c.skuText||0} / 视${c.videos||0}`:''; const issue=[item.error,...(item.warnings||[])].filter(Boolean).join('；'); return `<tr><td>${String(item.index).padStart(3,'0')}</td><td title="${escapeHtml(item.customTitle || item.pageTitle || '')}">${escapeHtml(item.customTitle || item.pageTitle || '自动读取')}</td><td>${escapeHtml(item.goodsId || '待识别')}</td><td class="counts-cell">${escapeHtml(countText)}</td><td class="status-${item.status}">${labels[item.status] || item.status}</td><td>${escapeHtml(issue)}</td><td>${item.result ? `<button class="repack-btn" data-task-id="${item.id}">重新打包</button> <button class="reparse-btn" data-task-id="${item.id}">重新解析</button>` : ''}</td></tr>`; }).join('');
  $('logs').innerHTML = (run?.logs || []).slice().reverse().map((log) => `<div class="log-${log.type}">[${new Date(log.time).toLocaleTimeString()}] ${escapeHtml(log.text)}</div>`).join('');
}

function parseCsv(text) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  const source = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (char === '"' && source[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = false; else value += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

$('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const lower = file.name.toLowerCase(); let tasks;
    if (lower.endsWith('.xlsx')) tasks = parseTaskRows(await parseXlsx(file));
    else if (lower.endsWith('.csv')) tasks = parseTaskRows(parseCsv(await file.text()));
    else tasks = parseTaskText(await file.text());
    if (!tasks.length) return alert('文件中没有识别到 yangkeduo.com 商品链接');
    const response = await call('PDD_IMPORT_TASKS', { tasks, sourceName: file.name });
    if (!response?.ok) alert(response?.error || '导入失败'); else render(response.run);
  } catch (error) { alert(`导入失败：${error.message}`); }
});

for (const [id,type] of [['startBtn','PDD_START'],['pauseBtn','PDD_PAUSE'],['resumeBtn','PDD_RESUME'],['stopBtn','PDD_STOP']]) $(id).onclick = async () => { const response = await call(type); if (!response?.ok) alert(response?.error || '操作失败'); };
$('retryBtn').onclick = async () => { const response = await call('PDD_RETRY_FAILED'); if (!response?.ok) alert(response?.error || '没有可重试任务'); else render(response.run); };
$('summaryBtn').onclick = async () => { const response = await call('PDD_EXPORT_SKU_CSV'); if (!response?.ok) alert(response?.error || '当前没有已解析的SKU记录'); };
$('taskRows').onclick = async (event) => { const repack = event.target.closest('.repack-btn'); const reparse = event.target.closest('.reparse-btn'); if (reparse) { const response = await call('PDD_REPARSE_TASK', { taskId: reparse.dataset.taskId }); if (!response?.ok) alert(response?.error || '重新解析设置失败'); else render(response.run); return; } if (!repack) return; repack.disabled = true; repack.textContent = '打包中…'; const response = await call('PDD_REPACKAGE_TASK', { taskId: repack.dataset.taskId }); if (!response?.ok) alert(response?.error || '重新打包失败'); repack.disabled = false; repack.textContent = '重新打包'; };
$('clearBtn').onclick = async () => { if (!confirm('确定清除当前任务和全部下载历史吗？')) return; await call('PDD_CLEAR'); render(null); };
async function saveSettings() { await call('PDD_SAVE_SETTINGS', { settings: { ...Object.fromEntries(optionIds.map((id) => [id, $(id).checked])), taskIntervalSec: Math.max(2, Math.min(120, Number($('taskIntervalSec').value) || 8)), skuIntervalMs: Math.max(300, Math.min(5000, Number($('skuIntervalMs').value) || 800)) } }); }
for (const id of optionIds) $(id).onchange = saveSettings;
for (const id of Object.keys(numberDefaults)) $(id).onchange = saveSettings;
$('exportBtn').onclick = async () => { const latest = await call('PDD_GET_RUN'); currentHistory = latest?.history || currentHistory; const blob = new Blob([JSON.stringify(currentHistory, null, 2)], {type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='download_history.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); };
chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'PDD_RUN_UPDATED') render(message.run); });
const initial = await call('PDD_GET_RUN'); currentHistory = initial?.history || []; render(initial?.run || null);
for (const id of optionIds) $(id).checked = initial?.settings?.[id] !== false;
for (const [id, fallback] of Object.entries(numberDefaults)) $(id).value = initial?.settings?.[id] || fallback;
