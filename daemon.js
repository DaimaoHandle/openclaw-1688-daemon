const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function loadPlaywrightChromium() {
  try {
    return require('playwright-core').chromium;
  } catch (err) {
    const fallback = process.env.PLAYWRIGHT_CORE_PATH || process.env.KF1688_PLAYWRIGHT_CORE_PATH;
    if (fallback) {
      return require(fallback).chromium;
    }
    throw new Error('playwright-core not found. Install it normally or set PLAYWRIGHT_CORE_PATH / KF1688_PLAYWRIGHT_CORE_PATH.');
  }
}

const chromium = loadPlaywrightChromium();
const ROOT = __dirname;
const KB_PATH = path.join(ROOT, 'kb.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const LOG_PATH = path.join(ROOT, 'daemon.log');
const LOCK_PATH = path.join(ROOT, 'daemon.lock');
const DEFAULT_OPENCLAW_CONFIG_CANDIDATES = [
  process.env.KF1688_OPENCLAW_CONFIG_PATH,
  process.env.OPENCLAW_CONFIG_PATH,
  path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  path.join(os.homedir(), '.config', 'openclaw', 'openclaw.json')
].filter(Boolean);
const RELAY_URL = process.env.KF1688_RELAY_URL || 'ws://127.0.0.1:18792/cdp';
const RELAY_PORT = Number(process.env.KF1688_RELAY_PORT || 18792);
const GATEWAY_URL = process.env.KF1688_GATEWAY_URL || 'http://127.0.0.1:18789/v1/chat/completions';
const TOOLS_INVOKE_URL = process.env.KF1688_TOOLS_INVOKE_URL || 'http://127.0.0.1:18789/tools/invoke';
const AGENT_ID = process.env.KF1688_AGENT_ID || 'main';
const POLL_MS = Number(process.env.KF1688_POLL_MS || 15000);
const MAX_CONTEXT_MESSAGES = Number(process.env.KF1688_MAX_CONTEXT_MESSAGES || 6);
const HUMAN_NOTIFY_TARGET = (process.env.KF1688_NOTIFY_TARGET || '').trim();
const SHOP_NAMES = new Set(parseConfiguredShopNames());
const NAV_TEXT_RE = /首页|我的阿里|我的订单|采购车|消息|官方服务|下载插件|去安装|找货源|搜\s*索|以图搜款/;


function parseConfiguredShopNames() {
  const raw = (process.env.KF1688_SHOP_NAMES || process.env.KF1688_SHOP_NAME || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
  } catch {}
  return raw.split(',').map(x => x.trim()).filter(Boolean);
}

function resolveOpenClawConfigPath() {
  for (const candidate of DEFAULT_OPENCLAW_CONFIG_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`openclaw config not found. Set KF1688_OPENCLAW_CONFIG_PATH or OPENCLAW_CONFIG_PATH. Tried: ${DEFAULT_OPENCLAW_CONFIG_CANDIDATES.join(', ')}`);
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function acquireSingletonLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    const release = () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(LOCK_PATH); } catch {}
    };
    process.on('exit', release);
    process.on('SIGINT', () => { release(); process.exit(0); });
    process.on('SIGTERM', () => { release(); process.exit(0); });
    return true;
  } catch {
    return false;
  }
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function getGatewayToken() {
  const raw = fs.readFileSync(resolveOpenClawConfigPath(), 'utf8');
  const m = raw.match(/"token"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error('gateway token not found in openclaw.json');
  return m[1];
}

function deriveRelayToken(gatewayToken, port) {
  return crypto.createHmac('sha256', gatewayToken).update(`openclaw-extension-relay-v1:${port}`).digest('hex');
}

async function connectRelay() {
  const gatewayToken = getGatewayToken();
  const relayToken = deriveRelayToken(gatewayToken, RELAY_PORT);
  const browser = await chromium.connectOverCDP(RELAY_URL, {
    headers: { 'x-openclaw-relay-token': relayToken }
  });
  return { browser, gatewayToken };
}

function pickPage(browser) {
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => /air\.1688\.com/.test(p.url()) && /旺旺聊天|def_cbu_web_im/.test(`${p.url()} ${p.url()}`)) || pages[0];
  if (!page) throw new Error('no attached tab found');
  return page;
}

function pickBusinessFrame(page) {
  const frames = page.frames();
  return frames.find(f => /def_cbu_web_im_core/.test(f.url())) || page.mainFrame();
}

async function assertWorkbench(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  if (!/1688旺旺聊天|def_cbu_web_im|air\.1688\.com/.test(`${title} ${url}`)) {
    throw new Error(`attached tab is not 1688 workbench: ${title} ${url}`);
  }
}

async function findUnreadConversation(frame) {
  return await frame.evaluate(({ shopNames, navPatternSource }) => {
    const shopSet = new Set(shopNames);
    const navRe = new RegExp(navPatternSource);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };

    const rows = Array.from(document.querySelectorAll('.conversation-item')).filter(isVisible);
    const candidates = [];
    const debugBadges = [];

    for (const row of rows) {
      const badgeEl = row.querySelector('.unread-badge');
      if (!badgeEl || !isVisible(badgeEl)) continue;
      const badge = norm(badgeEl.innerText || badgeEl.textContent || '');
      if (!/^(\d+|99\+)$/.test(badge)) continue;

      const nameEl = row.querySelector('.name');
      const timeEl = row.querySelector('.time');
      const descEl = row.querySelector('.desc');
      const name = norm(nameEl?.innerText || nameEl?.textContent || '');
      const time = norm(timeEl?.innerText || timeEl?.textContent || '');
      const desc = norm(descEl?.innerText || descEl?.textContent || '');
      if (!name || shopSet.has(name) || navRe.test(name)) continue;

      const rr = row.getBoundingClientRect();
      const br = badgeEl.getBoundingClientRect();
      const badgeScore = badge === '99+' ? 99 : (Number.parseInt(badge, 10) || 0);

      candidates.push({
        name,
        badge,
        time,
        desc,
        text: [name, time, desc].filter(Boolean).join(' ').slice(0, 120),
        top: rr.top,
        left: rr.left,
        width: rr.width,
        height: rr.height,
        centerX: rr.left + Math.min(140, rr.width * 0.45),
        centerY: rr.top + rr.height / 2,
        badgeScore,
        priority: 1000 + Math.min(badgeScore, 99)
      });
      debugBadges.push({ name, badge, time, desc, rowTop: rr.top, badgeLeft: br.left, badgeTop: br.top });
    }

    candidates.sort((a, b) => (b.priority - a.priority) || (a.top - b.top));
    candidates.debugBadges = debugBadges.slice(-12);
    return candidates;
  }, { shopNames: [...SHOP_NAMES], navPatternSource: NAV_TEXT_RE.source });
}

