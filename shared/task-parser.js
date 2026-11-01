export function sanitizeFilePart(value, fallback = '拼多多商品') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || fallback).slice(0, 100);
}

export function createTask(url, title, index) {
  return {
    id: crypto.randomUUID(), index, url, goodsId: extractGoodsId(url), customTitle: title || '',
    pageTitle: '', status: 'waiting', error: '', result: null,
    createdAt: new Date().toISOString(), completedAt: ''
  };
}

export function extractGoodsId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('goods_id') || parsed.searchParams.get('goodsId') || '';
  } catch {
    return String(url).match(/[?&](?:goods_id|goodsId)=(\d+)/i)?.[1] || '';
  }
}

function isTitleCandidate(line) {
  const value = line.trim();
  return Boolean(value && !/^\[?链接\]?/i.test(value) && !/^https?:\/\//i.test(value));
}

function isChatTimestamp(line) {
  return /^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s+\d{1,2}(?::|：|\s)\d{1,2})?$/u.test(line.trim());
}

export function parseTaskText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const tasks = [];
  const seen = new Set();
  let pendingTitle = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const urls = line.match(/https?:\/\/[^\s<>"']+/gi) || [];
    if (!urls.length) {
      // 微信/聊天记录导出的“发送人 + 日期时间”不是视频标题。
      // 时间行同时作为一条新消息的边界，避免上一行发送人姓名被继承为标题。
      if (isChatTimestamp(line)) {
        pendingTitle = '';
        continue;
      }
      if (isTitleCandidate(line)) pendingTitle = line;
      continue;
    }
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[),，。；;]+$/g, '').replace(/&amp;/g, '&');
      if (!/yangkeduo\.com/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      tasks.push(createTask(url, pendingTitle, tasks.length + 1));
    }
    pendingTitle = '';
  }
  return tasks;
}

export function parseTaskRows(rows) {
  const tasks = [];
  const seen = new Set();
  for (const row of rows || []) {
    const cells = (row || []).map((value) => String(value ?? '').trim());
    const url = cells.find((value) => /^https?:\/\/[^\s]*yangkeduo\.com/i.test(value));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = cells.find((value) => value && value !== url && !/^\d+(?:\.\d+)?$/.test(value)) || '';
    tasks.push(createTask(url, title, tasks.length + 1));
  }
  return tasks;
}
