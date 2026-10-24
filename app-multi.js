/* ==========================================================================
   集团人力近期重点工作进度表 · 多用户 / 记一笔进展 / 新建任务 / 进度面板
   --------------------------------------------------------------------------
   · 零依赖、零构建、零外链、零 CDN。ES2017+（不用可选链 / 空值合并）。
   · 只读 app.js 暴露的 window.HPS，不改 app.js 的任何行为。
   · 接口严格按 docs/API契约.md：
       GET  /api/session   POST /api/login   GET /api/data
       POST /api/progress  POST /api/tasks   POST /api/void   GET /api/panel
   · 服务端不可达 → 离线只读模式：隐藏全部写 UI，面板改用 window.HR_DATA 自算。
   ========================================================================== */
(function () {
  'use strict';

  /* 在 app.js 的 init() 改写 hash 之前，先把用户原本要去的路由记下来 */
  var INITIAL_HASH = window.location.hash || '';

  /* ---------------------------------------------------------------------
     0. 小工具
     --------------------------------------------------------------------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function H() { return window.HPS || null; }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDay(d) {
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtMD(d) {
    if (!d) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 'YYYY-MM-DD 00:00:00' / 'YYYY-MM-DD' → 'YYYY-MM-DD' */
  function fmtDateStr(s) {
    var d = parseDate(s);
    return d ? fmtDay(d) : (s ? String(s).slice(0, 10) : '');
  }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }

  function today() {
    var h = H();
    if (h && h.today) return h.today;
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function byText(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN');
  }

  function splitNames(s) {
    if (!s) return [];
    return String(s).split(/[\n\r、，,;；\/]+/)
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });
  }

  function moduleColor(mod) {
    var h = H();
    if (h && h.moduleColor) return h.moduleColor(mod);
    return '#718096';
  }

  function modelItems() {
    var h = H();
    if (!h || !h.model) return [];
    var m = h.model;
    /* app.js 的 HPS.model 是 { models: [...], flags: {...} }；兼容直接给数组的情况 */
    if (Array.isArray(m)) return m;
    if (m.models && Array.isArray(m.models)) return m.models;
    return [];
  }

  function findItem(name) {
    var items = modelItems(), out = null;
    items.forEach(function (it) { if (it.name === name) out = it; });
    return out;
  }

  /** 事项的分项名列表（按源表出现顺序） */
  function itemSubs(item) {
    if (!item) return [];
    if (item.subs && item.subs.length) {
      return item.subs.map(function (s) { return s.name; });
    }
    var out = [];
    (item.rows || []).forEach(function (r) {
      var s = r['分项'];
      if (out.indexOf(s) === -1) out.push(s);
    });
    return out.length ? out : [item.name];
  }

  function itemHasRecordOn(item, sub, dateStr) {
    var found = false;
    (item.rows || []).forEach(function (r) {
      if (r['分项'] === sub && String(r['进展日期'] || '').slice(0, 10) === dateStr) found = true;
    });
    return found;
  }

  function itemAnyRecordOn(item, dateStr) {
    var found = false;
    (item.rows || []).forEach(function (r) {
      if (String(r['进展日期'] || '').slice(0, 10) === dateStr) found = true;
    });
    return found;
  }

  /** 该事项在指定日期还没记过的第一个分项 */
  function defaultSub(item, dateStr) {
    var subs = itemSubs(item);
    for (var i = 0; i < subs.length; i++) {
      if (!itemHasRecordOn(item, subs[i], dateStr)) return subs[i];
    }
    return subs[0];
  }

  function lastProgressOf(item) {
    if (!item) return null;
    if (item.latest && item.latest.date) return parseDate(item.latest.date);
    var best = null;
    (item.rows || []).forEach(function (r) {
      if (!String(r['进展内容'] || '').trim()) return;
      var d = parseDate(r['进展日期']);
      if (d && (!best || d > best)) best = d;
    });
    return best;
  }

  function daysSinceLast(item) {
    var d = lastProgressOf(item);
    if (!d) return 9999;
    return daysBetween(d, today());
  }

  function relativeDay(d) {
    if (!d) return '从未';
    var n = daysBetween(d, today());
    if (n <= 0) return '今天';
    if (n === 1) return '昨天';
    return n + ' 天前';
  }

  /* ---------------------------------------------------------------------
     1. 全局状态
     --------------------------------------------------------------------- */

  var S = {
    session: null,       // /api/session 的返回
    me: null,            // 当前登录人
    members: [],         // 可登录成员
    online: false,       // API 是否可达
    ready: false,        // 身份请求是否已有结论（成功或失败）
    serverItems: null,   // /api/data 返回的可见事项名（数据范围）
    dataStamp: '',       // 服务端数据截至
    panel: null,         // 当前面板数据
    panelSource: '',     // 'server' | 'local'
    routeActive: false,
    routeReturn: 'items',
    newItemDraft: null,  // 新建任务成功后待记的第一条进展上下文
    injected: false
  };

  var PM = {              // 记一笔进展的上下文
    open: false,
    item: null,
    sub: '',
    date: '',
    progress: '',
    plan: '',
    planOpen: false,
    busy: false,
    lastFocus: null
  };

  var NT = {              // 新建任务表单
    module: '',
    nature: '',
    item: '',
    itemIsNew: false,
    subs: [],
    intro: '',
    start: '',
    end: '',
    owners: [],
    lead: '',
    leadType: '',
    note: '',
    errors: {},
    busy: false
  };

  /* ---------------------------------------------------------------------
     2. API 层（零依赖，fetch + 超时）
     --------------------------------------------------------------------- */

  var API_TIMEOUT = 9000;

  function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store'
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('timeout'));
      }, API_TIMEOUT);
      fetch(path, init).then(function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          resolve({ status: res.status, ok: res.ok, data: data || {} });
        });
      }).catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /* ---------------------------------------------------------------------
     3. 横幅（#banners）
     --------------------------------------------------------------------- */

  function bannerHost() { return $('#banners'); }

  function setBanner(id, html, cls) {
    var host = bannerHost();
    if (!host) return null;
    var el = $('#' + id, host);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'banner';
      host.appendChild(el);
    }
    el.className = 'banner' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
    return el;
  }

  function removeBanner(id) {
    var el = $('#' + id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showOfflineBanner() {
    var h = H();
    var stamp = S.dataStamp || (h && h.dataAsOf ? fmtDateStr(h.dataAsOf) : '');
    var stampTxt = stamp ? ('（数据截至 ' + stamp + '）') : '';
    setBanner('am-offline',
      '<span><strong>离线只读模式</strong>：无法连接服务端' + esc(stampTxt) +
      '，写入功能暂不可用；下方数据来自本地快照 <code>data/rows.js</code>。</span>',
      'banner--warn');
  }

  function clearOfflineBanner() { removeBanner('am-offline'); }

  var toastTimer = null;
  function showToast(html, ms) {
    var el = setBanner('am-toast', html, 'banner--info');
    if (!el) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { removeBanner('am-toast'); }, ms || 5000);
  }

  /* ---------------------------------------------------------------------
     4. 身份胶囊（§2.7）
     --------------------------------------------------------------------- */

  var ROLE_LABEL = { admin: '管理员', editor: '编辑', viewer: '只读' };
  var ROLE_CLASS = { admin: 'badge--doing', editor: 'badge', viewer: 'badge--muted' };

  function firstChar(name) {
    var s = String(name || '?').trim();
    return s ? s.charAt(0) : '?';
  }

  function renderIdentity() {
    var host = $('#identity');
    if (!host) return;

    /* 身份还没拿到（首屏 / 请求中）→ 骨架，不渲染任何写按钮 */
    if (!S.ready) {
      host.innerHTML = '<span class="identity__inner">' +
        '<span class="identity__skeleton" aria-hidden="true"></span>' +
        '<span class="identity__caps">识别中…</span></span>';
      return;
    }

    /* 服务端不可达 → 离线只读 */
    if (!S.online) {
      host.innerHTML = '<span class="identity__inner">' +
        '<span class="identity__avatar" aria-hidden="true">–</span>' +
        '<span class="identity__name">离线</span>' +
        '<span class="badge badge--muted">只读</span>' +
        '<span class="identity__caps">写入不可用</span></span>';
      return;
    }

    if (S.me) {
      var role = S.me.role || 'viewer';
      host.innerHTML = '<span class="identity__inner">' +
        '<span class="identity__avatar" aria-hidden="true">' + esc(firstChar(S.me.name)) + '</span>' +
        '<span class="identity__name">' + esc(S.me.name) + '</span>' +
        '<span class="badge ' + (ROLE_CLASS[role] || 'badge') + '">' +
          esc(ROLE_LABEL[role] || role) + '</span>' +
        '<span class="identity__caps">可写 ' + esc(String(S.me.canWriteCount || 0)) + ' 个事项</span>' +
        '</span>';
      return;
    }

    host.innerHTML = '<span class="identity__inner">' +
      '<span class="identity__avatar" aria-hidden="true">?</span>' +
      '<button class="btn btn--ghost" id="btn-login" type="button" ' +
        'aria-expanded="false" aria-controls="identity-login">登录</button>' +
      '</span>' +
      '<div class="identity__login" id="identity-login" hidden>' +
        '<p class="field__label">以谁的身份进入</p>' +
        '<div class="identity__form">' +
          '<select class="control" id="login-member"></select>' +
          '<button class="btn" id="login-go" type="button">登录</button>' +
          '<p class="identity__err" id="login-err" role="alert" hidden></p>' +
        '</div>' +
      '</div>';

    var sel = $('#login-member');
    sel.innerHTML = S.members.length
      ? S.members.map(function (m) {
          return '<option value="' + esc(m.name) + '">' + esc(m.name) + '（' +
            esc(ROLE_LABEL[m.role] || m.role) + '）</option>';
        }).join('')
      : '<option value="">（没有可选成员）</option>';

    $('#btn-login').addEventListener('click', function () {
      var box = $('#identity-login');
      var open = box.hidden;
      box.hidden = !open;
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) sel.focus();
    });

    $('#login-go').addEventListener('click', function () { doLogin(sel.value); });
    sel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(sel.value); }
    });
  }

  function doLogin(name) {
    var err = $('#login-err');
    if (err) { err.hidden = true; err.textContent = ''; }
    if (!name) {
      if (err) { err.hidden = false; err.textContent = '请先选择一个成员。'; }
      return;
    }
    api('/api/login', { method: 'POST', body: { name: name } }).then(function (res) {
      if (!res.ok) {
        if (err) {
          err.hidden = false;
          err.textContent = (res.data && res.data.detail) ? res.data.detail : '登录失败（' + res.status + '）。';
        }
        return;
      }
      S.me = res.data.me || null;
      refreshSession().then(function () {
        applyWriteGates();
        renderIdentity();
      });
    }).catch(function () {
      if (err) { err.hidden = false; err.textContent = '网络异常，登录未成功。'; }
    });
  }

  function refreshSession() {
    return api('/api/session').then(function (res) {
      if (!res.ok) throw new Error('session ' + res.status);
      S.session = res.data;
      S.me = res.data.me || null;
      S.members = res.data.members || [];
      S.dataStamp = res.data.dataStamp || '';
      S.online = true;
      clearOfflineBanner();
      return res.data;
    });
  }

  /* ---------------------------------------------------------------------
     5. 写权限闸门（契约 §2.1）
        没有写权限的按钮一律不渲染，不用 disabled。
     --------------------------------------------------------------------- */

  function canWrite(item) {
    if (!S.online || !S.me) return false;
    var role = S.me.role;
    if (role === 'viewer') return false;
    if (role === 'admin') return true;
    if (!item) return false;
    var owners = item.ownerNames || splitNames(item.ownerRaw);
    if (owners.indexOf(S.me.name) !== -1) return true;
    if (item.lead && item.lead === S.me.name) return true;
    return false;
  }

  function canWriteByName(name) {
    if (!S.online || !S.me) return false;
    if (S.me.role === 'admin') return true;
    if (S.me.role === 'viewer') return false;
    var it = findItem(name);
    return canWrite(it);
  }

  function canCreateTask() {
    if (!S.online || !S.me) return false;
    var caps = (S.session && S.session.capabilities) || {};
    if (caps.createTask !== undefined) return !!caps.createTask;
    return S.me.role === 'admin' || S.me.role === 'editor';
  }

  /** 隐藏所有没有权限的写入口（写按钮一律不渲染） */
  function applyWriteGates() {
    var showWrite = !!(S.online && S.me && S.me.role !== 'viewer');
    var showNew = canCreateTask();

    var bp = $('#btn-progress');
    if (bp) bp.hidden = !showWrite;
    var bn = $('#btn-newtask');
    if (bn) bn.hidden = !showNew;

    var hint = $('#actionbar-hint');
    if (hint) {
      hint.hidden = !showWrite;
    }

    /* 一个写入口都没有时，整条操作条不渲染（不留空条） */
    var bar = $('#actionbar');
    if (bar) bar.hidden = !(showWrite || showNew);

    injectRowPluses();
    if (S.panel) renderPanel();
  }

  /* ---- 行内「＋」入口（事项行 / 分项组） ---- */

  function injectRowPluses() {
    var tbody = $('#tbody-items');
    if (!tbody) return;
    if (!S.online || !S.me || S.me.role === 'viewer') {
      $$('[data-pm-item]', tbody).forEach(function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      return;
    }
    $$('tr.item-row', tbody).forEach(function (tr) {
      if (tr.querySelector('[data-pm-item]')) return;
      var name = tr.getAttribute('data-item');
      var item = findItem(name);
      if (!item || !canWrite(item)) return;
      var flags = $('.rowflags', tr);
      if (!flags) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rowplus';
      btn.setAttribute('data-pm-item', name);
      btn.title = '给这个事项记一笔进展';
      btn.setAttribute('aria-label', '给「' + name + '」记一笔进展');
      btn.textContent = '＋';
      flags.appendChild(btn);
    });
    $$('.expand__ghead', tbody).forEach(function (head) {
      if (head.querySelector('[data-pm-item]')) return;
      var gnameEl = $('.expand__gname', head);
      if (!gnameEl) return;
      var gname = gnameEl.textContent;
      var tr = head.closest ? head.closest('tr.item-expand') : null;
      var item = null;
      if (tr) {
        var prev = tr.previousElementSibling;
        if (prev) item = findItem(prev.getAttribute('data-item'));
      }
      if (!item) {
        var all = modelItems(), k = null;
        all.forEach(function (it) { if (it.subs) it.subs.forEach(function (s) { if (s.name === gname) k = it; }); });
        item = k;
      }
      if (!item || !canWrite(item)) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rowplus rowplus--text';
      btn.setAttribute('data-pm-item', item.name);
      btn.setAttribute('data-pm-sub', gname);
      btn.textContent = '＋ 记一笔';
      var count = $('.expand__gcount', head);
      if (count) head.insertBefore(btn, count); else head.appendChild(btn);
    });
  }

  /* ---------------------------------------------------------------------
     6. 记一笔进展（§4）
     --------------------------------------------------------------------- */

  function pmStatus(text, extraHtml) {
    var box = $('#pm-status');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<span>' + esc(text) + '</span>' + (extraHtml || '');
    var btn = $('#pm-end', box);
    if (btn) {
      btn.addEventListener('click', function () { closeProgress(); });
    }
    var vb = $('#pm-void', box);
    if (vb) {
      vb.addEventListener('click', function () {
        doVoid(vb.getAttribute('data-void-item'), vb.getAttribute('data-void-sub'),
          vb.getAttribute('data-void-date'));
      });
    }
  }

  function pmClearStatus() {
    var box = $('#pm-status');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
  }

  function endBtn() {
    return '<button class="btn btn--ghost" id="pm-end" type="button">结束</button>';
  }

  /** 作废按钮（§4.9）：源表只能 append，作废 = 追加一条【作废】标记，不是删除 */
  function voidBtn(itemName, sub, dateStr) {
    if (!canWriteByName(itemName)) return '';
    return '<button class="btn btn--ghost" id="pm-void" type="button" data-void-item="' + esc(itemName) +
      '" data-void-sub="' + esc(sub) + '" data-void-date="' + esc(dateStr) + '">作废</button>';
  }

  function doVoid(itemName, sub, dateStr) {
    if (!window.confirm('作废这一条？\n源表只能追加行，作废会在源表里追一条【作废】标记（不会被抹掉）。')) return;
    api('/api/void', {
      method: 'POST',
      body: { item: itemName, sub: sub, date: dateStr, reason: '网页端提交后作废' }
    }).then(function (res) {
      if (res.status === 200 && res.data && res.data.ok) {
        localRemove(itemName, sub, dateStr);
        pmStatus('已作废 ' + dateStr + ' ' + sub + '（源表已追加作废标记）', endBtn());
        renderProgressForm();
        if (S.panel) renderPanel();
        return;
      }
      if (res.status === 403) {
        pmError('作废失败：只有管理员，或 24 小时内自己写入的人，才能作废这一条。');
        return;
      }
      pmError('作废失败：' + ((res.data && res.data.detail) ? res.data.detail : ('服务异常（' + res.status + '）')));
    }).catch(function () {
      pmError('作废失败：网络异常。');
    });
  }

  /** 本地把这行撤掉（源表里那条【作废】标记会被当作一条进展读回来，所以只撤原文那一行） */
  function localRemove(itemName, sub, dateStr) {
    var item = findItem(itemName);
    if (!item) return;
    function isVoidMarker(r) {
      return String(r['进展内容'] || '').indexOf('【作废】') !== -1;
    }
    function sameSlot(r) {
      return r['分项'] === sub && String(r['进展日期'] || '').slice(0, 10) === dateStr;
    }
    item.rows = (item.rows || []).filter(function (r) {
      return isVoidMarker(r) || !sameSlot(r);
    });
    (item.subs || []).forEach(function (s) {
      s.rows = (s.rows || []).filter(function (r) {
        return isVoidMarker(r) || !sameSlot(r);
      });
    });
    var best = null;
    item.rows.forEach(function (r) {
      if (!String(r['进展内容'] || '').trim()) return;
      if (!best || String(r['进展日期']) > String(best['进展日期'])) best = r;
    });
    item.latest = best ? { date: best['进展日期'], content: best['进展内容'], row: best } : null;
    item.state = localState(item);
    var h = H();
    if (h && h.render) h.render();
  }

  function pmError(text) {
    var box = $('#pm-error');
    if (!box) return;
    if (!text) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = text;
  }

  function pmConflict(html) {
    var box = $('#pm-conflict');
    if (!box) return;
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = html;
  }

  function writableItems() {
    return modelItems().filter(function (it) { return canWrite(it); });
  }

  function openProgress(ctx) {
    ctx = ctx || {};
    if (!S.online) {
      showToast('<span><strong>离线只读模式</strong>：写操作需要连接服务端。</span>', 4000);
      return;
    }
    if (!S.me) {
      showToast('<span>请先在右上角登录后再记进展。</span>', 4000);
      var btn = $('#btn-login');
      if (btn) btn.click();
      return;
    }
    if (S.me.role === 'viewer') {
      showToast('<span>你是只读用户，查看与导出可用，不能写入。</span>', 4000);
      return;
    }

    PM.item = ctx.item || null;
    PM.sub = ctx.sub || '';
    PM.date = ctx.date || fmtDay(today());
    PM.progress = '';
    PM.plan = '';
    PM.planOpen = false;
    PM.busy = false;
    PM.lastFocus = document.activeElement;

    pmClearStatus();
    pmError('');
    pmConflict('');

    renderProgressForm();

    var modal = $('#progress-modal');
    modal.hidden = false;
    PM.open = true;

    var first = $('#pm-progress');
    if (first) first.focus();
  }

  function closeProgress() {
    var modal = $('#progress-modal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    PM.open = false;
    pmClearStatus();
    pmError('');
    pmConflict('');
    syncKb();
    if (PM.lastFocus && PM.lastFocus.focus) {
      try { PM.lastFocus.focus(); } catch (e) { /* noop */ }
    }
  }

  function renderProgressForm() {
    var host = $('#pm-form');
    if (!host) return;
    var item = PM.item;
    var items = writableItems();

    var ctxBox = $('#pm-ctx');
    if (ctxBox) {
      if (item) {
        ctxBox.className = 'pm__ctx';
        ctxBox.innerHTML =
          '<span class="moddot" data-mod="' + esc(item.module) + '" aria-hidden="true"></span>' +
          '<span class="pm__ctxname">' + esc(item.name) + '</span>' +
          '<span class="pm__ctxmeta">责任人 ' + esc(item.ownerRaw || '—') +
          ' · 负责人 ' + esc(item.lead || '—') +
          ' · ' + esc(item.startRaw ? fmtDateStr(item.startRaw) : '—') +
          ' → ' + esc(item.endRaw ? fmtDateStr(item.endRaw) : '—') +
          '</span>';
      } else {
        ctxBox.className = 'pm__ctx pm__ctx--empty';
        ctxBox.textContent = '先选一个事项，再写今天推进到哪一步了。';
      }
    }

    var itemOptions = '<option value="">— 请选择事项 —</option>' + items.map(function (it) {
      return '<option value="' + esc(it.name) + '"' + (item && it.name === item.name ? ' selected' : '') + '>' +
        esc(it.name) + '</option>';
    }).join('');

    var minDate = fmtDay(addDays(today(), -90));
    var maxDate = fmtDay(today());

    var subHtml;
    if (!item) {
      subHtml = '<span class="pm__chip" style="justify-self:start">先选事项</span>';
    } else {
      var subs = itemSubs(item);
      if (subs.length <= 1) {
        subHtml = '<span class="pm__chip" id="pm-sub-chip" title="该事项只有 1 个分项" style="justify-self:start">' +
          esc(subs[0]) + '</span>';
      } else {
        subHtml = '<select class="control" id="pm-sub">' + subs.map(function (s) {
          var has = itemHasRecordOn(item, s, PM.date);
          return '<option value="' + esc(s) + '"' + (s === PM.sub ? ' selected' : '') + '>' +
            esc(s) + (has ? '（今天已有）' : '') + '</option>';
        }).join('') + '</select>';
      }
    }

    var recent = '';
    if (item) {
      var rows = (item.rows || []).filter(function (r) {
        return String(r['进展内容'] || '').trim();
      }).slice(-3).reverse();
      recent = '<details class="pm__recent"><summary>最近进展（该事项）</summary>' +
        '<div class="pm__recentlist">' + (rows.length
          ? rows.map(function (r) {
              return '<div class="pm__recentrow"><b>' + esc(String(r['进展日期'] || '').slice(0, 10)) + '</b>' +
                esc(String(r['进展内容']).slice(0, 60)) + '</div>';
            }).join('')
          : '<div class="pm__recentrow">还没有进展记录。</div>') +
        '</div></details>';
    }

    host.innerHTML =
      '<div class="pm__field pm__field--full">' +
        '<label class="pm__label" for="pm-item">事项</label>' +
        '<select class="control" id="pm-item">' + itemOptions + '</select>' +
      '</div>' +
      '<div class="pm__grid">' +
        '<span class="pm__label" for="pm-date">日期</span>' +
        '<input class="control" id="pm-date" type="date" value="' + esc(PM.date) + '" min="' +
          esc(minDate) + '" max="' + esc(maxDate) + '">' +
        '<span class="pm__label" for="pm-sub">分项</span>' +
        subHtml +
      '</div>' +
      '<div class="pm__field pm__field--full">' +
        '<label class="pm__label" for="pm-progress">进展内容</label>' +
        '<textarea class="pm__ta" id="pm-progress" placeholder="今天推进到哪一步了？">' +
          esc(PM.progress) + '</textarea>' +
      '</div>' +
      '<label class="pm__check"><input type="checkbox" id="pm-plan-toggle"' +
        (PM.planOpen ? ' checked' : '') + '> 同时记一条当天计划</label>' +
      '<div class="pm__field pm__field--full" id="pm-plan-wrap"' +
        (PM.planOpen ? '' : ' hidden') + '>' +
        '<label class="pm__label" for="pm-plan">当天计划</label>' +
        '<textarea class="pm__ta" id="pm-plan" placeholder="接下来要做什么？">' + esc(PM.plan) + '</textarea>' +
      '</div>' +
      recent;

    bindProgressForm();
  }

  function bindProgressForm() {
    var selItem = $('#pm-item');
    if (selItem) {
      selItem.addEventListener('change', function () {
        var name = selItem.value;
        PM.item = name ? findItem(name) : null;
        PM.sub = PM.item ? defaultSub(PM.item, PM.date) : '';
        renderProgressForm();
      });
    }

    var inpDate = $('#pm-date');
    if (inpDate) {
      inpDate.addEventListener('change', function () {
        PM.date = inpDate.value || fmtDay(today());
        if (PM.item) {
          var subs = itemSubs(PM.item);
          if (subs.length > 1) {
            var still = false;
            subs.forEach(function (s) { if (s === PM.sub) still = true; });
            if (!still) PM.sub = defaultSub(PM.item, PM.date);
          }
        }
        renderProgressForm();
      });
    }

    var selSub = $('#pm-sub');
    if (selSub) {
      selSub.addEventListener('change', function () { PM.sub = selSub.value; });
    }

    var ta = $('#pm-progress');
    if (ta) {
      ta.addEventListener('input', function () { PM.progress = ta.value; });
    }

    var taPlan = $('#pm-plan');
    if (taPlan) {
      taPlan.addEventListener('input', function () { PM.plan = taPlan.value; });
    }

    var chk = $('#pm-plan-toggle');
    if (chk) {
      chk.addEventListener('change', function () {
        PM.planOpen = chk.checked;
        var wrap = $('#pm-plan-wrap');
        if (wrap) wrap.hidden = !PM.planOpen;
        if (PM.planOpen) {
          var p = $('#pm-plan');
          if (p) p.focus();
        }
      });
    }
  }

  /** 提交一条进展。advance=true 时保存后自动切到下一条。 */
  function submitProgress(advance) {
    if (PM.busy) return;
    if (!PM.item) {
      pmError('请先选择事项。');
      return;
    }
    var sub = PM.sub;
    if (!sub) {
      var subs = itemSubs(PM.item);
      sub = subs[0];
      PM.sub = sub;
    }
    var progress = String(PM.progress || '').trim();
    var plan = String(PM.plan || '').trim();
    if (!progress && !plan) {
      pmError('进展内容与当天计划至少填一个。');
      var ta = $('#pm-progress');
      if (ta) ta.focus();
      return;
    }
    if (!PM.date) PM.date = fmtDay(today());

    PM.busy = true;
    setButtonsBusy(true);
    pmError('');
    pmConflict('');

    api('/api/progress', {
      method: 'POST',
      body: { item: PM.item.name, sub: sub, date: PM.date, progress: progress, plan: plan }
    }).then(function (res) {
      PM.busy = false;
      setButtonsBusy(false);
      var itemName = PM.item.name;
      var dateStr = PM.date;
      if (res.status === 200 && res.data && res.data.ok) {
        if (!res.data.duplicate) {
          localAppend(itemName, sub, dateStr, progress, plan);
        }
        PM.progress = '';
        PM.plan = '';
        var ta2 = $('#pm-progress');
        if (ta2) ta2.value = '';
        var tp = $('#pm-plan');
        if (tp) tp.value = '';
        if (advance) {
          var nxt = nextTarget();
          if (nxt) {
            PM.item = nxt.item;
            PM.sub = nxt.sub;
          } else {
            PM.item = null;
            PM.sub = '';
          }
          renderProgressForm();
          pmStatus('✓ 已保存 ' + PM.date + ' ' + sub + '　·　没有更多待记的分项了。',
            voidBtn(itemName, sub, dateStr) + endBtn());
        } else {
          renderProgressForm();
          pmStatus('✓ 已保存 ' + PM.date + ' ' + sub,
            voidBtn(itemName, sub, dateStr) + endBtn());
        }
        var t3 = $('#pm-progress');
        if (t3) t3.focus();
        if (S.panel) renderPanel();
        return;
      }
      if (res.status === 202 && res.data && res.data.queued) {
        pmError('源表暂时写不进去，这条已进入服务端重试队列（队列号 ' +
          esc(String(res.data.queueId || '')) + '），内容没有丢。');
        return;
      }
      if (res.status === 409) {
        showConflict(res.data);
        return;
      }
      if (res.status === 401) {
        pmError('登录已过期，请重新登录后再保存。');
        return;
      }
      if (res.status === 403) {
        pmError('你没有权限给「' + PM.item.name + '」记进展 —— 你不是该事项的责任人或负责人。');
        return;
      }
      if (res.status === 422) {
        pmError((res.data && res.data.detail) ? res.data.detail : '提交内容不合规，请检查日期与内容。');
        return;
      }
      pmError('保存失败：' + ((res.data && res.data.detail) ? res.data.detail : ('服务异常（' + res.status + '）')) +
        '。内容仍在本页，可重试。');
    }).catch(function () {
      PM.busy = false;
      setButtonsBusy(false);
      pmError('保存失败：网络异常。内容仍在本页，可重试。');
    });
  }

  function setButtonsBusy(busy) {
    var s = $('#pm-save'), c = $('#pm-continue');
    if (s) { s.disabled = !!busy; s.textContent = busy ? '保存中…' : '保存'; }
    if (c) { c.disabled = !!busy; }
  }

  /** 冲突态（§6.3）：说清 冲突了什么 / 我的内容没有写入 / 下一步怎么办 */
  function showConflict(data) {
    data = data || {};
    var existing = data.existing || {};
    var mine = String(PM.progress || '').trim();
    var theirs = String(existing['进展内容'] || '').trim();
    var html = '<h4>源表里这条记录已被他人写入</h4>' +
      '<p>冲突的是什么：同一（事项「' + esc(PM.item ? PM.item.name : '') + '」，分项「' +
        esc(PM.sub) + '」，日期 ' + esc(PM.date) + '）已经有别人的进展行。</p>' +
      '<p><strong>你的内容没有写入</strong>，草稿保留在本页，可以重试。</p>' +
      '<pre id="pm-diff" hidden>源表现有：' + esc(theirs || '（空）') + '\n\n我这次写的：' + esc(mine) + '</pre>' +
      '<div class="pm__conflict__acts">' +
        '<button class="btn btn--ghost" type="button" id="pm-diff-btn">查看差异</button>' +
        '<button class="btn btn--ghost" type="button" id="pm-take-btn">以源表为准，放弃我的</button>' +
        '<button class="btn" type="button" id="pm-retry-btn">重新提交</button>' +
      '</div>';
    pmConflict(html);
    var diff = $('#pm-diff');
    $('#pm-diff-btn').addEventListener('click', function () {
      if (diff) diff.hidden = !diff.hidden;
    });
    $('#pm-take-btn').addEventListener('click', function () {
      pmConflict('');
      PM.progress = theirs;
      PM.plan = '';
      renderProgressForm();
      pmStatus('已放弃本次内容，源表现有内容已填入。');
    });
    $('#pm-retry-btn').addEventListener('click', function () {
      pmConflict('');
      submitProgress(false);
    });
  }

  /** 保存并继续：同事项的下一个分项 → 下一个今天还没记的事项 */
  function nextTarget() {
    if (PM.item) {
      var subs = itemSubs(PM.item);
      if (subs.length > 1) {
        for (var i = 0; i < subs.length; i++) {
          var s = subs[i];
          if (s === PM.sub) continue;
          if (!itemHasRecordOn(PM.item, s, PM.date)) return { item: PM.item, sub: s };
        }
      }
    }
    var cands = writableItems().filter(function (it) {
      return !itemAnyRecordOn(it, PM.date);
    });
    cands.sort(function (a, b) {
      var d = daysSinceLast(b) - daysSinceLast(a);
      if (d !== 0) return d;
      return byText(a.name, b.name);
    });
    if (cands.length) {
      return { item: cands[0], sub: defaultSub(cands[0], PM.date) };
    }
    return null;
  }

  /** 乐观更新：把刚写入的行塞进 app.js 的模型，再让它重画三视图 */
  function localAppend(itemName, sub, dateStr, progress, plan) {
    var item = findItem(itemName);
    if (!item) return;
    var row = {
      '事项序号': item.seq,
      '一级维度（六大模块）': item.module,
      '二级维度（人/流程/成本）': item.nature,
      '具体事项': item.name,
      '分项': sub,
      '分项内容简介': item.summary || '',
      '进展日期': dateStr,
      '进展内容': progress || '',
      '开始时间': item.startRaw || '',
      '完成时间': item.endRaw || '',
      '当日计划（周计划）': plan || '',
      '责任人': item.ownerRaw || '',
      '负责人': item.lead || '',
      '负责人类型': item.typ || '',
      '协调事项': item.coord || ''
    };
    item.rows.push(row);
    item.rows.sort(function (a, b) {
      var ad = String(a['进展日期'] || ''), bd = String(b['进展日期'] || '');
      return ad < bd ? -1 : (ad > bd ? 1 : 0);
    });
    var target = null;
    (item.subs || []).forEach(function (s) { if (s.name === sub) target = s; });
    if (!target) {
      target = { name: sub, intro: item.summary || '', rows: [] };
      item.subs.push(target);
    }
    target.rows.push(row);
    if (!item.latest || String(item.latest.date) < dateStr) {
      item.latest = { date: dateStr, content: progress || '', row: row };
    }
    item.state = localState(item);
    var h = H();
    if (h && h.render) h.render();
  }

  /** 与 app.js computeState() 同一口径（本地乐观更新用） */
  function localState(item) {
    var t = today();
    var end = parseDate(item.endRaw || '');
    if (end && end.getTime() < t.getTime()) {
      var done = (item.rows || []).some(function (r) {
        if (!String(r['进展内容'] || '').trim()) return false;
        var d = parseDate(r['进展日期']);
        return d && end && d.getTime() >= end.getTime();
      });
      return done
        ? { key: 'done', label: '已完成', cls: 'badge--done' }
        : { key: 'late', label: '逾期', cls: 'badge--warn' };
    }
    return { key: 'wip', label: '进行中', cls: 'badge--doing' };
  }

  /* ---------------------------------------------------------------------
     7. 新建任务（路由页 #/new-task，§3）
     --------------------------------------------------------------------- */

  var DRAFT_KEY = 'hr.newtask.draft.v2';
  var draftTimer = null;

  function moduleList() {
    var h = H();
    var mods = (h && h.MODULES) ? h.MODULES.slice() : ['人力资源规划'];
    var counts = {};
    modelItems().forEach(function (it) {
      counts[it.module] = (counts[it.module] || 0) + 1;
    });
    return mods.map(function (m) {
      return { name: m, count: counts[m] || 0 };
    });
  }

  /** 某模块下实际存在的性质（据当前数据） */
  function naturesOf(moduleName) {
    var out = [];
    modelItems().forEach(function (it) {
      if (moduleName && it.module !== moduleName) return;
      if (out.indexOf(it.nature) === -1) out.push(it.nature);
    });
    var h = H();
    var order = (h && h.NATURES) ? h.NATURES : out;
    return order.filter(function (n) { return out.indexOf(n) !== -1; });
  }

  function itemsOf(moduleName, natureName) {
    return modelItems().filter(function (it) {
      if (moduleName && it.module !== moduleName) return false;
      if (natureName && it.nature !== natureName) return false;
      return true;
    });
  }

  function peoplePool() {
    var names = {};
    modelItems().forEach(function (it) {
      (it.ownerNames || []).forEach(function (n) { names[n] = true; });
      if (it.lead) names[it.lead] = true;
    });
    (S.members || []).forEach(function (m) { if (m.name) names[m.name] = true; });
    var out = Object.keys(names);
    out.sort(byText);
    return out;
  }

  /** 源表里出现过的负责人类型（去重），只列这些，不解释含义 */
  function leadTypes() {
    var seen = {}, out = [];
    modelItems().forEach(function (it) {
      var t = (it.typ || '').trim();
      if (!t || seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out;
  }

  function renderNewTaskShell() {
    var mods = $('#nt-modules');
    if (mods && !mods.getAttribute('data-ready')) {
      mods.innerHTML = moduleList().map(function (m) {
        return '<button type="button" class="chip" data-value="' + esc(m.name) + '" aria-pressed="false">' +
          '<span class="chip__dot" data-mod="' + esc(m.name) + '" aria-hidden="true"></span>' +
          esc(m.name) + '<span class="chip__n">' + m.count + '</span></button>';
      }).join('');
      mods.setAttribute('data-ready', '1');
    }

    var leadSel = $('#nt-leadtype');
    if (leadSel && !leadSel.getAttribute('data-ready')) {
      leadSel.innerHTML = '<option value="">（不填）</option>' + leadTypes().map(function (t) {
        return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
      }).join('');
      leadSel.setAttribute('data-ready', '1');
    }

    var noteWrap = $('#nt-note-wrap');
    if (noteWrap) {
      var admin = !!(S.me && S.me.role === 'admin');
      noteWrap.hidden = !admin;
    }
  }

  function renderNatures() {
    var box = $('#nt-natures');
    if (!box) return;
    var list = NT.module ? naturesOf(NT.module) : [];
    if (!list.length) {
      box.innerHTML = '<span class="form__hint">先选一级维度</span>';
      return;
    }
    box.innerHTML = list.map(function (n) {
      return '<button type="button" class="chip" data-value="' + esc(n) + '" aria-pressed="' +
        (NT.nature === n ? 'true' : 'false') + '">' + esc(n) + '</button>';
    }).join('');
  }

  function renderModuleChips() {
    var box = $('#nt-modules');
    if (!box) return;
    $$('.chip', box).forEach(function (c) {
      c.setAttribute('aria-pressed', c.getAttribute('data-value') === NT.module ? 'true' : 'false');
    });
  }

  function itemOptions() {
    return itemsOf(NT.module, NT.nature).map(function (it) {
      return { value: it.name, label: it.name, sub: it.module + ' · ' + it.nature };
    });
  }

  function subOptions() {
    if (!NT.item) return [];
    var existing = findItem(NT.item);
    var out = [];
    if (existing) {
      itemSubs(existing).forEach(function (s) { out.push({ value: s, label: s, sub: '' }); });
    }
    NT.subs.forEach(function (s) {
      var has = false;
      out.forEach(function (o) { if (o.value === s.name) has = true; });
      if (!has) out.push({ value: s.name, label: s.name, sub: '本次新建' });
    });
    return out;
  }

  /** 事项被选中后，模块 / 性质由它唯一确定 → 只读回显 */
  function lockCascade() {
    var locked = !!NT.item && !NT.itemIsNew;
    var mb = $('#nt-modules'), nb = $('#nt-natures');
    if (mb) {
      $$('.chip', mb).forEach(function (c) {
        if (locked) { c.setAttribute('aria-disabled', 'true'); c.title = '由具体事项唯一确定'; }
        else { c.removeAttribute('aria-disabled'); c.removeAttribute('title'); }
      });
    }
    if (nb) {
      $$('.chip', nb).forEach(function (c) {
        if (locked) { c.setAttribute('aria-disabled', 'true'); c.title = '由具体事项唯一确定'; }
        else { c.removeAttribute('aria-disabled'); c.removeAttribute('title'); }
      });
    }
  }

  function renderNewTaskForm() {
    renderNewTaskShell();
    renderModuleChips();
    renderNatures();
    lockCascade();

    var itemInput = $('#nt-item');
    if (itemInput && document.activeElement !== itemInput) itemInput.value = NT.item;
    var subInput = $('#nt-sub');
    if (subInput && document.activeElement !== subInput) subInput.value = NT.subs.length ? NT.subs[0].name : '';
    var intro = $('#nt-intro');
    if (intro && document.activeElement !== intro) intro.value = NT.intro;
    var start = $('#nt-start');
    if (start && document.activeElement !== start) start.value = NT.start;
    var end = $('#nt-end');
    if (end && document.activeElement !== end) end.value = NT.end;
    var ownerInput = $('#nt-owner');
    if (ownerInput && document.activeElement !== ownerInput) ownerInput.value = '';
    var leadInput = $('#nt-lead');
    if (leadInput && document.activeElement !== leadInput) leadInput.value = NT.lead;
    var leadSel = $('#nt-leadtype');
    if (leadSel) leadSel.value = NT.leadType;
    var note = $('#nt-note');
    if (note && document.activeElement !== note) note.value = NT.note;

    renderOwnerTags();
    renderDuration();
    renderPreview();
    renderErrors();
  }

  function renderOwnerTags() {
    var box = $('#nt-owner-tags');
    if (!box) return;
    box.innerHTML = NT.owners.map(function (o) {
      return '<span class="tag">' + esc(o) +
        '<button type="button" data-owner-remove="' + esc(o) + '" aria-label="移除 ' + esc(o) + '">×</button></span>';
    }).join('');
  }

  function renderDuration() {
    var el = $('#nt-duration');
    if (!el) return;
    var s = parseDate(NT.start), e = parseDate(NT.end);
    if (!s || !e) { el.textContent = '工期 — 天'; return; }
    if (e.getTime() < s.getTime()) { el.textContent = '完成时间不能早于开始时间'; return; }
    el.textContent = '工期 ' + (daysBetween(s, e) + 1) + ' 天（含首尾）';
  }

  function renderPreview() {
    var box = $('#nt-preview');
    if (!box) return;
    if (!NT.item) {
      box.innerHTML = '<p class="preview__title">实时预览</p>' +
        '<p class="preview__empty">填好事项后，这里会显示它在事项视图里的样子。</p>';
      return;
    }
    var ownerHtml = NT.owners.length
      ? '<span class="chipstack">' + NT.owners.map(function (o) {
          return '<span class="namechip">' + esc(o) + '</span>';
        }).join('') + '</span>'
      : '<span class="muted">—</span>';
    box.innerHTML = '<p class="preview__title">实时预览</p>' +
      '<p class="preview__name">' +
        '<span class="moddot" data-mod="' + esc(NT.module) + '" aria-hidden="true"></span> ' +
        esc(NT.item) + '</p>' +
      '<p class="preview__row"><span>模块 / 性质</span><b>' + esc(NT.module || '—') + ' / ' +
        esc(NT.nature || '—') + '</b></p>' +
      '<p class="preview__row"><span>分项</span><b>' +
        esc(NT.subs.length ? NT.subs.map(function (s) { return s.name; }).join('、') : '—') + '</b></p>' +
      '<p class="preview__row"><span>责任人</span><b>' + ownerHtml + '</b></p>' +
      '<p class="preview__row"><span>负责人</span><b>' + esc(NT.lead || '—') + '</b></p>' +
      '<p class="preview__row"><span>开始 · 完成</span><b>' + esc(NT.start || '—') + ' → ' +
        esc(NT.end || '—') + '</b></p>' +
      '<p class="preview__latest">最新进展：尚无进展记录（新事项首次记进展前显示「待补」，不是数据错误）。</p>';
  }

  function setErr(key, msg) {
    var el = $('#nt-err-' + key);
    if (!el) return;
    if (msg) { el.hidden = false; el.textContent = msg; }
    else { el.hidden = true; el.textContent = ''; }
  }

  function renderErrors() {
    var keys = ['module', 'nature', 'item', 'sub', 'start', 'end', 'owner', 'lead'];
    var sum = [];
    keys.forEach(function (k) {
      setErr(k, NT.errors[k] || '');
      if (NT.errors[k]) sum.push(NT.errors[k]);
    });
    var sumBox = $('#nt-errsum');
    if (sumBox) {
      if (sum.length) {
        sumBox.hidden = false;
        sumBox.textContent = '有 ' + sum.length + ' 处需要修改：' + sum.join('；');
      } else {
        sumBox.hidden = true;
        sumBox.textContent = '';
      }
    }
    var sub = $('#nt-err-submit');
    if (sub) {
      if (NT.errors.submit) { sub.hidden = false; sub.textContent = NT.errors.submit; }
      else { sub.hidden = true; sub.textContent = ''; }
    }
  }

  function clearErrors() {
    NT.errors = {};
    renderErrors();
  }

  function validateNewTask() {
    var e = {};
    if (!NT.module) e.module = '请选择一级维度。';
    if (!NT.nature) e.nature = '请选择二级维度。';
    if (!NT.item) e.item = '请填写具体事项。';
    else {
      var dup = false;
      modelItems().forEach(function (it) { if (it.name === NT.item) dup = true; });
      if (dup) e.item = '已存在同名事项「' + NT.item + '」。请直接选择它，或换一个名称。';
    }
    if (!NT.subs.length) e.sub = '请填写分项（默认等于事项名）。';
    var s = parseDate(NT.start), en = parseDate(NT.end);
    if (!NT.start) e.start = '请选择开始时间。';
    if (!NT.end) e.end = '请选择完成时间。';
    if (s && en && en.getTime() < s.getTime()) e.end = '完成时间不能早于开始时间。';
    if (!NT.owners.length) e.owner = '至少指定一位责任人。';
    if (!NT.lead) e.lead = '请指定负责人。';
    NT.errors = e;
    renderErrors();
    return Object.keys(e).length === 0;
  }

  /* ---- 草稿 ---- */

  function saveDraft() {
    if (!NT.item && !NT.module && !NT.owners.length) return;
    try {
      var payload = {
        module: NT.module, nature: NT.nature, item: NT.item, itemIsNew: NT.itemIsNew,
        subs: NT.subs, intro: NT.intro, start: NT.start, end: NT.end,
        owners: NT.owners, lead: NT.lead, leadType: NT.leadType, note: NT.note,
        ts: Date.now()
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    } catch (e) { /* 隐私模式下写不进去，忽略 */ }
  }

  function scheduleDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }

  function readDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function dropDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
  }

  function showDraftBar(draft) {
    var bar = $('#nt-draft');
    if (!bar) return;
    if (!draft) { bar.hidden = true; return; }
    bar.hidden = false;
    var txt = $('#nt-draft-text');
    if (txt) {
      var ago = Math.max(0, Math.round((Date.now() - (draft.ts || Date.now())) / 60000));
      txt.textContent = '上次未保存的草稿（' + (ago < 1 ? '刚刚保存' : ago + ' 分钟前保存') + '）：' +
        (draft.item || '（未填事项）');
    }
  }

  function applyDraft(draft) {
    NT.module = draft.module || '';
    NT.nature = draft.nature || '';
    NT.item = draft.item || '';
    NT.itemIsNew = !!draft.itemIsNew;
    NT.subs = draft.subs || [];
    NT.intro = draft.intro || '';
    NT.start = draft.start || '';
    NT.end = draft.end || '';
    NT.owners = draft.owners || [];
    NT.lead = draft.lead || '';
    NT.leadType = draft.leadType || '';
    NT.note = draft.note || '';
    renderNewTaskForm();
  }

  /* ---- combo 通用件 ---- */

  function setupCombo(cfg) {
    var input = $(cfg.input);
    var list = $(cfg.list);
    if (!input || !list) return;
    var active = -1;

    function options() { return cfg.options(); }

    function draw() {
      var q = String(input.value || '').trim().toLowerCase();
      var all = options();
      var matched = all.filter(function (o) {
        if (!q) return true;
        return String(o.label).toLowerCase().indexOf(q) !== -1 ||
          String(o.sub || '').toLowerCase().indexOf(q) !== -1;
      });
      active = -1;
      if (!matched.length) {
        list.innerHTML = '<li class="combo__empty">没有匹配的结果</li>';
      } else {
        list.innerHTML = matched.slice(0, 8).map(function (o) {
          return '<li class="combo__opt" role="option" tabindex="-1" data-value="' + esc(o.value) + '">' +
            esc(o.label) + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</li>';
        }).join('');
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function hide() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function pick(value) {
      hide();
      cfg.onPick(value);
    }

    input.addEventListener('focus', function () { draw(); });
    input.addEventListener('input', function () { draw(); if (cfg.onInput) cfg.onInput(); });
    input.addEventListener('blur', function () { setTimeout(hide, 150); });
    input.addEventListener('keydown', function (e) {
      var opts = $$('.combo__opt', list);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!opts.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach(function (o, i) { o.classList.toggle('is-active', i === active); });
        if (opts[active] && opts[active].scrollIntoView) opts[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (active >= 0 && opts[active]) { e.preventDefault(); pick(opts[active].getAttribute('data-value')); }
        else if (cfg.onEnter) { e.preventDefault(); cfg.onEnter(); }
      } else if (e.key === 'Escape') {
        hide();
      }
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest ? e.target.closest('.combo__opt') : null;
      if (!li) return;
      e.preventDefault();
      pick(li.getAttribute('data-value'));
    });
  }

  /* ---- 新建任务页的绑定 ---- */

  function bindNewTask() {
    var mods = $('#nt-modules');
    if (mods && !mods.getAttribute('data-bound')) {
      mods.addEventListener('click', function (e) {
        var c = e.target.closest ? e.target.closest('.chip') : null;
        if (!c) return;
        if (c.getAttribute('aria-disabled') === 'true') {
          setErr('module', '模块与性质由已选事项唯一确定；如需改，请先改事项。');
          return;
        }
        NT.module = c.getAttribute('data-value');
        NT.nature = '';
        NT.item = '';
        NT.itemIsNew = false;
        NT.subs = [];
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      });
      mods.setAttribute('data-bound', '1');
    }

    var nats = $('#nt-natures');
    if (nats && !nats.getAttribute('data-bound')) {
      nats.addEventListener('click', function (e) {
        var c = e.target.closest ? e.target.closest('.chip') : null;
        if (!c) return;
        if (c.getAttribute('aria-disabled') === 'true') return;
        if (!NT.module) { setErr('nature', '请先选一级维度。'); return; }
        NT.nature = c.getAttribute('data-value');
        NT.item = '';
        NT.itemIsNew = false;
        NT.subs = [];
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      });
      nats.setAttribute('data-bound', '1');
    }

    setupCombo({
      input: '#nt-item',
      list: '#nt-item-list',
      options: itemOptions,
      onInput: function () { scheduleDraft(); },
      onPick: function (value) {
        NT.item = value;
        NT.itemIsNew = false;
        var it = findItem(value);
        if (it) {
          NT.module = it.module;
          NT.nature = it.nature;
          NT.subs = [{ name: itemSubs(it)[0], intro: '' }];
        }
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      },
      onEnter: function () { newItemFromInput(); }
    });

    setupCombo({
      input: '#nt-sub',
      list: '#nt-sub-list',
      options: subOptions,
      onInput: function () { scheduleDraft(); },
      onPick: function (value) {
        var it = NT.item ? findItem(NT.item) : null;
        var intro = '';
        if (it) {
          (it.subs || []).forEach(function (s) { if (s.name === value) intro = s.intro || ''; });
        }
        NT.subs = [{ name: value, intro: intro }];
        NT.intro = intro;
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      },
      onEnter: function () { newSubFromInput(); }
    });

    setupCombo({
      input: '#nt-owner',
      list: '#nt-owner-list',
      options: function () {
        return peoplePool().filter(function (n) { return NT.owners.indexOf(n) === -1; })
          .map(function (n) { return { value: n, label: n, sub: '' }; });
      },
      onInput: function () { scheduleDraft(); },
      onPick: function (value) {
        if (value && NT.owners.indexOf(value) === -1) NT.owners.push(value);
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      }
    });

    setupCombo({
      input: '#nt-lead',
      list: '#nt-lead-list',
      options: function () {
        return peoplePool().map(function (n) { return { value: n, label: n, sub: '' }; });
      },
      onInput: function () { scheduleDraft(); },
      onPick: function (value) {
        NT.lead = value;
        clearErrors();
        renderNewTaskForm();
        scheduleDraft();
      }
    });

    var itemNew = $('#nt-item-new');
    if (itemNew && !itemNew.getAttribute('data-bound')) {
      itemNew.addEventListener('click', function () { newItemFromInput(); });
      itemNew.setAttribute('data-bound', '1');
    }

    var subNew = $('#nt-sub-new');
    if (subNew && !subNew.getAttribute('data-bound')) {
      subNew.addEventListener('click', function () { newSubFromInput(); });
      subNew.setAttribute('data-bound', '1');
    }

    var ownerTags = $('#nt-owner-tags');
    if (ownerTags && !ownerTags.getAttribute('data-bound')) {
      ownerTags.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-owner-remove]') : null;
        if (!b) return;
        var name = b.getAttribute('data-owner-remove');
        NT.owners = NT.owners.filter(function (o) { return o !== name; });
        renderNewTaskForm();
        scheduleDraft();
      });
      ownerTags.setAttribute('data-bound', '1');
    }

    var intro = $('#nt-intro');
    if (intro && !intro.getAttribute('data-bound')) {
      intro.addEventListener('input', function () {
        NT.intro = intro.value.slice(0, 100);
        var c = $('#nt-intro-count');
        if (c) c.textContent = String(NT.intro.length);
        renderPreview();
        scheduleDraft();
      });
      intro.setAttribute('data-bound', '1');
    }

    var start = $('#nt-start');
    if (start && !start.getAttribute('data-bound')) {
      start.addEventListener('change', function () {
        NT.start = start.value;
        clearErrors();
        renderDuration();
        renderPreview();
        scheduleDraft();
      });
      start.setAttribute('data-bound', '1');
    }

    var end = $('#nt-end');
    if (end && !end.getAttribute('data-bound')) {
      end.addEventListener('change', function () {
        NT.end = end.value;
        clearErrors();
        renderDuration();
        renderPreview();
        scheduleDraft();
      });
      end.setAttribute('data-bound', '1');
    }

    var leadType = $('#nt-leadtype');
    if (leadType && !leadType.getAttribute('data-bound')) {
      leadType.addEventListener('change', function () {
        NT.leadType = leadType.value;
        scheduleDraft();
      });
      leadType.setAttribute('data-bound', '1');
    }

    var note = $('#nt-note');
    if (note && !note.getAttribute('data-bound')) {
      note.addEventListener('input', function () { NT.note = note.value; scheduleDraft(); });
      note.setAttribute('data-bound', '1');
    }

    var submit = $('#nt-submit');
    if (submit && !submit.getAttribute('data-bound')) {
      submit.addEventListener('click', function (e) { e.preventDefault(); submitNewTask(); });
      submit.setAttribute('data-bound', '1');
    }

    var form = $('#form-newtask');
    if (form && !form.getAttribute('data-bound')) {
      form.addEventListener('submit', function (e) { e.preventDefault(); submitNewTask(); });
      form.setAttribute('data-bound', '1');
    }

    var cancel = $('#nt-cancel');
    if (cancel && !cancel.getAttribute('data-bound')) {
      cancel.addEventListener('click', function () { leaveNewTask(); });
      cancel.setAttribute('data-bound', '1');
    }

    var close = $('#nt-close');
    if (close && !close.getAttribute('data-bound')) {
      close.addEventListener('click', function () { leaveNewTask(); });
      close.setAttribute('data-bound', '1');
    }

    var cont = $('#nt-draft-continue');
    if (cont && !cont.getAttribute('data-bound')) {
      cont.addEventListener('click', function () {
        var d = readDraft();
        if (d) applyDraft(d);
        showDraftBar(null);
      });
      cont.setAttribute('data-bound', '1');
    }

    var drop = $('#nt-draft-drop');
    if (drop && !drop.getAttribute('data-bound')) {
      drop.addEventListener('click', function () {
        dropDraft();
        showDraftBar(null);
        resetNewTask();
      });
      drop.setAttribute('data-bound', '1');
    }
  }

  function newItemFromInput() {
    var input = $('#nt-item');
    var name = String(input ? input.value : '').trim();
    if (!name) { setErr('item', '请先输入事项名，再点「＋ 新建事项」。'); return; }
    var dup = false;
    modelItems().forEach(function (it) { if (it.name === name) dup = true; });
    if (dup) {
      NT.errors.item = '已存在同名事项「' + name + '」。请直接选择它，或换一个名称。';
      renderErrors();
      return;
    }
    NT.item = name;
    NT.itemIsNew = true;
    NT.subs = [{ name: name, intro: '' }];
    clearErrors();
    renderNewTaskForm();
    scheduleDraft();
  }

  function newSubFromInput() {
    if (!NT.item) { setErr('sub', '请先选择具体事项。'); return; }
    var input = $('#nt-sub');
    var name = String(input ? input.value : '').trim();
    if (!name) { setErr('sub', '请先输入分项名，再点「＋ 新建分项」。'); return; }
    var it = findItem(NT.item);
    var exists = false;
    if (it) itemSubs(it).forEach(function (s) { if (s === name) exists = true; });
    NT.subs.forEach(function (s) { if (s.name === name) exists = true; });
    if (exists) {
      NT.errors.sub = '该事项下已有同名分项「' + name + '」，请换一个名字。';
      renderErrors();
      return;
    }
    NT.subs = [{ name: name, intro: NT.intro }];
    clearErrors();
    renderNewTaskForm();
    scheduleDraft();
  }

  function resetNewTask() {
    NT.module = '';
    NT.nature = '';
    NT.item = '';
    NT.itemIsNew = false;
    NT.subs = [];
    NT.intro = '';
    NT.start = fmtDay(today());
    NT.end = '';
    NT.owners = [];
    NT.lead = '';
    NT.leadType = leadTypes().length ? leadTypes()[0] : '';
    NT.note = '';
    NT.errors = {};
    renderNewTaskForm();
  }

  function submitNewTask() {
    if (NT.busy) return;
    if (!validateNewTask()) {
      var box = $('#nt-errsum');
      if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
      var keys = ['module', 'nature', 'item', 'sub', 'start', 'end', 'owner', 'lead'];
      for (var i = 0; i < keys.length; i++) {
        if (!NT.errors[keys[i]]) continue;
        var el = $('#nt-' + keys[i]);
        if (el && el.focus) {
          try { el.focus(); } catch (e) { /* noop */ }
          break;
        }
      }
      return;
    }
    if (!S.online) {
      NT.errors.submit = '当前为离线只读模式，无法创建任务。请连接服务端后重试（草稿已保留）。';
      renderErrors();
      return;
    }

    NT.busy = true;
    var btn = $('#nt-submit');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

    var body = {
      module: NT.module,
      nature: NT.nature,
      item: NT.item,
      subs: NT.subs.map(function (s) { return { name: s.name, intro: s.intro || '' }; }),
      start: NT.start,
      end: NT.end,
      owner: NT.owners.slice(),
      lead: NT.lead,
      leadType: NT.leadType,
      coord: '',
      note: NT.note
    };

    api('/api/tasks', { method: 'POST', body: body }).then(function (res) {
      NT.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '创建任务'; }
      if (res.status === 200 && res.data && res.data.ok) {
        dropDraft();
        var created = res.data.item || NT.item;
        showTaskCreated(created, body);
        resetNewTask();
        leaveNewTask(true);
        return;
      }
      if (res.status === 409) {
        NT.errors.item = (res.data && res.data.detail) ? res.data.detail : '已存在同名事项。';
        renderErrors();
        return;
      }
      if (res.status === 403) {
        NT.errors.submit = (res.data && res.data.detail) ? res.data.detail : '你没有权限在这个模块下建任务。';
        renderErrors();
        return;
      }
      if (res.status === 422) {
        NT.errors.submit = (res.data && res.data.detail) ? res.data.detail : '提交内容不合规。';
        renderErrors();
        return;
      }
      NT.errors.submit = '保存失败：' + ((res.data && res.data.detail) ? res.data.detail : ('服务异常（' + res.status + '）')) +
        '。草稿已保留，可重试。';
      renderErrors();
    }).catch(function () {
      NT.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '创建任务'; }
      NT.errors.submit = '保存失败：网络异常。草稿已保留，可重试。';
      renderErrors();
    });
  }

  function showTaskCreated(name, body) {
    S.newItemDraft = {
      name: name,
      module: body.module,
      nature: body.nature,
      ownerNames: body.owner.slice(),
      ownerRaw: body.owner.join('\n'),
      lead: body.lead,
      startRaw: body.start,
      endRaw: body.end,
      subs: body.subs.map(function (s) { return s.name; })
    };
    setBanner('am-created',
      '<span><strong>已创建：' + esc(name) + '</strong>　·　' +
      esc(String(body.subs.length)) + ' 个分项已同步到源表（约 1 分钟）。</span>' +
      '<span class="banner__act">' +
        '<button class="btn btn--ghost" type="button" id="am-first-progress">现在记第一条进展</button>' +
        '<button class="btn btn--ghost" type="button" id="am-goto-items">查看</button>' +
      '</span>', 'banner--info');
    var b1 = $('#am-first-progress');
    if (b1) {
      b1.addEventListener('click', function () {
        var d = S.newItemDraft;
        if (!d) return;
        var item = {
          name: d.name, module: d.module, nature: d.nature, summary: '',
          startRaw: d.startRaw, endRaw: d.endRaw, ownerRaw: d.ownerRaw,
          ownerNames: d.ownerNames, lead: d.lead, typ: '', coord: '',
          rows: [], subs: d.subs.map(function (s) { return { name: s, intro: '', rows: [] }; })
        };
        openProgress({ item: item, sub: d.subs[0] || d.name });
      });
    }
    var b2 = $('#am-goto-items');
    if (b2) {
      b2.addEventListener('click', function () {
        removeBanner('am-created');
        S.newItemDraft = null;
        gotoView('items');
      });
    }
  }

  /* ---------------------------------------------------------------------
     8. 进度面板（第 4 个 tab，§5）
        数据来源：GET /api/panel；接口不可用（或面板上有筛选）时按契约 §3.7 自算。
     --------------------------------------------------------------------- */

  var MODULE_ORDER = (function () {
    var h = H();
    return (h && h.MODULES) ? h.MODULES.slice() : [];
  })();

  /** 面板作用域内的事项：模块 / 性质 / 责任人筛选 + 服务端数据范围 */
  function panelItems() {
    var h = H();
    var st = (h && h.state) ? h.state : null;
    var out = modelItems().filter(function (it) {
      if (st) {
        if (st.modules && Object.keys(st.modules).length && !st.modules[it.module]) return false;
        if (st.natures && Object.keys(st.natures).length && !st.natures[it.nature]) return false;
        if (st.owner && (it.ownerNames || []).indexOf(st.owner) === -1) return false;
      }
      return true;
    });
    if (S.serverItems) {
      out = out.filter(function (it) { return S.serverItems.indexOf(it.name) !== -1; });
    }
    return out;
  }

  function panelHasFilter() {
    var h = H();
    var st = (h && h.state) ? h.state : null;
    if (!st) return false;
    if (st.modules && Object.keys(st.modules).length) return true;
    if (st.natures && Object.keys(st.natures).length) return true;
    if (st.owner) return true;
    return false;
  }

  function weekBounds() {
    var h = H();
    if (h && h.week) return h.week;
    var t = today();
    var dow = (t.getDay() + 6) % 7;
    var s = new Date(t.getTime()); s.setDate(t.getDate() - dow);
    var e = new Date(s.getTime()); e.setDate(s.getDate() + 6);
    return { start: s, end: e };
  }

  /** 前端按契约 §3.7 的口径自算面板（离线或面板上有筛选时用） */
  function computePanelLocal(items) {
    var t = today();
    var week = weekBounds();
    var states = {}, lasts = {};

    items.forEach(function (it) {
      states[it.name] = (it.state && it.state.key) ? it.state.key : 'wip';
      lasts[it.name] = lastProgressOf(it);
    });

    // 逾期
    var overdue = [];
    items.forEach(function (it) {
      if (states[it.name] !== 'late') return;
      var end = parseDate(it.endRaw);
      overdue.push({
        item: it.name,
        module: it.module,
        owner: it.ownerRaw || '',
        end: it.endRaw ? String(it.endRaw).slice(0, 10) : '',
        overdueDays: end ? daysBetween(end, t) : 0,
        lastProgress: lasts[it.name] ? fmtDay(lasts[it.name]) : null,
        canWrite: canWrite(it)
      });
    });
    overdue.sort(function (a, b) {
      if (b.overdueDays !== a.overdueDays) return b.overdueDays - a.overdueDays;
      return byText(a.item, b.item);
    });

    // 到期（分母 = 已到期项，不是全部事项）
    var due = items.filter(function (it) {
      var e = parseDate(it.endRaw);
      return e && e.getTime() < t.getTime();
    });
    var dueDone = due.filter(function (it) { return states[it.name] === 'done'; });

    // 本周动态
    var entries = [];
    items.forEach(function (it) {
      (it.rows || []).forEach(function (r) {
        var content = String(r['进展内容'] || '').trim();
        if (!content) return;
        var d = parseDate(r['进展日期']);
        if (!d || d.getTime() < week.start.getTime() || d.getTime() > week.end.getTime()) return;
        entries.push({
          date: fmtDay(d),
          item: it.name,
          module: it.module,
          sub: r['分项'] || '',
          actor: r['责任人'] || '',
          actorNames: splitNames(r['责任人']),
          progress: content,
          canWrite: canWrite(it)
        });
      });
    });
    entries.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return byText(a.item, b.item);
    });

    var byActor = {};
    entries.forEach(function (e) {
      var names = e.actorNames.length ? e.actorNames : (e.actor ? [e.actor] : []);
      names.forEach(function (a) { if (a) byActor[a] = (byActor[a] || 0) + 1; });
    });

    // 7 天无进展
    var stale = 0, never = 0, worst = 0;
    items.forEach(function (it) {
      var last = lasts[it.name];
      if (!last) { stale++; never++; return; }
      var d = daysBetween(last, t);
      if (d >= 7) { stale++; if (d > worst) worst = d; }
    });

    // 按模块
    var modMap = {}, modOrder = [];
    items.forEach(function (it) {
      if (!modMap[it.module]) {
        modMap[it.module] = { module: it.module, count: 0, done: 0, doing: 0, overdue: 0, week: 0 };
        modOrder.push(it.module);
      }
      var e = modMap[it.module];
      e.count++;
      if (states[it.name] === 'done') e.done++;
      else if (states[it.name] === 'late') e.overdue++;
      else e.doing++;
    });
    entries.forEach(function (en) {
      if (modMap[en.module]) modMap[en.module].week++;
    });
    var byModule = modOrder.map(function (k) { return modMap[k]; });
    byModule.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return MODULE_ORDER.indexOf(a.module) - MODULE_ORDER.indexOf(b.module);
    });

    // 按责任人
    var ownMap = {};
    items.forEach(function (it) {
      var names = (it.ownerNames && it.ownerNames.length) ? it.ownerNames : (it.ownerRaw ? [it.ownerRaw] : []);
      names.forEach(function (o) {
        if (!o) return;
        if (!ownMap[o]) ownMap[o] = { owner: o, count: 0, done: 0, doing: 0, overdue: 0, week: 0, last: null };
        var e = ownMap[o];
        e.count++;
        if (states[it.name] === 'done') e.done++;
        else if (states[it.name] === 'late') e.overdue++;
        else e.doing++;
      });
    });
    entries.forEach(function (en) {
      var names = en.actorNames.length ? en.actorNames : (en.actor ? [en.actor] : []);
      names.forEach(function (a) { if (a && ownMap[a]) ownMap[a].week++; });
    });
    items.forEach(function (it) {
      var last = lasts[it.name];
      if (!last) return;
      (it.ownerNames || []).forEach(function (o) {
        if (ownMap[o] && (!ownMap[o].last || last.getTime() > ownMap[o].last.getTime())) ownMap[o].last = last;
      });
    });
    var byOwner = Object.keys(ownMap).map(function (k) {
      var e = ownMap[k];
      return {
        owner: e.owner, count: e.count, done: e.done, doing: e.doing,
        overdue: e.overdue, week: e.week,
        lastUpdate: e.last ? fmtDay(e.last) : null,
        nonPerson: e.owner === '各机构人力负责人'
      };
    });
    byOwner.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (b.overdue !== a.overdue) return b.overdue - a.overdue;
      return byText(a.owner, b.owner);
    });

    // 本周动态按日分组
    var days = [];
    entries.forEach(function (en) {
      var g = null;
      days.forEach(function (d) { if (d.date === en.date) g = d; });
      if (!g) { g = { date: en.date, entries: [] }; days.push(g); }
      g.entries.push(en);
    });

    var scopeLabel = '全部 ' + items.length + ' 个事项';
    if (S.me && S.me.scope && S.me.scope !== 'all') {
      scopeLabel = (S.me.scope === 'self' ? '仅与我相关 · ' : '指定模块 · ') + items.length + ' 个事项';
    }

    return {
      scope: { label: scopeLabel, count: items.length },
      kpi: {
        overdue: {
          n: overdue.length,
          worstDays: overdue.reduce(function (m, o) { return o.overdueDays > m ? o.overdueDays : m; }, 0)
        },
        dueDone: { done: dueDone.length, due: due.length },
        weekActivity: {
          n: entries.length,
          items: (function () {
            var set = {};
            entries.forEach(function (en) { set[en.item] = true; });
            return Object.keys(set).length;
          })(),
          byActor: byActor
        },
        stale: { n: stale, worstDays: worst, neverUpdated: never }
      },
      byModule: byModule,
      byOwner: byOwner,
      overdue: overdue,
      weekActivity: days
    };
  }

  function refreshPanel() {
    if (panelHasFilter() || !S.serverPanel) {
      S.panel = computePanelLocal(panelItems());
      S.panelSource = 'local';
    } else {
      S.panel = S.serverPanel;
      S.panelSource = 'server';
    }
    renderPanel();
  }

  function fetchPanel() {
    if (!S.online) return;
    api('/api/panel').then(function (res) {
      if (!res.ok || !res.data || !res.data.kpi) return;
      S.serverPanel = res.data;
      refreshPanel();
    }).catch(function () { /* 离线：继续用本地自算 */ });
  }

  function renderScope() {
    var el = $('#panel-scope');
    if (!el || !S.panel) return;
    var scope = S.panel.scope || { label: '', count: 0 };
    var extra = '';
    var h = H();
    var st = (h && h.state) ? h.state : null;
    if (st && (st.keyword || st.weekOnly)) {
      extra = '　·　（关键词与「只看本周」不作用于面板）';
    }
    el.innerHTML = '当前范围：<b>' + esc(scope.label || (scope.count + ' 个事项')) + '</b>' +
      '　·　筛选同时作用于事项 / 明细 / 甘特视图' + extra;
  }

  function renderKpis() {
    var box = $('#panel-kpis');
    if (!box || !S.panel) return;
    var k = S.panel.kpi || {};
    var over = k.overdue || { n: 0, worstDays: 0 };
    var dd = k.dueDone || { done: 0, due: 0 };
    var wa = k.weekActivity || { n: 0, items: 0, byActor: {} };
    var st = k.stale || { n: 0, worstDays: 0, neverUpdated: 0 };

    var actors = Object.keys(wa.byActor || {}).sort(function (a, b) {
      return (wa.byActor[b] || 0) - (wa.byActor[a] || 0);
    });
    var actorTxt = actors.slice(0, 3).map(function (a) {
      return esc(a) + ' ' + (wa.byActor[a] || 0) + ' 条';
    }).join(' · ');

    box.innerHTML =
      '<div class="kpi"><div class="kpi__label">逾期</div>' +
        '<div class="kpi__n' + (over.n ? ' is-warn' : '') + '">' + esc(String(over.n)) + ' <small>项</small></div>' +
        '<div class="kpi__sub">' + (over.n ? '最久已逾期 ' + esc(String(over.worstDays)) + ' 天' : '没有逾期项') + '</div></div>' +
      '<div class="kpi"><div class="kpi__label">到期完成</div>' +
        '<div class="kpi__n">' + esc(String(dd.done)) + ' <small>/ ' + esc(String(dd.due)) + '</small></div>' +
        '<div class="kpi__sub">已到期 ' + esc(String(dd.due)) + ' 项中完成 ' + esc(String(dd.done)) + ' 项</div></div>' +
      '<div class="kpi"><div class="kpi__label">本周更新</div>' +
        '<div class="kpi__n">' + esc(String(wa.n)) + ' <small>条</small></div>' +
        '<div class="kpi__sub">涉及 ' + esc(String(wa.items)) + ' 个事项' +
          (actorTxt ? ' · ' + actorTxt : '') + '</div></div>' +
      '<div class="kpi"><div class="kpi__label">7 天无进展</div>' +
        '<div class="kpi__n' + (st.n ? ' is-warn' : '') + '">' + esc(String(st.n)) + ' <small>项</small></div>' +
        '<div class="kpi__sub">最久 ' + esc(String(st.worstDays)) + ' 天' +
          (st.neverUpdated ? ' · ' + esc(String(st.neverUpdated)) + ' 项从未有进展' : '') + '</div></div>';
  }

  function dueBuckets(items) {
    var map = {}, order = [];
    items.forEach(function (it) {
      var e = parseDate(it.endRaw);
      if (!e) return;
      var dow = (e.getDay() + 6) % 7;
      var s = new Date(e.getTime());
      s.setDate(e.getDate() - dow);
      var key = fmtDay(s);
      if (!map[key]) { map[key] = { week: key, total: 0, done: 0, late: 0, todo: 0 }; order.push(key); }
      var b = map[key];
      b.total++;
      var st = (it.state && it.state.key) ? it.state.key : 'wip';
      if (st === 'done') b.done++;
      else if (st === 'late') b.late++;
      else b.todo++;
    });
    order.sort();
    return order.map(function (k) { return map[k]; });
  }

  function renderDueBar() {
    var box = $('#panel-duebar');
    if (!box) return;
    var buckets = dueBuckets(panelItems());
    if (!buckets.length) {
      box.innerHTML = '<p class="panel__note">当前范围内没有带完成时间的事项。</p>';
      return;
    }
    var maxTotal = buckets.reduce(function (m, b) { return b.total > m ? b.total : m; }, 0);
    var html = buckets.map(function (b) {
      var w = function (n) { return (b.total ? (n / b.total * 100) : 0).toFixed(1) + '%'; };
      var d = parseDate(b.week);
      return '<div class="duebar__col">' +
        '<div class="duebar__stack" title="' + esc(b.week + ' 当周到期 ' + b.total + ' 项') + '">' +
          '<span class="duebar__seg duebar__seg--done" style="width:' + w(b.done) + '"></span>' +
          '<span class="duebar__seg duebar__seg--late" style="width:' + w(b.late) + '"></span>' +
          '<span class="duebar__seg duebar__seg--todo" style="width:' + w(b.todo) + '"></span>' +
        '</div>' +
        '<div class="duebar__lab">' + esc(fmtMD(d)) + ' 当周</div>' +
        '<div class="duebar__n">' + esc(String(b.total)) + ' 项' +
          (b.late ? ' · 逾期 ' + esc(String(b.late)) : '') + '</div>' +
        '</div>';
    }).join('');
    html += '<div class="duebar__legend">' +
      '<span><i class="duebar__sw" style="background:var(--accent-3)"></i>已完成</span>' +
      '<span><i class="duebar__sw" style="background:var(--amber)"></i>逾期</span>' +
      '<span><i class="duebar__sw" style="background:var(--border-2)"></i>未到期</span>' +
      '<span>峰值 ' + esc(String(maxTotal)) + ' 项 / 周</span>' +
      '</div>';
    box.innerHTML = html;
  }

  function renderModuleTable() {
    var tbody = $('#tbody-panel-modules');
    if (!tbody || !S.panel) return;
    var rows = S.panel.byModule || [];
    var totals = { count: 0, done: 0, doing: 0, overdue: 0, week: 0 };
    var html = rows.map(function (m) {
      totals.count += m.count; totals.done += m.done; totals.doing += m.doing;
      totals.overdue += m.overdue; totals.week += m.week;
      return '<tr class="is-clickable" data-mod-filter="' + esc(m.module) + '" tabindex="0" ' +
          'aria-label="按模块下钻：' + esc(m.module) + '">' +
        '<td><span class="modname"><span class="moddot" data-mod="' + esc(m.module) + '" aria-hidden="true"></span>' +
          esc(m.module) + '</span></td>' +
        '<td class="num">' + esc(String(m.count)) + '</td>' +
        '<td class="num">' + esc(String(m.done)) + '</td>' +
        '<td class="num">' + esc(String(m.doing)) + '</td>' +
        '<td class="num ' + (m.overdue ? 'is-late' : 'is-zero') + '">' + esc(String(m.overdue)) + '</td>' +
        '<td class="num">' + esc(String(m.week)) + '</td>' +
        '</tr>';
    }).join('');
    html += '<tfoot><tr><td>合计</td>' +
      '<td class="num">' + esc(String(totals.count)) + '</td>' +
      '<td class="num">' + esc(String(totals.done)) + '</td>' +
      '<td class="num">' + esc(String(totals.doing)) + '</td>' +
      '<td class="num">' + esc(String(totals.overdue)) + '</td>' +
      '<td class="num">' + esc(String(totals.week)) + '</td>' +
      '</tr></tfoot>';
    tbody.innerHTML = html;
  }

  function renderOwnerTable() {
    var tbody = $('#tbody-panel-owners');
    if (!tbody || !S.panel) return;
    var rows = S.panel.byOwner || [];
    var html = rows.map(function (o) {
      var last = o.lastUpdate ? parseDate(o.lastUpdate) : null;
      var lastCell = last
        ? '<span>' + esc(String(o.lastUpdate).slice(5, 10)) + '</span><span class="ago">' +
            esc(relativeDay(last)) + '</span>'
        : '<span class="muted">从未有进展</span>';
      return '<tr>' +
        '<td>' + (o.nonPerson
          ? '<span class="nonperson">' + esc(o.owner) + '</span> <span class="badge badge--muted">非个人</span>'
          : '<button class="ownlink" type="button" data-owner-filter="' + esc(o.owner) + '">' + esc(o.owner) + '</button>') +
        '</td>' +
        '<td class="num">' + esc(String(o.count)) + '</td>' +
        '<td class="num">' + esc(String(o.doing)) + '</td>' +
        '<td class="num">' + esc(String(o.done)) + '</td>' +
        '<td class="num ' + (o.overdue ? 'is-late' : 'is-zero') + '">' + esc(String(o.overdue)) + '</td>' +
        '<td class="num">' + esc(String(o.week)) + '</td>' +
        '<td>' + lastCell + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = html;

    var note = $('#panel-concentration');
    if (note) note.innerHTML = concentrationText(rows, (S.panel.scope && S.panel.scope.count) || 0);
  }

  function concentrationText(rows, itemCount) {
    if (!rows.length) return '当前范围内没有责任人数据。';
    var sorted = rows.slice().sort(function (a, b) { return b.count - a.count; });
    /* 分母用「事项数」，不是责任人行计数之和（一个事项可能有多位责任人） */
    var total = itemCount || rows.reduce(function (s, o) { return s + o.count; }, 0);
    var top = sorted.slice(0, 2);
    if (top.length === 2 && total > 0) {
      var sum = top[0].count + top[1].count;
      var pct = Math.round(sum / total * 100);
      if (pct >= 50) {
        return '责任高度集中：<b>' + esc(top[0].owner) + ' ' + esc(String(top[0].count)) + ' 项、' +
          esc(top[1].owner) + ' ' + esc(String(top[1].count)) + ' 项</b>，两人合计 ' +
          esc(String(sum)) + '/' + esc(String(total)) + '（' + esc(String(pct)) + '%）。' +
          '任一人休假或离职，' + esc(String(pct)) + '% 的事项将无人可写。';
      }
    }
    return '责任分布：最大责任人 <b>' + esc(top[0].owner) + ' ' + esc(String(top[0].count)) + ' 项</b>（占 ' +
      esc(String(Math.round(top[0].count / total * 100))) + '%），共 ' + esc(String(rows.length)) + ' 位责任人。';
  }

  function renderOverdueTable() {
    var tbody = $('#tbody-panel-overdue');
    var empty = $('#panel-overdue-empty');
    if (!tbody || !S.panel) return;
    var rows = S.panel.overdue || [];
    tbody.innerHTML = rows.map(function (o) {
      var last = o.lastProgress ? parseDate(o.lastProgress) : null;
      var lastCell = last
        ? '<span>' + esc(String(o.lastProgress).slice(5, 10)) + '</span><span class="ago">' +
            esc(relativeDay(last)) + '</span>'
        : '<span class="muted">从未有进展</span>';
      return '<tr>' +
        '<td><button class="ownlink" type="button" data-item-filter="' + esc(o.item) + '">' + esc(o.item) + '</button></td>' +
        '<td><span class="modname"><span class="moddot" data-mod="' + esc(o.module) + '" aria-hidden="true"></span>' +
          esc(o.module) + '</span></td>' +
        '<td>' + esc(o.owner || '—') + '</td>' +
        '<td class="num">' + esc(o.end || '—') + '</td>' +
        '<td class="num is-late">' + esc(String(o.overdueDays)) + ' 天</td>' +
        '<td>' + lastCell + '</td>' +
        '<td>' + (o.canWrite
          ? '<button class="btn btn--ghost" type="button" data-pm-item="' + esc(o.item) + '">记一笔</button>'
          : '') + '</td>' +
        '</tr>';
    }).join('');
    if (empty) empty.hidden = rows.length > 0;
  }

  function renderWeek() {
    var box = $('#panel-week');
    var empty = $('#panel-week-empty');
    var note = $('#panel-week-note');
    if (!box || !S.panel) return;
    var groups = S.panel.weekActivity || [];
    var wa = (S.panel.kpi && S.panel.kpi.weekActivity) || { n: 0, items: 0, byActor: {} };
    var actors = Object.keys(wa.byActor || {});
    if (note) {
      note.innerHTML = '本周 <b>' + esc(String(wa.n)) + '</b> 条进展，涉及 <b>' + esc(String(wa.items)) +
        '</b> 个事项 · 参与 ' + esc(String(actors.length)) + ' 人' +
        (actors.length ? '（' + esc(actors.slice(0, 4).join('、')) + '）' : '');
    }
    var dowName = ['日', '一', '二', '三', '四', '五', '六'];
    box.innerHTML = groups.map(function (g) {
      var d = parseDate(g.date);
      var head = g.date + (d ? '（周' + dowName[d.getDay()] + '）' : '');
      return '<div class="weekday">' +
        '<div class="weekday__d">' + esc(head) + '<span>' + esc(String(g.entries.length)) + ' 条</span></div>' +
        g.entries.map(function (e) {
          return '<div class="weekentry">' +
            '<span class="weekentry__item"><span class="moddot" data-mod="' + esc(e.module) +
              '" aria-hidden="true"></span> ' + esc(e.item) + '</span>' +
            '<span class="weekentry__text" title="' + esc(e.progress) + '">' + esc(e.progress) + '</span>' +
            '<span class="weekentry__act">' + (e.canWrite
              ? '<button class="rowplus rowplus--text" type="button" data-pm-item="' + esc(e.item) +
                '" title="给这个事项也记一条">＋ 我也要记</button>'
              : '') + '</span>' +
            '</div>';
        }).join('') +
        '</div>';
    }).join('');
    if (empty) empty.hidden = groups.length > 0;
  }

  function renderBadge() {
    var badge = $('#panel-badge');
    if (!badge) return;
    var n = (S.panel && S.panel.kpi && S.panel.kpi.overdue) ? S.panel.kpi.overdue.n : 0;
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }

  function renderPanel() {
    if (!S.panel) return;
    renderScope();
    renderKpis();
    renderDueBar();
    renderModuleTable();
    renderOwnerTable();
    renderOverdueTable();
    renderWeek();
    renderBadge();
  }

  /* ---- 面板下钻 ---- */

  function syncFilterControls() {
    var h = H();
    if (!h) return;
    var st = h.state;
    $$('#chip-modules .chip').forEach(function (c) {
      var v = c.getAttribute('data-value');
      c.setAttribute('aria-pressed', (st.modules && st.modules[v]) ? 'true' : 'false');
    });
    $$('#chip-natures .chip').forEach(function (c) {
      var v = c.getAttribute('data-value');
      c.setAttribute('aria-pressed', (st.natures && st.natures[v]) ? 'true' : 'false');
    });
    var sel = $('#sel-owner');
    if (sel) sel.value = st.owner || '';
  }

  function drillModule(mod) {
    var h = H();
    if (!h) return;
    h.state.modules = {};
    h.state.modules[mod] = true;
    h.state.natures = {};
    h.state.owner = '';
    syncFilterControls();
    gotoView('items');
    h.render();
  }

  function drillOwner(owner) {
    var h = H();
    if (!h) return;
    h.state.modules = {};
    h.state.natures = {};
    h.state.owner = owner;
    syncFilterControls();
    gotoView('items');
    h.render();
  }

  function drillItem(name) {
    var h = H();
    if (!h) return;
    h.state.expanded[name] = true;
    gotoView('items');
    h.render();
  }

  function gotoView(view) {
    var h = H();
    if (!h) return;
    if (S.routeActive) leaveNewTask();
    if (window.location.hash.slice(1) !== view) {
      try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// 下可能受限 */ }
    }
    h.setView(view);
  }

  /* ---------------------------------------------------------------------
     9. 路由（#/new-task 与 #/newtask 由这里接管）
     --------------------------------------------------------------------- */

  function isNewRoute(hash) {
    var h = hash || (window.location.hash || '');
    return h === '#/new-task' || h === '#/newtask';
  }

  function enterRoute() {
    if (S.routeActive) return;
    var h = H();
    S.routeReturn = (h && h.state && h.state.view) ? h.state.view : 'items';
    S.routeActive = true;
    document.body.classList.add('is-route');
    var page = $('#page-newtask');
    if (page) page.hidden = false;
    if (!NT.start) NT.start = fmtDay(today());
    if (!NT.leadType) NT.leadType = leadTypes().length ? leadTypes()[0] : '';
    renderNewTaskForm();
    bindNewTask();
    showDraftBar(readDraft());
  }

  function leaveNewTask() {
    var h = H();
    S.routeActive = false;
    document.body.classList.remove('is-route');
    var page = $('#page-newtask');
    if (page) page.hidden = true;
    var target = S.routeReturn || 'items';
    if (window.location.hash.slice(1) !== target) {
      try { history.replaceState(null, '', '#' + target); } catch (e) { /* noop */ }
    }
    if (h) h.setView(target);
  }

  function onHashChange() {
    if (isNewRoute()) { enterRoute(); return; }
    if (S.routeActive) { leaveNewTask(); return; }
    var v = (window.location.hash || '').replace(/^#\/?/, '');
    if (['items', 'detail', 'gantt', 'panel'].indexOf(v) !== -1) {
      var h = H();
      if (h) h.setView(v);
    }
  }

  /* ---------------------------------------------------------------------
     10. 移动端：软键盘高度写进 --kb
     --------------------------------------------------------------------- */

  function syncKb() {
    var vv = window.visualViewport;
    var kb = 0;
    if (vv && window.innerWidth <= 768) {
      kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      if (kb > 320) kb = 320;
    }
    document.documentElement.style.setProperty('--kb', kb + 'px');
  }

  /* ---------------------------------------------------------------------
     11. 全局事件绑定与启动
     --------------------------------------------------------------------- */

  function showFilterExtras(show) {
    var kw = $('#txt-keyword');
    var kwField = kw && kw.closest ? kw.closest('.field') : null;
    var wk = $('#chk-weekonly');
    var wkField = wk && wk.closest ? wk.closest('.field') : null;
    if (kwField) kwField.hidden = !show;
    if (wkField) wkField.hidden = !show;
  }

  function bindGlobal() {
    var h = H();
    if (!h) return;

    /* 视图切换回调 */
    h.onView = function (view) {
      if (view === 'panel') {
        showFilterExtras(false);
        refreshPanel();
        fetchPanel();
      } else {
        showFilterExtras(true);
      }
    };

    /* 记一笔 / 新建任务 入口 */
    var bp = $('#btn-progress');
    if (bp) bp.addEventListener('click', function () { openProgress({}); });
    var bn = $('#btn-newtask');
    if (bn) {
      bn.addEventListener('click', function () {
        if (!canCreateTask()) return;
        try { history.replaceState(null, '', '#/new-task'); } catch (e) { /* noop */ }
        enterRoute();
      });
    }

    /* 行内「＋」：捕获阶段拦下，避免 app.js 的整行展开被触发 */
    var tbody = $('#tbody-items');
    if (tbody) {
      tbody.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-pm-item]') : null;
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        var name = btn.getAttribute('data-pm-item');
        var sub = btn.getAttribute('data-pm-sub') || '';
        openProgress({ item: findItem(name), sub: sub });
      }, true);

      if (window.MutationObserver) {
        var obs = new MutationObserver(function () { injectRowPluses(); });
        obs.observe(tbody, { childList: true, subtree: true });
      }
    }

    /* 面板内的入口与下钻 */
    var panel = $('#view-panel');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var pm = e.target.closest ? e.target.closest('[data-pm-item]') : null;
        if (pm) { openProgress({ item: findItem(pm.getAttribute('data-pm-item')) }); return; }
        var om = e.target.closest ? e.target.closest('[data-owner-filter]') : null;
        if (om) { drillOwner(om.getAttribute('data-owner-filter')); return; }
        var it = e.target.closest ? e.target.closest('[data-item-filter]') : null;
        if (it) { drillItem(it.getAttribute('data-item-filter')); return; }
        var md = e.target.closest ? e.target.closest('[data-mod-filter]') : null;
        if (md) { drillModule(md.getAttribute('data-mod-filter')); return; }
      });
      panel.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var md = e.target.closest ? e.target.closest('[data-mod-filter]') : null;
        if (!md) return;
        e.preventDefault();
        drillModule(md.getAttribute('data-mod-filter'));
      });
    }

    /* app.js 每次 render() 都会改 #view-status → 面板跟着重算 */
    var status = $('#view-status');
    if (status && window.MutationObserver) {
      var obs2 = new MutationObserver(function () {
        var hh = H();
        if (hh && hh.state && hh.state.view === 'panel') refreshPanel();
      });
      obs2.observe(status, { childList: true, characterData: true, subtree: true });
    }

    /* 弹层关闭 */
    var modal = $('#progress-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        var c = e.target.closest ? e.target.closest('[data-pm-close]') : null;
        if (!c) return;
        e.preventDefault();
        closeProgressWithGuard();
      });
    }
    var save = $('#pm-save');
    if (save) save.addEventListener('click', function () { submitProgress(false); });
    var cont = $('#pm-continue');
    if (cont) cont.addEventListener('click', function () { submitProgress(true); });

    /* 快捷键与 Esc */
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        if (S.routeActive) return;
        e.preventDefault();
        openProgress({});
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (PM.open) { e.preventDefault(); submitProgress(false); }
        else if (S.routeActive) { e.preventDefault(); submitNewTask(); }
        return;
      }
      if (e.key === 'Escape') {
        if (PM.open) { e.preventDefault(); closeProgressWithGuard(); return; }
        if (S.routeActive) { e.preventDefault(); leaveNewTask(); return; }
      }
      if (e.key === 'Tab' && PM.open) trapFocus(e);
    });

    /* 路由 */
    window.addEventListener('hashchange', onHashChange);

    /* 软键盘 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncKb);
      window.visualViewport.addEventListener('scroll', syncKb);
    }
    window.addEventListener('resize', syncKb);
    syncKb();

    /* 离开提醒 */
    window.addEventListener('beforeunload', function (e) {
      if (!S.routeActive) return;
      if (!NT.item && !NT.owners.length) return;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function trapFocus(e) {
    var modal = $('#progress-modal');
    if (!modal) return;
    var nodes = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
    if (!nodes.length) return;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function closeProgressWithGuard() {
    if (String(PM.progress || '').trim() || String(PM.plan || '').trim()) {
      if (!window.confirm('这条还没保存，确定放弃吗？')) return;
    }
    closeProgress();
  }

  function loadServerData() {
    return api('/api/data').then(function (res) {
      if (!res.ok || !res.data) return;
      var items = res.data.items || [];
      S.serverItems = items.map(function (i) { return i.item; });
      if (res.data.dataStamp) S.dataStamp = res.data.dataStamp;
      if (items.length && items.length < modelItems().length) {
        showToast('<span>你的数据范围是 <b>' + esc(String(items.length)) + '</b> 个事项（本页本地快照共 ' +
          esc(String(modelItems().length)) + ' 个）。</span>', 6000);
      }
    }).catch(function () { /* 离线：用本地快照 */ });
  }

  function handleInitialRoute() {
    if (isNewRoute(INITIAL_HASH)) {
      try { history.replaceState(null, '', INITIAL_HASH); } catch (e) { /* noop */ }
      enterRoute();
    }
  }

  function boot() {
    if (!H()) return;
    bindGlobal();
    renderIdentity();
    applyWriteGates();

    refreshSession().then(function () {
      S.ready = true;
      renderIdentity();
      applyWriteGates();
      loadServerData();
      handleInitialRoute();
      refreshPanel();
      fetchPanel();
    }).catch(function () {
      S.online = false;
      S.ready = true;
      renderIdentity();
      applyWriteGates();
      showOfflineBanner();
      handleInitialRoute();
      refreshPanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