async function openConversation(frame, candidate) {
  const clickNow = async (x, y) => {
    await frame.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
      el.click();
      return true;
    }, { x, y });
  };

  await clickNow(candidate.centerX, candidate.centerY);
  await frame.waitForTimeout(1200);

  const locked = await confirmConversationLocked(frame, candidate);
  if (locked.ok) return { clicked: true, relocked: false };

  const refreshed = await findUnreadConversation(frame);
  const same = refreshed.find(item => item.name === candidate.name && item.badge === candidate.badge) ||
    refreshed.find(item => item.name === candidate.name);
  if (!same) return { clicked: true, relocked: false };

  await clickNow(same.centerX, same.centerY);
  await frame.waitForTimeout(1200);
  return { clicked: true, relocked: true };
}

async function confirmConversationLocked(frame, candidate) {
  return await frame.evaluate((name) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const bodyText = norm(document.body.innerText || '');
    const unselected = bodyText.includes('您尚未选择联系人');
    const hasChatSignals = /发送|输入消息|客户信息|订单|商品|快捷回复/.test(bodyText);
    const hasMessageArea = /发送/.test(bodyText) && /客户信息|快捷回复|订单|商品/.test(bodyText);
    const hasNameSomewhere = !!name && bodyText.includes(name);
    return {
      ok: !unselected && hasChatSignals && hasMessageArea,
      hasName: hasNameSomewhere,
      unselected,
      hasChatSignals,
      hasMessageArea
    };
  }, candidate.name);
}

async function readRecentMessages(frame) {
  return await frame.evaluate(({ maxItems, shopNames }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const bodyText = norm(document.body.innerText || '');

    const all = Array.from(document.querySelectorAll('div, section, main, article'));
    const chatRoot = all
      .filter(isVisible)
      .map(el => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || '') }))
      .filter(x => x.rect.left > 260 && x.rect.right < window.innerWidth - 180)
      .filter(x => x.rect.top > 60 && x.rect.bottom < window.innerHeight - 80)
      .filter(x => /发送|输入消息|客户信息|快捷回复|订单|商品/.test(x.text))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || document.body;

    const ignoredTextRe = /发送|输入消息|快捷回复|客户信息|搜索|订单还未付款|发现有一笔订单|平台提醒|系统消息|官方提醒|订单卡片|客服评价邀请|店铺首页|已读|未读|开启智能找品询盘/;
    const cardTextRe = /商品卡片|¥|￥|券后|成交|件装|起批|代发/;
    const isNoiseText = (text) => {
      if (!text) return true;
      if (ignoredTextRe.test(text)) return true;
      if (/^\d+\s*\/\s*\d+$/.test(text)) return true;
      if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(text)) return true;
      if (/^(现在|刚刚|昨天|星期.|周.|\d+分钟前|\d+小时前)$/.test(text)) return true;
      return false;
    };
    const shopSet = new Set(shopNames || []);
    const bubbles = [];

    const textNodes = [];
    const treeWalker = document.createTreeWalker(chatRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = norm(node.nodeValue || '');
        if (!text || text.length < 1 || text.length > 120) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let currentNode;
    while ((currentNode = treeWalker.nextNode())) {
      const parent = currentNode.parentElement;
      if (!parent || !isVisible(parent)) continue;
      const text = norm(currentNode.nodeValue || '');
      if (!text || text.length < 1 || text.length > 120) continue;
      if (isNoiseText(text)) continue;

      const r = parent.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 80) continue;
      if (r.left < 260 || r.right > window.innerWidth - 180) continue;
      if (r.width < 6 || r.height < 12) continue;

      textNodes.push({ text, rect: { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height } });
    }

    const selfAnchors = textNodes
      .filter(item => shopSet.has(item.text))
      .map(item => ({ top: item.rect.top, left: item.rect.left, right: item.rect.right }));

    const seenLeaf = new Set();
    for (const node of textNodes) {
      const text = node.text;
      const r = node.rect;
      if (isNoiseText(text)) continue;

      const nearSelfAnchor = selfAnchors.some(a =>
        r.top >= a.top - 6 &&
        r.top <= a.top + 120 &&
        r.right >= a.left - 40
      );

      let side = 'unknown';
      if (nearSelfAnchor || r.left >= window.innerWidth * 0.60 || r.right >= window.innerWidth * 0.86) {
        side = 'self';
      } else if (r.left <= window.innerWidth * 0.40 && r.right <= window.innerWidth * 0.70) {
        side = 'customer';
      }
      if (side === 'unknown') continue;
      if (shopSet.has(text)) continue;

      const key = `${side}|${text}|${Math.round(r.top / 6)}|${Math.round(r.left / 6)}`;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);

      bubbles.push({
        text,
        side,
        top: r.top,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        area: r.width * r.height,
        isCard: cardTextRe.test(text)
      });
    }

    bubbles.sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.area - b.area));

    const dedup = [];
    for (const item of bubbles) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.side === item.side && prev.text === item.text && Math.abs(prev.top - item.top) < 28) continue;
      dedup.push(item);
    }

    const textOnlyMessages = dedup.filter(item => !item.isCard && !isNoiseText(item.text));
    const last = textOnlyMessages.length ? textOnlyMessages[textOnlyMessages.length - 1] : null;

    let lastSelfIndex = -1;
    for (let i = textOnlyMessages.length - 1; i >= 0; i--) {
      if (textOnlyMessages[i].side === 'self') {
        lastSelfIndex = i;
        break;
      }
    }

    const customerSinceLastSelf = textOnlyMessages.filter((item, idx) => idx > lastSelfIndex && item.side === 'customer');
    const customerCardSinceLastSelf = dedup.filter(item => item.isCard && item.side === 'customer' && item.top >= (textOnlyMessages[lastSelfIndex]?.top || 0));

    return {
      conversationReady: !bodyText.includes('您尚未选择联系人'),
      messages: textOnlyMessages.slice(-maxItems),
      customerSinceLastSelf: customerSinceLastSelf.slice(-maxItems),
      hasCustomerProductCardOnly: customerSinceLastSelf.length === 0 && customerCardSinceLastSelf.length > 0,
      customerProductCardTexts: customerCardSinceLastSelf.slice(-maxItems),
      lastSide: last?.side || 'unknown',
      lastText: last?.text || '',
      debugTail: dedup.slice(-8)
    };
  }, { maxItems: MAX_CONTEXT_MESSAGES, shopNames: [...SHOP_NAMES] });
}

