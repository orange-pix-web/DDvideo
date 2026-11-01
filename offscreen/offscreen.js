import { createZip } from '../shared/zip-writer.js';

const objectUrls = new Set();
const sanitize = (value, fallback = '未命名') => (String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '').replace(/[. ]+$/g, '').trim() || fallback).slice(0, 80);
const pad = (value) => String(value).padStart(2, '0');

function extensionFor(url, contentType = '') {
  const type = contentType.toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('avif')) return 'avif';
  if (type.includes('gif')) return 'gif';
  if (type.includes('video/mp4')) return 'mp4';
  const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|avif|gif|mp4)$/i);
  return match ? match[1].replace(/^jpeg$/i, 'jpg').toLowerCase() : 'jpg';
}

async function fetchFile(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { blob: await response.blob(), type: response.headers.get('content-type') || '' };
    } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, attempt * 500)); }
  }
  throw new Error(`素材下载失败：${lastError?.message || url}`);
}

function skuText(payload) {
  const lines = [`商品ID：${payload.goodsId}`, `商品标题：${payload.pageTitle || ''}`, `商品链接：${payload.url || ''}`, ''];
  for (const sku of payload.skus || []) lines.push(`${sku.text} 价格：${Number(sku.price || 0).toFixed(2)}`);
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

async function buildPackage(payload, options) {
  const files = [];
  const addImages = async (items, makeName) => {
    for (let index = 0; index < items.length; index++) {
      const item = typeof items[index] === 'string' ? { url: items[index], label: '' } : items[index];
      if (!item.url) continue;
      const downloaded = await fetchFile(item.url);
      files.push({ name: `${makeName(index, item)}.${extensionFor(item.url, downloaded.type)}`, data: downloaded.blob });
    }
  };
  if (options.mainImages) await addImages(payload.mainImages || [], (index) => `${payload.goodsId}_主图${pad(index + 1)}`);
  if (options.skuImages) {
    const skuImages = (payload.skus || []).map((sku) => ({ url: sku.imageUrl, label: sku.attributes?.map((item) => item.value).join('_') || sku.text })).filter((item) => item.url);
    await addImages(skuImages, (index, item) => `${payload.goodsId}_SKU${pad(index + 1)}_${sanitize(item.label, '未命名SKU')}`);
  }
  if (options.detailImages) await addImages(payload.detailImages || [], (index) => `${payload.goodsId}_详情图${pad(index + 1)}`);
  if (options.videos) await addImages(payload.videos || [], (index) => `${payload.goodsId}_视频${pad(index + 1)}`);
  if (options.skuText) files.push({ name: `${payload.goodsId}_SKU文字.txt`, data: skuText(payload) });
  if (!files.length) throw new Error('所选内容没有可打包的素材');
  const blob = await createZip(files);
  const blobUrl = URL.createObjectURL(blob); objectUrls.add(blobUrl);
  return { blobUrl, filename: `${payload.goodsId}.zip`, fileCount: files.length, size: blob.size };
}

function makeCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `\ufeff${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['PDD_BUILD_PACKAGE', 'PDD_BUILD_CSV', 'PDD_REVOKE_URL'].includes(message?.type)) return false;
  (async () => {
    if (message?.type === 'PDD_BUILD_PACKAGE') return { ok: true, ...(await buildPackage(message.payload, message.options)) };
    if (message?.type === 'PDD_BUILD_CSV') {
      const blob = new Blob([makeCsv(message.rows || [])], { type: 'text/csv;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob); objectUrls.add(blobUrl);
      return { ok: true, blobUrl, filename: message.filename || 'SKU汇总.csv' };
    }
    if (message?.type === 'PDD_REVOKE_URL') { if (objectUrls.has(message.url)) { URL.revokeObjectURL(message.url); objectUrls.delete(message.url); } return { ok: true }; }
    return { ok: false };
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
