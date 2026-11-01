(() => {
  'use strict';
  let collecting = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showStatus(text) {
    let el = document.getElementById('pdd-material-runner-status');
    if (!el) { el = document.createElement('div'); el.id = 'pdd-material-runner-status'; document.documentElement.appendChild(el); }
    el.textContent = text;
  }

  function imageUrl(img) {
    const srcset = img?.getAttribute?.('srcset')?.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
    const value = img?.dataset?.src || img?.dataset?.original || img?.getAttribute?.('data-lazy-src') || img?.currentSrc || img?.src || srcset || '';
    return /^https?:\/\//i.test(value) ? value : '';
  }
  function cleanImageUrl(url) {
    if (!url) return '';
    try { const parsed = new URL(url); if (/pddpic\.com$/i.test(parsed.hostname)) parsed.search = ''; return parsed.toString(); } catch { return url; }
  }
  function imageKey(url) { try { const parsed = new URL(cleanImageUrl(url)); return `${parsed.pathname}${parsed.search}`; } catch { return url; } }
  function uniqueUrls(urls) {
    const seen = new Set();
    return urls.map(cleanImageUrl).filter((url) => { const key = imageKey(url); if (!url || seen.has(key)) return false; seen.add(key); return true; });
  }
  function goodsId() { const url = new URL(location.href); return url.searchParams.get('goods_id') || url.searchParams.get('goodsId') || ''; }
  function pageTitle() {
    for (const selector of ['[class*="enable-select"] span', '[aria-label^="商品标题"]', 'h1']) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text && text.length > 5) return text;
    }
    return document.title.replace(/[-_—|].*$/, '').trim();
  }
  function collectMainImages() {
    let urls = [...document.querySelectorAll('img[aria-label="商品大图"]')].map(imageUrl);
    if (!urls.length) { const counter = [...document.querySelectorAll('[aria-label*="张商品图"]')][0]; if (counter?.parentElement) urls = [...counter.parentElement.querySelectorAll('img')].map(imageUrl); }
    return uniqueUrls(urls);
  }
  function collectDetailImages() {
    let urls = [...document.querySelectorAll('img[aria-label="查看图片"]')].map(imageUrl);
    const heading = [...document.querySelectorAll('p,div,span')].find((el) => el.children.length === 0 && el.textContent.trim() === '商品详情');
    if (heading) {
      for (const img of document.querySelectorAll('img')) {
        if (!(heading.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const url = imageUrl(img);
        if (/mms-material-img|goods-image|goods\/|gaudit-image/i.test(url)) urls.push(url);
      }
    }
    return uniqueUrls(urls);
  }
  function collectVideos() {
    const urls = [];
    for (const video of document.querySelectorAll('video')) {
      const direct = video.currentSrc || video.src || '';
      if (/^https?:\/\//i.test(direct)) urls.push(direct);
      for (const source of video.querySelectorAll('source')) if (/^https?:\/\//i.test(source.src || '')) urls.push(source.src);
    }
    for (const script of document.scripts) {
      const matches = (script.textContent || '').match(/https?:\\?\/\\?\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]*)?/gi) || [];
      for (const value of matches) urls.push(value.replace(/\\\//g, '/').replace(/\\u002F/gi, '/'));
    }
    return [...new Set(urls)];
  }
  function verificationReason() {
    const route = `${location.href} ${document.title}`;
    if (/captcha|verify|verification|risk|安全验证|访问验证/i.test(route)) return '页面已进入安全验证';
    const text = (document.body?.innerText || '').slice(0, 1200);
    if (text.length < 800 && /请完成验证|拖动滑块|安全验证|访问过于频繁|操作频繁|异常访问/.test(text)) return text.match(/请完成验证|拖动滑块|安全验证|访问过于频繁|操作频繁|异常访问/)?.[0] || '拼多多要求人工验证';
    return '';
  }
  async function ensureSkuPanel() {
    const isVisible = () => {
      const key = document.querySelector('.sku-specs-key');
      if (!key) return false;
      const rect = key.getBoundingClientRect();
      return rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    };
    if (isVisible()) return true;
    const opener = [...document.querySelectorAll('[role="button"],button')].reverse().find((el) => /免拼购买|发起拼单|单独购买|立即购买|直接购买|购买|选择规格|选规格/.test(el.textContent || ''));
    opener?.click();
    const started = Date.now();
    while (Date.now() - started < 5000) { if (isVisible()) return true; await sleep(150); }
    return false;
  }
  function skuGroups() {
    const groups = [...document.querySelectorAll('.sku-specs-key')].map((keyNode) => {
      const root = keyNode.closest('.bIhLWVqm') || keyNode.parentElement;
      const buttons = [...(root?.querySelectorAll('[role="button"][aria-label]') || [])].filter((button) => {
        const label = button.getAttribute('aria-label') || '';
        return label && !/减少数量|增加数量|关闭|确定/.test(label);
      });
      return { key: keyNode.textContent.trim() || '规格', buttons };
    }).filter((group) => group.buttons.length);
    if (groups.length) return groups;
    const panel = document.querySelector('.sku-plus1') || [...document.querySelectorAll('[role="dialog"]')].find((node) => /请选择|规格|款式|型号|颜色|尺寸/.test(node.textContent || ''));
    if (!panel) return [];
    const buttons = [...panel.querySelectorAll('[role="button"][aria-label]')].filter((button) => {
      const label = button.getAttribute('aria-label') || '';
      return label && !/减少数量|增加数量|关闭|确定|查看大图/.test(label);
    });
    return buttons.length ? [{ key: '规格', buttons }] : [];
  }
  function combinations(groups, limit = 300) {
    let result = [[]];
    for (const group of groups) result = result.flatMap((current) => group.buttons.map((button) => [...current, { key: group.key, button }])).slice(0, limit);
    return result;
  }
  function isUnavailable(button) { return button.getAttribute('aria-disabled') === 'true' || /disabled|disable|soldout|unavailable/i.test(button.className || ''); }
  function currentSkuPrice() {
    const dialog = document.querySelector('[role="dialog"]') || document.querySelector('.sku-plus1') || document.body;
    const text = dialog.querySelector('.ujEqGzEB')?.textContent || dialog.textContent || '';
    return text.match(/¥\s*(\d+(?:\.\d+)?)(?:\s*[-~至]\s*\d+(?:\.\d+)?)?/)?.[1] || '';
  }
  function currentSkuImage() {
    const dialog = document.querySelector('[role="dialog"]') || document.querySelector('.sku-plus1');
    return cleanImageUrl(imageUrl(dialog?.querySelector('img[aria-label*="大图"], img[data-uniqid]')));
  }
  async function collectSkus(enabled) {
    if (!enabled) return [];
    const panelOpened = await ensureSkuPanel();
    const groups = skuGroups();
    if (!groups.length) {
      const price = currentSkuPrice() || (document.body.textContent || '').match(/¥\s*(\d+(?:\.\d+)?)/)?.[1] || '';
      const fallbackImage = currentSkuImage() || collectMainImages()[0] || '';
      return [{ attributes: [{ key: '款式', value: '默认规格' }], text: '款式:默认规格', price, imageUrl: fallbackImage, combinationIndex: 1, fallback: true }];
    }
    const result = [];
    for (const combo of combinations(groups)) {
      if (combo.some(({ button }) => isUnavailable(button))) continue;
      const interval = Math.max(300, Math.min(5000, Number(window.__pddSkuIntervalMs) || 800));
      if (panelOpened) for (const { button } of combo) { button.click(); await sleep(interval); }
      if (combo.some(({ button }) => isUnavailable(button))) continue;
      if (panelOpened) await sleep(Math.max(300, Math.floor(interval / 2)));
      const attributes = combo.map(({ key, button }) => ({ key, value: (button.getAttribute('aria-label') || button.textContent || '').trim() }));
      const text = attributes.map((item) => `${item.key}:${item.value}`).join(' ');
      if (!text) continue;
      result.push({ attributes, text, price: currentSkuPrice(), imageUrl: currentSkuImage() || collectMainImages()[0] || '', combinationIndex: result.length + 1, panelOpened });
      showStatus(`素材下载助手：已解析 ${result.length} 个SKU`);
    }
    return result;
  }
  async function collectMaterial(options) {
    if (collecting) return; collecting = true;
    try {
      window.__pddSkuIntervalMs = options.skuIntervalMs;
      showStatus('素材下载助手：正在等待商品页面加载…');
      const started = Date.now();
      while (Date.now() - started < 20000 && !document.querySelector('img[aria-label="商品大图"], .sku-specs-key')) { const reason = verificationReason(); if (reason) { await chrome.runtime.sendMessage({ type: 'PDD_VERIFICATION_REQUIRED', error: reason }); showStatus('素材下载助手：等待人工验证'); return; } await sleep(300); }
      const reason = verificationReason(); if (reason) { await chrome.runtime.sendMessage({ type: 'PDD_VERIFICATION_REQUIRED', error: reason }); showStatus('素材下载助手：等待人工验证'); return; }
      const skus = await collectSkus(options.skuImages || options.skuText);
      const payload = { goodsId: goodsId(), pageTitle: pageTitle(), url: location.href, mainImages: options.mainImages ? collectMainImages() : [], detailImages: options.detailImages ? collectDetailImages() : [], videos: options.videos ? collectVideos() : [], skus: skus.map((sku) => ({ ...sku, imageUrl: options.skuImages ? sku.imageUrl : '' })) };
      payload.counts = { mainImages: payload.mainImages.length, skuImages: payload.skus.filter((sku) => sku.imageUrl).length, detailImages: payload.detailImages.length, skuText: payload.skus.length, videos: payload.videos.length };
      payload.warnings = [];
      for (const [key, label] of Object.entries({ mainImages:'主图', skuImages:'SKU图', detailImages:'详情图', skuText:'SKU文字', videos:'视频' })) if (options[key] && payload.counts[key] === 0) payload.warnings.push(`已勾选${label}，但页面解析数量为0`);
      if (payload.skus.some((sku) => sku.fallback)) payload.warnings.push('未发现规格按钮，已按单规格商品生成“默认规格”记录');
      else if (payload.skus.some((sku) => sku.panelOpened === false)) payload.warnings.push('SKU弹窗未成功显示，已从隐藏规格DOM读取文案；各规格价格和图片可能需要重新解析');
      if (!payload.goodsId) throw new Error('没有识别到商品ID');
      if (!payload.mainImages.length && !payload.detailImages.length && !payload.skus.length && !payload.videos.length) throw new Error('页面中没有识别到所选素材');
      showStatus('素材下载助手：解析完成，正在打包');
      await chrome.runtime.sendMessage({ type: 'PDD_MATERIAL_READY', payload });
    } catch (error) { showStatus(`素材下载助手：${error.message}`); await chrome.runtime.sendMessage({ type: 'PDD_MATERIAL_FAILED', error: error.message }); }
    finally { collecting = false; }
  }
  chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'PDD_COLLECT_MATERIAL') collectMaterial(message.options || {}); });
  chrome.runtime.sendMessage({ type: 'PDD_RUNNER_READY', url: location.href });
})();