function getLatestCustomerQuestion(readResult) {
  if (readResult.lastSide === 'self') return '';
  const customer = readResult.customerSinceLastSelf?.length
    ? readResult.customerSinceLastSelf
    : [];
  const cleaned = customer
    .map(m => (m.text || '').trim())
    .filter(Boolean)
    .filter(t => !/^(在的亲，有什么可以帮您的|亲，麻烦您发一下商品链接或者产品卡片给我，这边帮您看下具体信息哦)$/.test(t));
  return cleaned.length ? cleaned.join(' ').trim() : '';
}

async function getCurrentConversationLastMessageSide(frame) {
  const result = await readRecentMessages(frame);
  const customerMsgs = result.customerSinceLastSelf || [];
  const msgs = result.messages || [];
  return {
    side: result.lastSide || (msgs[msgs.length - 1]?.side || 'unknown'),
    text: result.lastText || msgs[msgs.length - 1]?.text || '',
    conversationReady: !!result.conversationReady,
    messages: msgs,
    customerSinceLastSelf: customerMsgs,
    lastSide: result.lastSide || 'unknown',
    lastText: result.lastText || '',
    debugTail: result.debugTail || []
  };
}

async function getCurrentConversationName(frame) {
  return await frame.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('div, span, h1, h2, h3, p'));
    const candidates = nodes
      .filter(isVisible)
      .map(el => ({ text: norm(el.innerText || el.textContent || ''), rect: el.getBoundingClientRect() }))
      .filter(x => x.text && x.text.length <= 40)
      .filter(x => x.rect.top >= 0 && x.rect.top < 140 && x.rect.left > 220 && x.rect.left < window.innerWidth - 120)
      .filter(x => !/发送|输入消息|客户信息|订单|商品|快捷回复|搜索/.test(x.text))
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    return candidates[0]?.text || '当前会话';
  });
}

function fingerprintCustomerMessage(conversationName, question) {
  return crypto.createHash('sha1').update(`${conversationName}|${(question || '').trim()}`).digest('hex');
}

function fingerprintListCandidate(candidate) {
  return crypto.createHash('sha1').update([
    candidate?.name || '',
    candidate?.badge || '',
    candidate?.time || '',
    candidate?.desc || '',
    candidate?.text || ''
  ].join('|')).digest('hex');
}

function isProductQuestion(question) {
  return /材质|面料|成分|尺寸|重量|规格|颜色|款式|功能|参数|配件|包装内容|图片里|哪个款|适合|怎么用|细节|这款|这个/.test(question || '');
}

function isFreshProductContext(ctx) {
  if (!ctx?.savedAt) return false;
  const ts = Date.parse(ctx.savedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= 20 * 60 * 1000;
}

function shouldSkipByStartupBaseline(state, conversationName, fingerprint) {
  return state.startupBaseline?.[conversationName] === fingerprint;
}

function loadKnowledgeBase() {
  return loadJson(KB_PATH, []);
}

function extractProductLink(...parts) {
  const flattened = parts.flatMap(part => {
    if (!part) return [];
    if (Array.isArray(part)) return part;
    return [part];
  });
  const joined = flattened.map(item => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (typeof item.text === 'string') return item.text;
    return '';
  }).join(' ');
  const m = joined.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

function getProductCardContext(readResult) {
  const cards = readResult.customerProductCardTexts || [];
  const texts = cards.map(item => (item.text || '').trim()).filter(Boolean);
  const title = texts
    .filter(t => t.length >= 6)
    .filter(t => !/^(¥|￥)/.test(t))
    .sort((a, b) => b.length - a.length)[0] || '';
  const price = texts.find(t => /[¥￥]\s*\d/.test(t)) || '';
  return { title, price, texts };
}

async function forceRefreshConversation(frame, candidate, attempts = 3) {
  let latest = await readRecentMessages(frame);
  for (let i = 0; i < attempts; i++) {
    await frame.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll('*')).find(el => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40;
      });
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await frame.waitForTimeout(900 + i * 500);
    latest = await readRecentMessages(frame);
    const lastText = (latest.lastText || '').trim();
    if (latest.lastSide !== 'self') return latest;
    if (candidate?.text && lastText && !candidate.text.includes(lastText)) return latest;
    await openConversation(frame, candidate).catch(() => {});
  }
  return latest;
}

function matchKnowledgeBase(question) {
  const q = (question || '').trim();
  if (!q) return null;
  const kb = loadKnowledgeBase();
  const scored = kb.map(item => {
    const keywords = item.keywords || [];
    const matched = keywords.filter(k => q.includes(k));
    const score = matched.reduce((sum, k) => sum + k.length, 0) + matched.length * 2;
    const modeBoost = item.mode === 'product_detail_lookup' ? 50 : item.mode === 'require_product_link' ? 30 : 0;
    return { item, matched, score: score + modeBoost };
  }).filter(x => x.matched.length > 0);
  scored.sort((a, b) => b.score - a.score || b.matched.join('').length - a.matched.join('').length);
  return scored[0] ? { ...scored[0].item, matchedKeywords: scored[0].matched, score: scored[0].score } : null;
}

async function invokeTool(gatewayToken, tool, action, args = {}) {
  const res = await fetch(TOOLS_INVOKE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tool, action, args })
  });
  if (!res.ok) {
    throw new Error(`tool invoke failed: ${tool}.${action} ${res.status}`);
  }
  return await res.json();
}

async function notifyHuman(gatewayToken, payload) {
  const message = [
    '1688 需要人工处理',
    `客户昵称：${payload.customerName || '未知'}`,
    `客户原话：${payload.customerQuestion || ''}`,
    `商品标题：${payload.productTitle || '未识别到'}`
  ].join('\n');
  if (!HUMAN_NOTIFY_TARGET) {
    log('notify_human skipped: KF1688_NOTIFY_TARGET not configured', { customerName: payload.customerName || '', customerQuestion: payload.customerQuestion || '' });
    return false;
  }
  const res = await invokeTool(gatewayToken, 'message', 'send', {
    channel: 'feishu',
    target: HUMAN_NOTIFY_TARGET,
    message
  }).catch(() => null);
  return !!res;
}

async function fetchProductDetailContext(page, link) {
  const temp = await page.context().newPage();
  try {
    await temp.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await temp.waitForTimeout(2500);
    return await temp.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const texts = Array.from(document.querySelectorAll('body *'))
        .map(el => norm(el.innerText || el.textContent || ''))
        .filter(Boolean)
        .filter(t => t.length >= 2 && t.length <= 120)
        .slice(0, 40);
      return {
        title: document.title || '',
        url: location.href,
        texts
      };
    });
  } finally {
    await temp.close().catch(() => {});
  }
}

async function extractStructuredProductKnowledge(gatewayToken, context) {
  const prompt = [
    '你是1688商品信息提取助手。这是一次全新的独立任务。',
    '程序本身不负责打开链接和识别商品；你必须自己在服务器上的真实浏览器环境中打开商品链接后再识别。不要基于程序猜测或历史上下文回答。',
    '重要：识别完成后，请主动关闭你为本次识别临时打开的浏览器标签页/窗口，避免长期占用系统资源。',
    '如果页面要求登录、风控、验证码或跳转异常，必须如实在 notes/evidence 中说明，不要编造商品字段。',
    '请按下面优先级检查页面，并输出结构化商品知识：',
    '1. 先看底部详情页图片/详情长图里的文字，优先从图片里识别尺寸表、重量说明、材质说明、参数表。',
    '2. 如果详情页图片没有识别到，再看 SKU/销售属性区域。',
    '3. 再看主图区域与标题区域。',
    '4. 最后再参考参数区/商品属性区和普通页面文字。',
    '重点任务：优先识别尺寸、重量、材质、规格、颜色、起订量。尺寸信息可能出现在详情长图、SKU、参数区、主图文字里。',
    '凡是看到类似 90x120、100*150、120×150cm、150*200cm、长xx宽xx、高xx、尺寸xx 这种表达，都要尽量写入 dimensions 数组；不要因为字段不确定就整体漏掉。',
    '如果不同区域信息不一致，优先保留更具体、带数值、带单位、且更靠近详情页图片的信息，并把依据写入 evidence。',
    '如果某字段无法确认，填空字符串或空数组，不要编造。只返回严格JSON，不要输出解释。',
    'JSON格式：{"product_title":"","link":"","dimensions":[],"weight":"","material":"","colors":[],"specs":[],"shipping_info":"","min_order_qty":"","notes":"","evidence":[]}',
    `商品链接：${context.productLink || ''}`,
    `商品标题：${context.productTitle || ''}`,
    '程序已知的当前问题（仅供你聚焦，不代表答案）：',
    context.currentQuestion || '',
    '程序已知的辅助线索（仅作辅助，不可替代真实浏览器识别）：',
    (context.productTexts || []).join('\n')
  ].join('\n');
  const raw = await callOpenClawStateless(gatewayToken, prompt, 'kf1688-product-knowledge', 0.1);
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/^```/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(jsonText);
  return {
    product_title: parsed.product_title || context.productTitle || '',
    link: parsed.link || context.productLink || '',
    dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
    weight: parsed.weight || '',
    material: parsed.material || '',
    colors: Array.isArray(parsed.colors) ? parsed.colors : [],
    specs: Array.isArray(parsed.specs) ? parsed.specs : [],
    shipping_info: parsed.shipping_info || '',
    min_order_qty: parsed.min_order_qty || '',
    notes: parsed.notes || '',
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : []
  };
}

async function generateProductReplyWithOpenClaw(gatewayToken, context) {
  const prompt = [
    '你是1688店铺中文客服助手。现在你已经拿到了结构化商品知识，请根据客户问题只选用相关字段来回复。',
    '要求礼貌、自然、简洁，控制在1到2句；不要编造不存在的信息；如果对应字段为空，要明确说当前页面暂未识别到该信息。只输出最终回复。',
    `客户问题：${context.customerQuestion}`,
    '结构化商品知识(JSON)：',
    JSON.stringify(context.productKnowledge || {}, null, 2)
  ].join('\n');
  const reply = await callOpenClawStateless(gatewayToken, prompt, 'kf1688-product-detail-reply', 0.2);
  return reply;
}

async function buildProductContextFromLink(page, gatewayToken, conversationName, productLink, productCardContext, currentQuestion = '') {
  const helperTexts = productCardContext?.texts || [];
  const knowledge = await extractStructuredProductKnowledge(gatewayToken, {
    productLink,
    productTitle: productCardContext?.title || '',
    productTexts: helperTexts,
    currentQuestion
  }).catch(err => {
    log('extract_structured_product_knowledge_failed', { conversation: conversationName, error: err.message || String(err) });
    return {
      product_title: productCardContext?.title || '',
      link: productLink,
      dimensions: [],
      weight: '',
      material: '',
      colors: [],
      specs: [],
      shipping_info: '',
      min_order_qty: '',
      notes: 'AI 未成功完成真实浏览器识别',
      evidence: []
    };
  });
  return {
    link: productLink,
    title: knowledge.product_title || productCardContext?.title || '',
    texts: helperTexts,
    snapshotText: '',
    knowledge,
    savedAt: new Date().toISOString()
  };
}

async function callOpenClawStateless(gatewayToken, prompt, userTag, temperature = 0.2) {
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': AGENT_ID,
      'x-openclaw-no-memory': '1'
    },
    body: JSON.stringify({
      model: 'openclaw',
      messages: [
        {
          role: 'system',
          content: '这是一次全新的独立任务。忽略任何之前的上下文、历史对话、旧商品、旧客户问题，只处理本次消息里提供的信息。不要引用未在本次输入中出现的内容。'
        },
        { role: 'user', content: prompt }
      ],
      temperature,
      user: `${userTag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    })
  });
  if (!res.ok) throw new Error(`stateless completions failed: ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('empty stateless completion');
  return content;
}

function isAcknowledgementOnly(question) {
  const q = (question || '').replace(/\s+/g, '').trim();
  if (!q) return false;
  return /^(好|好的|好嘞|好呢|嗯|嗯嗯|哦|哦哦|知道了|收到|明白了|行|行吧|可以|ok|OK|okk|谢谢|谢了|多谢|3q|thanks|thankyou|感谢)(啦|了|哈|呀|哦|噢)?$/.test(q);
}

function isComplexQuestion(question, messages) {
  const q = question || '';
  if (!q) return true;
  if (q.length > 40) return true;
  if (/售后|投诉|退款|退货|换货|发票|优惠|便宜|最低|定制|怎么处理|为什么|能不能/.test(q)) return true;
  const customerTurns = messages.filter(m => m.side === 'customer').length;
  if (customerTurns >= 2) return true;
  if ((q.match(/[？?]/g) || []).length >= 2) return true;
  return false;
}

async function generateReplyWithOpenClaw(gatewayToken, context) {
  const prompt = [
    '你是 1688 店铺中文客服助手。请根据最近收到的客户消息，生成一条适合直接发送的中文回复。',
    '要求语气礼貌、自然、简洁，尽量控制在 1~2 句；如果涉及价格、库存、发货、售后、下单等问题，按电商客服口吻回答；不要编造不存在的承诺；不要输出解释、分析过程、标题或 Markdown，只输出最终要发送给客户的话。',
    `会话名：${context.conversationName}`,
    `最近客户问题：${context.customerQuestion}`,
    '最近对话：',
    context.messages.map(m => `${m.side === 'self' ? '店铺' : m.side === 'customer' ? '客户' : '会话'}：${m.text}`).join('\n')
  ].join('\n');

  const reply = await callOpenClawStateless(gatewayToken, prompt, 'kf1688-daemon', 0.4);
  return reply;
}

async function refreshWorkbench(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function sendReply(frame, reply) {
  const marked = await frame.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const editable = Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable=""]'))
      .find(el => isVisible(el) && el.getBoundingClientRect().top > window.innerHeight * 0.55);
    if (!editable) return { ok: false, reason: 'input-not-found' };
    editable.setAttribute('data-openclaw-reply-input', '1');
    const sendBtn = Array.from(document.querySelectorAll('button, [role="button"], span, div, a'))
      .find(el => isVisible(el) && /发送/.test(norm(el.innerText || el.textContent || '')) && el.getBoundingClientRect().top > window.innerHeight * 0.55);
    if (sendBtn) sendBtn.setAttribute('data-openclaw-send-btn', '1');
    const beforeText = norm(document.body.innerText || '');
    return { ok: true, hasButton: !!sendBtn, beforeText };
  });
  if (!marked.ok) return marked;

  const input = frame.locator('[data-openclaw-reply-input="1"]').first();
  await input.click({ timeout: 3000 });
  const tag = await input.evaluate(el => el.tagName.toLowerCase());
  if (tag === 'textarea' || tag === 'input') {
    await input.fill('');
    await input.type(reply, { delay: 10 });
  } else {
    await input.evaluate((el, value) => {
      el.focus();
      el.innerHTML = '';
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, reply);
  }

  const sendBtn = frame.locator('[data-openclaw-send-btn="1"]').first();
  if (await sendBtn.count()) {
    try {
      await sendBtn.click({ timeout: 3000 });
    } catch {
      await sendBtn.evaluate(el => el.click()).catch(() => {});
    }
  } else {
    await input.press('Enter').catch(() => {});
  }
  await frame.waitForTimeout(1800);

  let result = await frame.evaluate(({ replyText, beforeText }) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const bodyText = norm(document.body.innerText || '');
    const inputEl = document.querySelector('[data-openclaw-reply-input="1"]');
    const inputValue = inputEl ? norm(inputEl.value || inputEl.textContent || '') : '';
    const sentInBubble = bodyText.includes(replyText) && inputValue !== replyText;
    const inputCleared = inputValue.length === 0 || inputValue !== replyText;
    const bodyChanged = bodyText !== beforeText;
    return {
      ok: sentInBubble && bodyChanged && inputCleared,
      sentInBubble,
      inputCleared,
      bodyChanged,
      inputValue
    };
  }, { replyText: reply, beforeText: marked.beforeText });

  if (!result.ok) {
    await input.press('Enter').catch(() => {});
    await frame.waitForTimeout(1500);
    result = await frame.evaluate(({ replyText, beforeText }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const bodyText = norm(document.body.innerText || '');
      const inputEl = document.querySelector('[data-openclaw-reply-input="1"]');
      const inputValue = inputEl ? norm(inputEl.value || inputEl.textContent || '') : '';
      const sentInBubble = bodyText.includes(replyText) && inputValue !== replyText;
      const inputCleared = inputValue.length === 0 || inputValue !== replyText;
      const bodyChanged = bodyText !== beforeText;
      return {
        ok: sentInBubble && bodyChanged && inputCleared,
        sentInBubble,
        inputCleared,
        bodyChanged,
        inputValue
      };
    }, { replyText: reply, beforeText: marked.beforeText });
  }

  return result;
}

async function handleConversation(page, frame, gatewayToken, candidate, readResult, state) {
  if (!readResult.conversationReady) {
    log('conversation not ready after open', candidate.name);
    return { sent: false, skipped: true };
  }

  let effectiveReadResult = readResult;
  const recentListText = (candidate.text || '').trim();
  const normalizedListText = recentListText.replace(new RegExp(`^${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*`), '').trim();
  const lastText = (effectiveReadResult.lastText || '').trim();
  const listShowsFreshUrl = /https?:\/\/|offer\//.test(normalizedListText);
  const listShowsFreshCard = /[¥￥]|厂家现货|规格|尺寸|材质|款式/.test(normalizedListText);
  const looksLikeFreshFollowup = !!normalizedListText && !lastText.includes(normalizedListText) && !/^(现在|刚刚|\d+分钟前|\d+小时前)$/.test(normalizedListText);
  if (effectiveReadResult.lastSide === 'self' && (looksLikeFreshFollowup || listShowsFreshUrl || listShowsFreshCard)) {
    const reread = await forceRefreshConversation(frame, candidate, 3);
    log('forced reread after list/chat mismatch', {
      conversation: candidate.name,
      listText: normalizedListText,
      beforeLastSide: effectiveReadResult.lastSide,
      beforeLastText: effectiveReadResult.lastText || '',
      afterLastSide: reread.lastSide,
      afterLastText: reread.lastText || '',
      debugTail: reread.debugTail || []
    });
    effectiveReadResult = reread;
  }

  const listFingerprint = fingerprintListCandidate(candidate);
  const storedHandled = state.handled?.[candidate.name] || {};

  let question = getLatestCustomerQuestion(effectiveReadResult);
  const productCardOnly = !!effectiveReadResult.hasCustomerProductCardOnly;
  const listSummary = [candidate.desc || '', candidate.time || ''].filter(Boolean).join(' ').trim() || normalizedListText;
  const listHasProductLink = /https?:\/\/|offer\//.test(candidate.text || '');
  const listHasCardSignal = /[¥￥]|厂家现货|规格|尺寸|材质|款式/.test(candidate.text || '');
  const canTrustListSummary = !!listSummary && !/^(现在|刚刚|\d+分钟前|\d+小时前)$/.test(listSummary) && (!/^https?:\/\//.test(listSummary) || listHasProductLink);

  if (effectiveReadResult.lastSide === 'self' && (canTrustListSummary || listHasProductLink || listHasCardSignal)) {
    question = listSummary;
    log('using left-list summary as customer message', {
      conversation: candidate.name,
      listSummary,
      rightLastText: effectiveReadResult.lastText || '',
      listHasProductLink,
      listHasCardSignal
    });
  }

  if (effectiveReadResult.lastSide === 'self' && !canTrustListSummary && !listHasProductLink && !listHasCardSignal && !productCardOnly) {
    if (storedHandled.lastListFingerprint === listFingerprint) {
      log('skip conversation because unread list fingerprint already handled', { conversation: candidate.name, listText: candidate.text || '' });
      return { sent: false, skipped: true, lastSide: 'self', listHandled: true };
    }
    log('keep conversation pending because right pane not refreshed yet', { conversation: candidate.name, listText: candidate.text || '', rightLastText: effectiveReadResult.lastText || '' });
    return { sent: false, skipped: true, pendingRefresh: true };
  }

  if (!question && !productCardOnly) {
    if (storedHandled.lastListFingerprint === listFingerprint) {
      log('skip conversation because no clean customer question and list fingerprint already handled', { conversation: candidate.name, listText: candidate.text || '' });
      return { sent: false, skipped: true, emptyQuestion: true, listHandled: true };
    }
    if (canTrustListSummary) {
      question = listSummary;
      log('fallback to left-list summary because right pane question empty', { conversation: candidate.name, listSummary });
    } else {
      log('skip conversation because no clean customer question', { conversation: candidate.name, lastSide: effectiveReadResult.lastSide, lastText: effectiveReadResult.lastText || '' });
      return { sent: false, skipped: true, emptyQuestion: true };
    }
  }

  if (question && isAcknowledgementOnly(question)) {
    const ackReply = '好的亲，您有问题可以再联系我';
    const sent = await sendReply(frame, ackReply);
    state.handled = state.handled || {};
    state.handled[candidate.name] = {
      ...storedHandled,
      lastCustomerFingerprint: fingerprintCustomerMessage(candidate.name, question),
      lastListFingerprint: listFingerprint,
      lastSelfFingerprint: fingerprintCustomerMessage(candidate.name, ackReply),
      lastQuestion: question,
      lastReply: ackReply,
      source: 'ack_reply',
      knowledge_base_hit: true,
      handledAt: new Date().toISOString()
    };
    log('reply acknowledgement-only message', { conversation: candidate.name, question, sent: !!sent.ok, reply: ackReply });
    if (sent.ok) await refreshWorkbench(page);
    return { sent: !!sent.ok, source: 'ack_reply', reply: ackReply };
  }

  const fingerprint = fingerprintCustomerMessage(candidate.name, productCardOnly ? `[product-card-only]|${listFingerprint}` : question);
  if (shouldSkipByStartupBaseline(state, candidate.name, fingerprint)) {
    log('skip startup baseline message', { conversation: candidate.name, question });
    return { sent: false, skipped: true, startupBaseline: true };
  }
  if (storedHandled.lastCustomerFingerprint === fingerprint || storedHandled.lastListFingerprint === listFingerprint) {
    log('skip duplicate customer message', { conversation: candidate.name, question, listText: candidate.text || '' });
    return { sent: false, skipped: true, duplicate: true };
  }

  const kbHit = matchKnowledgeBase(question);
  const productCardContext = getProductCardContext(effectiveReadResult);
  const savedProductContext = isFreshProductContext(storedHandled.lastProductContext) ? storedHandled.lastProductContext : null;
  const productLink = extractProductLink(
    question,
    effectiveReadResult.messages,
    effectiveReadResult.customerProductCardTexts,
    effectiveReadResult.debugTail,
    candidate.text,
    savedProductContext?.link || '',
    savedProductContext?.title || '',
    ...(savedProductContext?.texts || [])
  );
  let reply = '';
  let source = 'llm';
  let knowledgeBaseHit = false;
  let currentProductContext = savedProductContext ? { ...savedProductContext } : null;

  if (!currentProductContext && productLink) {
    currentProductContext = {
      link: productLink,
      title: productCardContext.title || '',
      texts: productCardContext.texts || [],
      snapshotText: '',
      savedAt: new Date().toISOString()
    };
    log('seed_product_context_from_link', { conversation: candidate.name, link: productLink, title: currentProductContext.title || '' });
  }

  if (productCardOnly) {
    if (productLink) {
      currentProductContext = await buildProductContextFromLink(page, gatewayToken, candidate.name, productLink, productCardContext, question);
      if (storedHandled.pendingProductQuestion && isProductQuestion(storedHandled.pendingProductQuestion)) {
        question = storedHandled.pendingProductQuestion;
        reply = await generateProductReplyWithOpenClaw(gatewayToken, {
          customerQuestion: question,
          productKnowledge: currentProductContext.knowledge || {}
        });
        source = 'product_lookup_from_pending_question';
        knowledgeBaseHit = true;
        log('product_card_bound_to_pending_question', { conversation: candidate.name, question, productTitle: currentProductContext.title || '' });
      } else {
        reply = await generateProductReplyWithOpenClaw(gatewayToken, {
          customerQuestion: '客户刚发送了商品卡片，请基于结构化商品知识先做接待式回复，主动说明可以咨询规格、尺寸、材质、发货等信息。',
          productKnowledge: currentProductContext.knowledge || {}
        });
        source = 'product_lookup';
        knowledgeBaseHit = true;
        log('product_card_lookup', { conversation: candidate.name, productTitle: currentProductContext.title || '' });
      }
    } else if (savedProductContext && storedHandled.pendingProductQuestion && isProductQuestion(storedHandled.pendingProductQuestion)) {
      question = storedHandled.pendingProductQuestion;
      reply = await generateProductReplyWithOpenClaw(gatewayToken, {
        customerQuestion: question,
        productKnowledge: savedProductContext.knowledge || {}
      });
      source = 'saved_product_context';
      knowledgeBaseHit = true;
      currentProductContext = { ...savedProductContext, savedAt: new Date().toISOString() };
      log('reuse_saved_product_context_for_card', { conversation: candidate.name, question, productTitle: savedProductContext.title || '' });
    } else {
      currentProductContext = {
        link: '',
        title: productCardContext.title || '',
        texts: productCardContext.texts || [],
        snapshotText: '',
        savedAt: new Date().toISOString()
      };
      reply = '亲，收到您发的商品卡片了，您想看尺寸、材质、规格还是发货信息呢？';
      source = 'kb';
      knowledgeBaseHit = true;
      log('knowledge_base_hit', { conversation: candidate.name, rule: 'product_card_only_intent', mode: 'auto_reply_no_link' });
    }
  }

  if (!reply && kbHit) {
    knowledgeBaseHit = true;
    if (kbHit.mode === 'auto_reply') {
      reply = kbHit.reply;
      source = 'kb';
      log('knowledge_base_hit', { conversation: candidate.name, rule: kbHit.id, mode: kbHit.mode });
    } else if (kbHit.mode === 'notify_human') {
      const notified = await notifyHuman(gatewayToken, {
        customerName: candidate.name,
        customerQuestion: question,
        productTitle: productLink || ''
      });
      state.handled = state.handled || {};
      state.handled[candidate.name] = {
        ...storedHandled,
        lastCustomerFingerprint: fingerprint,
        lastListFingerprint: listFingerprint,
        lastQuestion: question,
        lastReply: '',
        source: 'human_notify',
        knowledge_base_hit: true,
        pendingProductQuestion: isProductQuestion(question) ? question : (storedHandled.pendingProductQuestion || ''),
        lastProductContext: currentProductContext || storedHandled.lastProductContext || null,
        handledAt: new Date().toISOString(),
        notified
      };
      log('notify_human', { conversation: candidate.name, rule: kbHit.id, notified });
      return { sent: false, source: 'human_notify', notified };
    } else if (kbHit.mode === 'require_product_link') {
      if (savedProductContext && isProductQuestion(question)) {
        reply = await generateProductReplyWithOpenClaw(gatewayToken, {
          customerQuestion: question,
          productKnowledge: savedProductContext.knowledge || {}
        });
        source = 'saved_product_context';
        currentProductContext = { ...savedProductContext, savedAt: new Date().toISOString() };
        log('reuse_saved_product_context', { conversation: candidate.name, rule: kbHit.id, question, productTitle: savedProductContext.title || '' });
      } else if (productLink || productCardContext.title) {
        if (productLink) {
          currentProductContext = await buildProductContextFromLink(page, gatewayToken, candidate.name, productLink, productCardContext, question);
          reply = await generateProductReplyWithOpenClaw(gatewayToken, {
            customerQuestion: question,
            productKnowledge: currentProductContext.knowledge || {}
          });
          source = 'product_lookup';
          log('product_detail_lookup', { conversation: candidate.name, rule: kbHit.id, productTitle: currentProductContext.title || '' });
        } else {
          reply = await generateReplyWithOpenClaw(gatewayToken, {
            conversationName: candidate.name,
            customerQuestion: `${question}\n商品卡片信息：${(productCardContext.texts || []).join(' / ')}`,
            messages: [...effectiveReadResult.messages, ...(effectiveReadResult.customerProductCardTexts || [])]
          });
          source = 'llm_card_context';
          log('product_card_context_fallback', { conversation: candidate.name, rule: kbHit.id, productTitle: productCardContext.title || '' });
        }
      } else {
        reply = kbHit.reply;
        source = 'kb';
        log('require_product_link', { conversation: candidate.name, rule: kbHit.id, reason: 'truly_missing_product_context' });
      }
    } else if (kbHit.mode === 'product_detail_lookup') {
      if (!productLink && !productCardContext.title) {
        reply = '亲，麻烦您发一下商品链接或者产品卡片给我，这边帮您看下具体信息哦';
        source = 'kb';
        log('require_product_link', { conversation: candidate.name, rule: kbHit.id, reason: 'missing_link' });
      } else if (productLink) {
        currentProductContext = await buildProductContextFromLink(page, gatewayToken, candidate.name, productLink, productCardContext, question);
        reply = await generateProductReplyWithOpenClaw(gatewayToken, {
          customerQuestion: question,
          productKnowledge: currentProductContext.knowledge || {}
        });
        source = 'product_lookup';
        log('product_detail_lookup', { conversation: candidate.name, rule: kbHit.id, productTitle: currentProductContext.title || '' });
      } else {
        reply = await generateReplyWithOpenClaw(gatewayToken, {
          conversationName: candidate.name,
          customerQuestion: `${question}\n商品卡片信息：${(productCardContext.texts || []).join(' / ')}`,
          messages: [...effectiveReadResult.messages, ...(effectiveReadResult.customerProductCardTexts || [])]
        });
        source = 'llm_card_context';
        log('product_card_context_fallback', { conversation: candidate.name, rule: kbHit.id, productTitle: productCardContext.title || '' });
      }
    }
  }

  if (!reply) {
    if (productLink && !isProductQuestion(question) && !productCardOnly) {
      reply = '好的亲，链接我这边收到了，您想咨询这款的尺寸、材质、规格、库存还是发货呢？';
      source = 'product_context_seed';
      log('product_context_seed_reply', { conversation: candidate.name, link: productLink });
    } else if (!kbHit || kbHit.mode === 'fallback_llm' || isComplexQuestion(question, readResult.messages)) {
      reply = await generateReplyWithOpenClaw(gatewayToken, {
        conversationName: candidate.name,
        customerQuestion: question,
        messages: effectiveReadResult.messages
      });
      source = 'llm';
      log('fallback_llm', { conversation: candidate.name });
    }
  }

  const sent = await sendReply(frame, reply);
  if (sent.ok) {
    state.handled = state.handled || {};
    state.handled[candidate.name] = {
      ...storedHandled,
      lastCustomerFingerprint: fingerprint,
      lastListFingerprint: listFingerprint,
      lastSelfFingerprint: fingerprintCustomerMessage(candidate.name, reply),
      lastQuestion: question,
      lastReply: reply,
      source,
      knowledge_base_hit: knowledgeBaseHit,
      pendingProductQuestion: source === 'kb' && /发一下商品链接或者产品卡片/.test(reply) ? question : '',
      lastProductContext: currentProductContext || storedHandled.lastProductContext || null,
      handledAt: new Date().toISOString()
    };
    await refreshWorkbench(page);
  }
  log('processed', { conversation: candidate.name, source, sent: !!sent.ok, reply });
  return { sent: !!sent.ok, source, reply };
}

async function processOnce() {
  const state = loadJson(STATE_PATH, { handled: {}, startupBaseline: {}, lastRunAt: null });
  const { browser, gatewayToken } = await connectRelay();
  try {
    const page = pickPage(browser);
    await assertWorkbench(page);
    const frame = pickBusinessFrame(page);

    if (!state.lastRunAt) {
      const unreadForBaseline = await findUnreadConversation(frame);
      for (const item of unreadForBaseline) {
        state.startupBaseline[item.name] = state.startupBaseline[item.name] || fingerprintCustomerMessage(item.name, item.text || item.name);
      }
      state.lastRunAt = new Date().toISOString();
      saveJson(STATE_PATH, state);
      log('startup baseline captured');
      return;
    }

    const unread = await findUnreadConversation(frame);
    if (!unread.length) {
      log('no unread conversation found', { debugBadges: unread.debugBadges || [] });
      state.lastRunAt = new Date().toISOString();
      saveJson(STATE_PATH, state);
      return;
    }

    log('unread candidates', unread.map(x => ({ name: x.name, badge: x.badge, text: x.text, top: x.top, priority: x.priority })));
    for (const candidate of unread.sort((a, b) => a.top - b.top)) {
      await openConversation(frame, candidate);
      const locked = await confirmConversationLocked(frame, candidate);
      if (!locked.ok) {
        log('conversation not locked after open', { conversation: candidate.name, ...locked });
        continue;
      }
      const readResult = await readRecentMessages(frame);
      log('opened conversation snapshot', { conversation: candidate.name, lastSide: readResult.lastSide, lastText: readResult.lastText || '', debugTail: readResult.debugTail || [] });
      const result = await handleConversation(page, frame, gatewayToken, candidate, readResult, state);
      state.lastRunAt = new Date().toISOString();
      saveJson(STATE_PATH, state);
      if (result.sent) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  log('kf1688 daemon start');
  while (true) {
    try {
      await processOnce();
    } catch (err) {
      log('loop error', err.message || String(err));
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  if (!acquireSingletonLock()) process.exit(0);
  main().catch(err => {
    log('fatal', err.message || String(err));
    process.exit(1);
  });
}
