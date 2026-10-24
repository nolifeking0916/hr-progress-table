/* ==========================================================================
   集团人力近期重点工作进度表 · 应用逻辑
   纯前端、零依赖、零构建。数据来自 data/rows.js（window.HR_DATA）。
   直接双击 index.html（file://）即可打开；也可 python3 -m http.server 8000。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     0. 常量
     --------------------------------------------------------------------- */

  var DATA = window.HR_DATA;

  // 明细视图的 15 列，顺序与 rows_v2.json 完全一致
  var COLUMNS = [
    '事项序号', '一级维度（六大模块）', '二级维度（人/流程/成本）', '具体事项', '分项',
    '分项内容简介', '进展日期', '进展内容', '开始时间', '完成时间',
    '当日计划（周计划）', '责任人', '负责人', '负责人类型', '协调事项'
  ];

  // 一级维度，顺序即排序时的模块次序
  var MODULES = ['人力资源规划', '招聘与配置', '培训与开发', '绩效管理', '薪酬福利', '员工关系', '待定位'];
  var NATURES = ['人', '流程', '成本'];

  var STATE = {
    DONE: { key: 'done', label: '已完成', cls: 'badge--done' },
    LATE: { key: 'late', label: '逾期', cls: 'badge--warn' },
    WIP:  { key: 'wip',  label: '进行中', cls: 'badge--doing' }
  };

  var STALE_DAYS = 3;      // 数据滞后多少天开始报警
  var PLAN_MAX_INLINE = 2; // 「本周计划要点」最多内联显示几条

  /* ---------------------------------------------------------------------
     1. 小工具
     --------------------------------------------------------------------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 'YYYY-MM-DD HH:mm:ss' → 本地日期对象（不走 Date 解析，避免时区/兼容性坑） */
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(s) {
    var d = parseDate(s);
    if (!d) return '';
    return fmtDay(d);
  }

  /** Date 对象 → 'YYYY-MM-DD' */
  function fmtDay(d) {
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtMD(s) {
    var d = parseDate(s);
    if (!d) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayDate() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  /** 本周 = 周一 ~ 周日（ISO 周） */
  function weekRange(ref) {
    var d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    var dow = (d.getDay() + 6) % 7;          // 周一 = 0
    var start = new Date(d); start.setDate(d.getDate() - dow);
    var end = new Date(start); end.setDate(start.getDate() + 6);
    return { start: start, end: end };
  }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  /** 责任人可能是一行多人（换行 / 顿号 / 逗号 / 斜杠分隔），拆成独立 chip */
  function splitNames(s) {
    if (!s) return [];
    return String(s)
      .split(/[\n\r、，,;；\/]+/)
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });
  }

  function byText(a, b) {
    return String(a).localeCompare(String(b), 'zh-Hans-CN');
  }

  /** 读模块色（跟随主题），避免在 SVG 属性里写 var() 的兼容性风险 */
  function moduleColor(mod) {
    return cssVar('--m-' + mod) || '#718096';
  }

  /** 读取一个 CSS 自定义属性的实际值（跟随浅色/深色主题） */
  function cssVar(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim();
  }

  /* ---------------------------------------------------------------------
     2. 数据模型
     --------------------------------------------------------------------- */

  /**
   * 待核 / 待补 的判定——与 scripts/build_rows.py 的清洗规则一致：
   *   待核：源表「最新进展」里某一行的开头不是 MMDD 日期前缀 → 该行按开始时间落行
   *   待补：进展与周计划都为空 → 按开始时间落一行空行
   * 注意是「逐行」判定，不是整条事项判定。
   * 例：确定保留项目及发放方式 = "1012已确定部分取消项目\n以上四项待确定"，
   *     只有第二行没有日期，只有它那一条是待核。
   */
  function buildPendingFlags(items) {
    var progressNoDate = {};   // item -> 无日期前缀的进展行
    var planNoDate = {};       // item -> 无日期前缀的计划行
    var filler = {};           // item -> 进展与计划均空

    items.forEach(function (it) {
      var pLines = String(it.progress || '').split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0; });
      var wLines = String(it.week || '').split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0 && l !== '/' && l !== '-' && l !== '—' && l !== '无'; });

      var pNo = pLines.filter(function (l) { return !/^\d{4}/.test(l); });
      var wNo = wLines.filter(function (l) { return !/^\d{4}/.test(l); });

      if (pNo.length) progressNoDate[it.item] = pNo;
      if (wNo.length) planNoDate[it.item] = wNo;
      if (!pLines.length && !wLines.length) filler[it.item] = true;
    });

    return { progressNoDate: progressNoDate, planNoDate: planNoDate, filler: filler };
  }

  /** 把 167 行装配成 43 个事项模型 */
  function buildModel() {
    var items = DATA.items || [];
    var rows = DATA.rows || [];
    var flags = buildPendingFlags(items);

    var srcByName = {};
    items.forEach(function (it) { srcByName[it.item] = it; });

    // 事项级字段一律以源事项记录为准（源表 seq 有撞号，按事项名索引最稳）
    var groups = {};
    var order = [];
    rows.forEach(function (r) {
      var name = r['具体事项'];
      if (!groups[name]) {
        groups[name] = [];
        order.push(name);
      }
      groups[name].push(r);
    });

    var models = order.map(function (name) {
      var rws = groups[name].slice().sort(function (a, b) {
        return a['进展日期'] === b['进展日期']
          ? byText(a['分项'], b['分项'])
          : (a['进展日期'] < b['进展日期'] ? -1 : 1);
      });
      var src = srcByName[name] || {};
      var first = rws[0] || {};

      var model = {
        name: name,
        seq: first['事项序号'],
        module: first['一级维度（六大模块）'],
        nature: first['二级维度（人/流程/成本）'],
        summary: first['分项内容简介'] || src.summary || '',
        startRaw: src.start || first['开始时间'] || '',
        endRaw: src.end || first['完成时间'] || '',
        ownerRaw: src.owner !== undefined ? src.owner : (first['责任人'] || ''),
        lead: src.lead !== undefined ? src.lead : (first['负责人'] || ''),
        typ: src.typ !== undefined ? src.typ : (first['负责人类型'] || ''),
        coord: src.coord !== undefined ? src.coord : (first['协调事项'] || ''),
        cat: src.cat || '',
        group: src.group || '',
        rows: rws,
        subs: []
      };

      model.startDate = parseDate(model.startRaw);
      model.endDate = parseDate(model.endRaw);
      model.ownerNames = splitNames(model.ownerRaw);

      // 分项：按首次出现顺序聚合
      var subMap = {}, subOrder = [];
      rws.forEach(function (r) {
        var s = r['分项'];
        if (!subMap[s]) {
          subMap[s] = { name: s, intro: r['分项内容简介'] || '', rows: [] };
          subOrder.push(s);
        }
        subMap[s].rows.push(r);
      });
      model.subs = subOrder.map(function (s) { return subMap[s]; });

      // 最新进展：该事项最新一条「非空」进展
      var latest = null;
      rws.forEach(function (r) {
        if (!r['进展内容'] || !String(r['进展内容']).trim()) return;
        if (!latest || r['进展日期'] > latest.date) {
          latest = { date: r['进展日期'], content: r['进展内容'], row: r };
        }
      });
      model.latest = latest;

      // 待核 / 待补 落到具体行上
      model.pending = null;
      var startKey = model.startRaw;
      var pNo = flags.progressNoDate[name];
      var wNo = flags.planNoDate[name];
      rws.forEach(function (r) {
        if (pNo && pNo.length && r['进展日期'] === startKey &&
            r['进展内容'] && String(r['进展内容']).trim() && !r.__pending) {
          r.__pending = '待核';
        }
        if (wNo && wNo.length && r['进展日期'] === startKey &&
            !String(r['进展内容'] || '').trim() &&
            r['当日计划（周计划）'] && String(r['当日计划（周计划）']).trim() && !r.__pending) {
          r.__pending = '待核';
        }
        if (flags.filler[name] &&
            !String(r['进展内容'] || '').trim() &&
            !String(r['当日计划（周计划）'] || '').trim() && !r.__pending) {
          r.__pending = '待补';
        }
      });
      model.rows.forEach(function (r) {
        if (r.__pending === '待核' && !model.pending) model.pending = '待核';
        if (r.__pending === '待补' && !model.pending) model.pending = '待补';
      });

      model.state = computeState(model);
      return model;
    });

    return { models: models, flags: flags };
  }

  /**
   * 状态完全由数据推导，没有另设状态字段：
   *   已完成 = 存在一条进展日期 ≥ 完成时间 的非空进展
   *   逾期   = 今天已过完成时间，但还没有上面那种进展
   *   进行中 = 其余
   */
  function computeState(model) {
    var today = todayDate();
    if (model.endDate && model.endDate.getTime() < today.getTime()) {
      var done = model.rows.some(function (r) {
        if (!r['进展内容'] || !String(r['进展内容']).trim()) return false;
        var d = parseDate(r['进展日期']);
        return d && model.endDate && d.getTime() >= model.endDate.getTime();
      });
      return done ? STATE.DONE : STATE.LATE;
    }
    return STATE.WIP;
  }

  /* ---------------------------------------------------------------------
     3. 状态
     --------------------------------------------------------------------- */

  var state = {
    view: 'items',
    modules: {},        // module name -> true
    natures: {},        // nature -> true
    owner: '',
    keyword: '',
    weekOnly: false,
    sortKey: 'seq',
    sortDir: 'asc',
    expanded: {}        // item name -> true
  };

  var MODEL = null;
  var TODAY = null;
  var WEEK = null;
  var GLOBAL_MIN = null;   // 全部事项的最早开始时间
  var GLOBAL_MAX = null;   // 全部事项的最晚完成时间
  var DATA_ASOF = null;    // 数据集里「有进展内容」的最晚日期

  /* ---------------------------------------------------------------------
     4. 筛选 / 排序
     --------------------------------------------------------------------- */

  function itemPassesBase(item) {
    if (state.modules && Object.keys(state.modules).length) {
      if (!state.modules[item.module]) return false;
    }
    if (state.natures && Object.keys(state.natures).length) {
      if (!state.natures[item.nature]) return false;
    }
    if (state.owner) {
      if (item.ownerNames.indexOf(state.owner) === -1) return false;
    }
    return true;
  }

  function rowInWeek(row) {
    var d = parseDate(row['进展日期']);
    if (!d) return false;
    return d.getTime() >= WEEK.start.getTime() && d.getTime() <= WEEK.end.getTime();
  }

  function rowHasContent(row) {
    return !!(String(row['进展内容'] || '').trim() || String(row['当日计划（周计划）'] || '').trim());
  }

  function rowMatchesKeyword(row, item, kw) {
    if (!kw) return true;
    if (item.name.toLowerCase().indexOf(kw) !== -1) return true;
    if (String(row['分项'] || '').toLowerCase().indexOf(kw) !== -1) return true;
    if (String(row['进展内容'] || '').toLowerCase().indexOf(kw) !== -1) return true;
    if (String(row['当日计划（周计划）'] || '').toLowerCase().indexOf(kw) !== -1) return true;
    return false;
  }

  /** 返回 { items: [...], rows: [...] }，items 里带 item.__rows（该事项在当前筛选下可见的行） */
  function computeFiltered() {
    var kw = state.keyword.trim().toLowerCase();
    var outItems = [];
    var outRows = [];

    MODEL.models.forEach(function (item) {
      if (!itemPassesBase(item)) return;
      var visible = item.rows.filter(function (r) {
        if (state.weekOnly && !(rowInWeek(r) && rowHasContent(r))) return false;
        if (!rowMatchesKeyword(r, item, kw)) return false;
        return true;
      });
      if (kw && !visible.length) return;
      if (state.weekOnly && !visible.length) return;
      item.__rows = visible;
      outItems.push(item);
      visible.forEach(function (r) { outRows.push(r); });
    });

    var sortedItems = sortItems(outItems);

    // 明细行跟着事项的排序走，再按日期、分项排，保证三个视图次序一致
    var order = {};
    sortedItems.forEach(function (it, i) { order[it.name] = i; });
    outRows.sort(function (a, b) {
      var d = order[a['具体事项']] - order[b['具体事项']];
      if (d !== 0) return d;
      if (a['进展日期'] !== b['进展日期']) return a['进展日期'] < b['进展日期'] ? -1 : 1;
      return byText(a['分项'], b['分项']);
    });

    return { items: sortedItems, rows: outRows };
  }

  function sortItems(items) {
    var dir = state.sortDir === 'desc' ? -1 : 1;
    var key = state.sortKey;
    var modIdx = {};
    MODULES.forEach(function (m, i) { modIdx[m] = i; });

    var sorted = items.slice().sort(function (a, b) {
      var r = 0;
      if (key === 'seq') {
        r = (a.seq - b.seq);
      } else if (key === 'module') {
        r = (modIdx[a.module] || 0) - (modIdx[b.module] || 0);
      } else if (key === 'latest') {
        // 没有进展的永远沉底，不随升降序翻转
        var aNone = a.latest ? 0 : 1;
        var bNone = b.latest ? 0 : 1;
        if (aNone !== bNone) return aNone - bNone;
        if (!aNone) {
          var la = a.latest.date;
          var lb = b.latest.date;
          r = (la < lb ? -1 : (la > lb ? 1 : 0));
        }
      } else if (key === 'end') {
        var ea = a.endRaw || '';
        var eb = b.endRaw || '';
        r = (ea < eb ? -1 : (ea > eb ? 1 : 0));
      }
      if (r !== 0) return r * dir;
      // 次级键，保证 13 / 20 撞号的两条事项次序稳定
      if (key !== 'seq') {
        var r2 = (a.seq - b.seq);
        if (r2 !== 0) return r2;
      }
      var r3 = (modIdx[a.module] || 0) - (modIdx[b.module] || 0);
      if (r3 !== 0) return r3;
      return byText(a.name, b.name);
    });

    return sorted;
  }

  /* ---------------------------------------------------------------------
     5. 片段渲染
     --------------------------------------------------------------------- */

  function dash(text) {
    return '<span class="muted">' + esc(text || '—') + '</span>';
  }

  function moduleCell(mod, full) {
    return '<span class="modname' + (full ? ' modname--full' : '') + '" data-mod="' + esc(mod) + '">' +
      '<span class="moddot" aria-hidden="true"></span>' + esc(mod) + '</span>';
  }

  function stateBadge(item) {
    return '<span class="badge ' + item.state.cls + '">' + esc(item.state.label) + '</span>';
  }

  function pendingBadge(row) {
    if (!row || !row.__pending) return '';
    return '<span class="badge badge--warn" title="该行口径待核，详见下方「口径说明」">' +
      esc(row.__pending) + '</span>';
  }

  function latestCell(item) {
    if (!item.latest) {
      return '<span class="latest--none">尚无进展记录</span>';
    }
    return '<span class="latest__date">' + esc(fmtDate(item.latest.date)) + '</span>' +
      '<span class="latest__text">' + pendingBadge(item.latest.row) + ' ' +
      esc(item.latest.content) + '</span>';
  }

  function spanCell(item) {
    if (!item.startDate && !item.endDate) return dash();
    return '<span class="span">' +
      '<span class="span__row"><span>开始</span><span>' + esc(fmtDate(item.startRaw) || '—') + '</span></span>' +
      '<span class="span__row"><span>完成</span><span>' + esc(fmtDate(item.endRaw) || '—') + '</span></span>' +
      '</span>';
  }

  function miniBar(item) {
    if (!item.startDate || !item.endDate || !GLOBAL_MIN || !GLOBAL_MAX) return dash();
    var total = Math.max(1, daysBetween(GLOBAL_MIN, GLOBAL_MAX));
    var left = daysBetween(GLOBAL_MIN, item.startDate) / total * 100;
    var width = Math.max(1.5, daysBetween(item.startDate, item.endDate) / total * 100);
    var nowLeft = daysBetween(GLOBAL_MIN, TODAY) / total * 100;
    var now = (nowLeft >= 0 && nowLeft <= 100)
      ? '<span class="minibar__now" style="left:' + nowLeft.toFixed(2) + '%" title="今天"></span>' : '';
    return '<span class="minibar" data-mod="' + esc(item.module) + '" title="' +
      esc(fmtDate(item.startRaw) + ' → ' + fmtDate(item.endRaw)) + '" role="img" aria-label="' +
      esc('工期 ' + fmtDate(item.startRaw) + ' 至 ' + fmtDate(item.endRaw)) + '">' +
      '<span class="minibar__fill" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></span>' +
      now + '</span>';
  }

  function weekPlanCell(item) {
    var plans = [];
    (item.__rows || item.rows).forEach(function (r) {
      var p = String(r['当日计划（周计划）'] || '').trim();
      if (!p) return;
      if (!rowInWeek(r)) return;
      plans.push({ date: r['进展日期'], text: p });
    });
    if (!plans.length) return dash();
    var shown = plans.slice(0, PLAN_MAX_INLINE).map(function (p) {
      return '<li><span class="planlist__d">' + esc(fmtMD(p.date)) + '</span>' + esc(p.text) + '</li>';
    }).join('');
    var more = plans.length > PLAN_MAX_INLINE
      ? '<li class="planmore">另有 ' + (plans.length - PLAN_MAX_INLINE) + ' 条</li>' : '';
    return '<ul class="planlist">' + shown + more + '</ul>';
  }

  function ownerCell(item) {
    if (!item.ownerNames.length) return dash();
    return '<span class="chipstack">' + item.ownerNames.map(function (n) {
      return '<span class="namechip">' + esc(n) + '</span>';
    }).join('') + '</span>';
  }

  function subCountCell(item) {
    var n = item.subs.length;
    var html = '<span class="num">' + n + '</span>';
    if (n > 1) {
      html += '<div class="sublist" style="margin-top:2px">' + item.subs.map(function (s) {
        return '<span class="subpill">' + esc(s.name) + '</span>';
      }).join('') + '</div>';
    }
    return html;
  }

  /* ---------------------------------------------------------------------
     6. 视图一：事项视图
     --------------------------------------------------------------------- */

  function renderItems(items) {
    var tbody = $('#tbody-items');
    var html = '';

    items.forEach(function (item) {
      var expanded = !!state.expanded[item.name];
      var expId = 'exp-' + item.seq + '-' + hashName(item.name);

      html += '<tr class="item-row" data-item="' + esc(item.name) + '">' +
        '<td class="col-idx num" data-label="序号">' + esc(item.seq) + '</td>' +
        '<td class="col-mod" data-label="模块">' + moduleCell(item.module) + '</td>' +
        '<td class="col-nat" data-label="性质">' + esc(item.nature) + '</td>' +
        '<td class="col-item" data-label="事项">' +
          '<div class="itemname">' +
            '<button type="button" class="rowtoggle" aria-expanded="' + (expanded ? 'true' : 'false') +
            '" aria-controls="' + expId + '" data-toggle="' + esc(item.name) + '" ' +
            'aria-label="' + (expanded ? '收起' : '展开') + '事项：' + esc(item.name) + '">' +
            (expanded ? '▾' : '▸') + '</button>' +
            '<span class="itemname__text">' + esc(item.name) + '</span>' +
            '<span class="rowflags">' + stateBadge(item) +
              (item.pending ? '<span class="badge badge--warn">' + esc(item.pending) + '</span>' : '') +
            '</span>' +
          '</div>' +
        '</td>' +
        '<td class="col-sub" data-label="分项数">' + subCountCell(item) + '</td>' +
        '<td class="col-intro wrap clamp" data-label="分项简介" title="' + esc(item.summary || '') + '">' +
          esc(item.summary || '') + '</td>' +
        '<td class="col-latest wrap" data-label="最新进展">' + latestCell(item) + '</td>' +
        '<td class="col-span" data-label="开始·完成">' + spanCell(item) + '</td>' +
        '<td class="col-bar" data-label="工期">' + miniBar(item) + '</td>' +
        '<td class="col-plan" data-label="本周计划">' + weekPlanCell(item) + '</td>' +
        '<td class="col-owner" data-label="责任人">' + ownerCell(item) + '</td>' +
        '<td class="col-lead" data-label="负责人">' + esc(item.lead || '—') + '</td>' +
        '<td class="col-typ" data-label="负责人类型">' +
          (item.typ ? esc(item.typ) : dash()) + '</td>' +
        '<td class="col-coord" data-label="协调事项">' + dash(item.coord) + '</td>' +
      '</tr>';

      html += '<tr class="item-expand" id="' + expId + '"' + (expanded ? '' : ' hidden') + '>' +
        '<td colspan="14">' + renderExpand(item) + '</td></tr>';
    });

    tbody.innerHTML = html;
    $('#items-empty').hidden = items.length > 0;
  }

  function renderExpand(item) {
    var rows = item.__rows || item.rows;
    var groups = [];
    var gmap = {};
    rows.forEach(function (r) {
      var s = r['分项'];
      if (!gmap[s]) {
        gmap[s] = { name: s, intro: r['分项内容简介'] || '', rows: [] };
        groups.push(gmap[s]);
      }
      gmap[s].rows.push(r);
    });

    var html = '<div class="expand">';
    groups.forEach(function (g) {
      html += '<div class="expand__group">' +
        '<div class="expand__ghead">' +
          '<span class="expand__gname">' + esc(g.name) + '</span>' +
          (g.intro ? '<span class="expand__gintro">' + esc(g.intro) + '</span>' : '') +
          '<span class="expand__gcount">' + g.rows.length + ' 条记录</span>' +
        '</div>' +
        '<table class="daytable">' +
          '<thead><tr><th scope="col">日期</th><th scope="col">进展内容</th>' +
          '<th scope="col">当日计划（周计划）</th></tr></thead>' +
          '<tbody>' +
          g.rows.map(function (r) {
            var isToday = fmtDate(r['进展日期']) === fmtDay(TODAY);
            return '<tr' + (isToday ? ' class="is-today"' : '') + '>' +
              '<td class="d-date" data-label="日期">' + esc(fmtDate(r['进展日期'])) + '</td>' +
              '<td class="d-prog" data-label="进展">' +
                (String(r['进展内容'] || '').trim()
                  ? pendingBadge(r) + ' ' + esc(r['进展内容'])
                  : '<span class="muted">—</span>') +
              '</td>' +
              '<td class="d-plan" data-label="计划">' +
                (String(r['当日计划（周计划）'] || '').trim()
                  ? esc(r['当日计划（周计划）'])
                  : '<span class="muted">—</span>') +
              '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  /* ---------------------------------------------------------------------
     7. 视图二：明细视图
     --------------------------------------------------------------------- */

  function renderDetail(rows) {
    var tbody = $('#tbody-detail');
    var html = '';

    rows.forEach(function (r) {
      html += '<tr>' +
        '<td class="col-idx num" data-label="事项序号">' + esc(r['事项序号']) + '</td>' +
        '<td class="col-mod" data-label="一级维度">' + moduleCell(r['一级维度（六大模块）'], true) + '</td>' +
        '<td class="col-nat" data-label="二级维度">' + esc(r['二级维度（人/流程/成本）']) + '</td>' +
        '<td class="col-item wrap" data-label="具体事项">' + esc(r['具体事项']) + '</td>' +
        '<td class="col-sub" data-label="分项">' + esc(r['分项']) + '</td>' +
        '<td class="col-intro wrap" data-label="分项内容简介">' + esc(r['分项内容简介']) + '</td>' +
        '<td class="col-date" data-label="进展日期">' + esc(fmtDate(r['进展日期'])) + '</td>' +
        '<td class="col-prog wrap" data-label="进展内容">' +
          (String(r['进展内容'] || '').trim()
            ? pendingBadge(r) + ' ' + esc(r['进展内容'])
            : '<span class="muted">—</span>') + '</td>' +
        '<td class="col-date" data-label="开始时间">' + esc(fmtDate(r['开始时间']) || '—') + '</td>' +
        '<td class="col-date" data-label="完成时间">' + esc(fmtDate(r['完成时间']) || '—') + '</td>' +
        '<td class="col-plan wrap" data-label="当日计划">' +
          (String(r['当日计划（周计划）'] || '').trim()
            ? esc(r['当日计划（周计划）'])
            : '<span class="muted">—</span>') + '</td>' +
        '<td class="col-owner" data-label="责任人">' + ownerCell({ ownerNames: splitNames(r['责任人']) }) + '</td>' +
        '<td class="col-lead" data-label="负责人">' + esc(r['负责人'] || '—') + '</td>' +
        '<td class="col-typ" data-label="负责人类型">' + esc(r['负责人类型'] || '—') + '</td>' +
        '<td class="col-coord" data-label="协调事项">' + dash(r['协调事项']) + '</td>' +
      '</tr>';
    });

    tbody.innerHTML = html;
    $('#detail-empty').hidden = rows.length > 0;
  }

  /* ---------------------------------------------------------------------
     8. 视图三：甘特视图
     --------------------------------------------------------------------- */

  var GANTT_ROW_H = 30;
  var GANTT_AXIS_H = 34;

  function ganttRange(items) {
    var min = null, max = null;
    items.forEach(function (it) {
      if (it.startDate && (!min || it.startDate < min)) min = it.startDate;
      if (it.endDate && (!max || it.endDate > max)) max = it.endDate;
    });
    if (!min || !max) { min = GLOBAL_MIN || TODAY; max = GLOBAL_MAX || TODAY; }
    // 至少 21 天，避免只筛出少数事项时条形被压成一条线
    var span = daysBetween(min, max);
    if (span < 21) {
      var pad = Math.ceil((21 - span) / 2);
      min = new Date(min); min.setDate(min.getDate() - pad);
      max = new Date(max); max.setDate(max.getDate() + pad);
    }
    // 左右各留 2 天
    min = new Date(min); min.setDate(min.getDate() - 2);
    max = new Date(max); max.setDate(max.getDate() + 2);
    return { min: min, max: max, total: Math.max(1, daysBetween(min, max)) };
  }

  function renderGantt(items) {
    var labelsBox = $('#gantt-labels');
    var plotBox = $('#gantt-plot');
    var axisBox = $('#gantt-axis');
    var legendBox = $('#gantt-legend');

    if (!items.length) {
      labelsBox.innerHTML = '';
      plotBox.innerHTML = '';
      axisBox.innerHTML = '';
      legendBox.innerHTML = '';
      $('#gantt-empty').hidden = false;
      return;
    }
    $('#gantt-empty').hidden = true;

    var range = ganttRange(items);
    var width = Math.max(320, plotBox.clientWidth || 640);
    var height = items.length * GANTT_ROW_H;

    // 主题色取实际计算值（SVG 属性里不写 var()，兼容性最稳）
    var C = {
      border: cssVar('--border'),
      border2: cssVar('--border-2'),
      text2: cssVar('--text-2'),
      text3: cssVar('--text-3'),
      amber: cssVar('--amber')
    };

    function x(date) {
      return daysBetween(range.min, date) / range.total * width;
    }

    // ---- 标签列 ----
    labelsBox.innerHTML = items.map(function (it) {
      return '<div class="gantt__label" title="' + esc(it.name + '（' + it.module + '）') + '">' +
        '<span class="moddot" data-mod="' + esc(it.module) + '" aria-hidden="true"></span>' +
        '<span class="gseq">' + esc(it.seq) + '</span>' +
        '<span class="gname">' + esc(it.name) + '</span>' +
        '</div>';
    }).join('');

    // ---- 轴 ----
    var axisSvg = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + GANTT_AXIS_H +
      '" viewBox="0 0 ' + width + ' ' + GANTT_AXIS_H + '" role="img" aria-label="时间轴">'];
    axisSvg.push('<line x1="0" y1="' + (GANTT_AXIS_H - 0.5) + '" x2="' + width + '" y2="' + (GANTT_AXIS_H - 0.5) +
      '" stroke="' + C.border2 + '" stroke-width="1"/>');
    var monthCursor = new Date(range.min.getFullYear(), range.min.getMonth(), 1);
    while (monthCursor <= range.max) {
      if (monthCursor >= range.min) {
        var mx = x(monthCursor);
        axisSvg.push('<line x1="' + mx.toFixed(1) + '" y1="0" x2="' + mx.toFixed(1) + '" y2="' + GANTT_AXIS_H +
          '" stroke="' + C.border2 + '" stroke-width="1"/>');
        axisSvg.push('<text x="' + (mx + 4).toFixed(1) + '" y="13" font-size="10" fill="' + C.text2 + '">' +
          esc(monthCursor.getFullYear() + '年' + (monthCursor.getMonth() + 1) + '月') + '</text>');
      }
      monthCursor.setMonth(monthCursor.getMonth() + 1);
      monthCursor.setDate(1);
    }
    // 每旬小刻度
    var tick = new Date(range.min);
    tick.setDate(1);
    while (tick <= range.max) {
      var tx = x(tick);
      if (tx >= 0 && tx <= width) {
        axisSvg.push('<text x="' + (tx + 3).toFixed(1) + '" y="' + (GANTT_AXIS_H - 5) +
          '" font-size="9" fill="' + C.text3 + '">' + esc((tick.getMonth() + 1) + '/' + tick.getDate()) + '</text>');
      }
      tick.setDate(tick.getDate() + 10);
    }
    if (TODAY >= range.min && TODAY <= range.max) {
      var txx = x(TODAY);
      axisSvg.push('<line x1="' + txx.toFixed(1) + '" y1="0" x2="' + txx.toFixed(1) + '" y2="' + GANTT_AXIS_H +
        '" stroke="' + C.amber + '" stroke-width="1"/>');
      axisSvg.push('<text x="' + (txx + 3).toFixed(1) + '" y="13" font-size="10" fill="' + C.amber + '">今天</text>');
    }
    axisSvg.push('</svg>');
    axisBox.innerHTML = axisSvg.join('');

    // ---- 主体 ----
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="甘特图">'];

    // 周网格线
    var weekStart = new Date(range.min);
    while (weekStart <= range.max) {
      var wx = x(weekStart);
      if (wx >= 0) {
        svg.push('<line x1="' + wx.toFixed(1) + '" y1="0" x2="' + wx.toFixed(1) + '" y2="' + height +
          '" stroke="' + C.border + '" stroke-width="1"/>');
      }
      weekStart.setDate(weekStart.getDate() + 7);
    }
    // 行分隔
    for (var i = 1; i <= items.length; i++) {
      svg.push('<line x1="0" y1="' + (i * GANTT_ROW_H) + '" x2="' + width + '" y2="' + (i * GANTT_ROW_H) +
        '" stroke="' + C.border + '" stroke-width="1"/>');
    }
    // 月分隔
    var mcur = new Date(range.min.getFullYear(), range.min.getMonth(), 1);
    while (mcur <= range.max) {
      if (mcur >= range.min) {
        var mmx = x(mcur);
        svg.push('<line x1="' + mmx.toFixed(1) + '" y1="0" x2="' + mmx.toFixed(1) + '" y2="' + height +
          '" stroke="' + C.border2 + '" stroke-width="1"/>');
      }
      mcur.setMonth(mcur.getMonth() + 1);
      mcur.setDate(1);
    }

    // 条形
    items.forEach(function (it, idx) {
      if (!it.startDate || !it.endDate) return;
      var y = idx * GANTT_ROW_H + 8;
      var bx = x(it.startDate);
      var bw = Math.max(3, x(it.endDate) - bx);
      svg.push('<rect x="' + bx.toFixed(1) + '" y="' + y + '" width="' + bw.toFixed(1) +
        '" height="' + (GANTT_ROW_H - 16) + '" rx="2" fill="' + moduleColor(it.module) + '" opacity="0.82" ' +
        'data-mod="' + esc(it.module) + '"><title>' + esc(it.name + '\n' + fmtDate(it.startRaw) +
        ' → ' + fmtDate(it.endRaw) + '\n最新进展：' + (it.latest ? fmtDate(it.latest.date) : '—') +
        '\n状态：' + it.state.label) + '</title></rect>');
      // 最新进展刻度
      if (it.latest) {
        var ld = parseDate(it.latest.date);
        if (ld && ld >= range.min && ld <= range.max) {
          var lx = x(ld);
          svg.push('<line x1="' + lx.toFixed(1) + '" y1="' + (y - 3) + '" x2="' + lx.toFixed(1) +
            '" y2="' + (y + GANTT_ROW_H - 13) + '" stroke="' + C.text2 + '" stroke-width="1.5" opacity="0.85"/>');
        }
      }
    });

    // 今天线（覆盖在最上层）
    if (TODAY >= range.min && TODAY <= range.max) {
      var todayX = x(TODAY);
      svg.push('<line x1="' + todayX.toFixed(1) + '" y1="0" x2="' + todayX.toFixed(1) + '" y2="' + height +
        '" stroke="' + C.amber + '" stroke-width="1.5"/>');
    }
    svg.push('</svg>');
    plotBox.innerHTML = svg.join('');

    // ---- 图例 ----
    var mods = [];
    items.forEach(function (it) { if (mods.indexOf(it.module) === -1) mods.push(it.module); });
    mods.sort(function (a, b) { return MODULES.indexOf(a) - MODULES.indexOf(b); });
    legendBox.innerHTML = mods.map(function (m) {
      return '<span class="legend__item"><span class="legend__swatch" data-mod="' + esc(m) + '"></span>' +
        esc(m) + '</span>';
    }).join('') +
    '<span class="legend__item"><span class="legend__line"></span>今天（' + esc(fmtDay(TODAY)) + '）</span>' +
    '<span class="legend__item"><span class="legend__dash" style="border-color:' + C.text2 + '"></span>最新进展日期</span>';
  }

  /* ---------------------------------------------------------------------
     9. 导出 CSV
     --------------------------------------------------------------------- */

  function exportCsv(rows) {
    if (!rows.length) { alert('当前筛选条件下没有可导出的明细行。'); return; }
    var lines = [COLUMNS.join(',')];
    rows.forEach(function (r) {
      lines.push(COLUMNS.map(function (k) {
        var v = (k === '进展日期' || k === '开始时间' || k === '完成时间') ? fmtDate(r[k]) : r[k];
        return csvCell(v);
      }).join(','));
    });
    // UTF-8 BOM，Excel 双击打开不乱码
    var blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '集团人力重点事项进度_明细_' + fmtDay(TODAY) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    s = s.replace(/\r?\n/g, ' ');
    if (/[",]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ---------------------------------------------------------------------
     10. 渲染总入口
     --------------------------------------------------------------------- */

  function render() {
    var f = computeFiltered();

    renderItems(f.items);
    renderDetail(f.rows);
    if (state.view === 'gantt') renderGantt(f.items);

    // 状态条
    $('#view-status').innerHTML = '当前 <b>' + f.items.length + '</b> 个事项 · <b>' + f.rows.length +
      '</b> 行明细　·　共 ' + MODEL.models.length + ' 个事项 / ' + (DATA.rows || []).length + ' 行';

    // 排序表头状态
    $$('#tbl-items thead th[data-sort]').forEach(function (th) {
      var on = th.getAttribute('data-sort') === state.sortKey;
      th.classList.toggle('is-sorted', on);
      th.classList.toggle('is-desc', on && state.sortDir === 'desc');
    });
  }

  /* ---------------------------------------------------------------------
     11. 视图切换
     --------------------------------------------------------------------- */

  function setView(view) {
    state.view = view;
    if (window.location.hash.slice(1) !== view) {
      try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// 下可能受限 */ }
    }
    ['items', 'detail', 'gantt'].forEach(function (v) {
      var panel = $('#view-' + v);
      var tab = $('#tab-' + v);
      var on = (v === view);
      panel.hidden = !on;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    if (view === 'gantt') {
      var f = computeFiltered();
      renderGantt(f.items);
    }
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------------
     12. 事件绑定
     --------------------------------------------------------------------- */

  function hashName(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  function toggleItem(name, force) {
    var open = (force === undefined) ? !state.expanded[name] : !!force;
    if (open) state.expanded[name] = true; else delete state.expanded[name];
    render();
  }

  function bindEvents() {
    // 回车不触发表单提交（筛选区是个 form，防止误刷新）
    $('#filters').addEventListener('submit', function (e) { e.preventDefault(); });

    // ---- 视图切换（tab 语义 + 方向键） ----
    $$('.viewtabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setView(tab.getAttribute('data-view')); });
      tab.addEventListener('keydown', function (e) {
        var tabs = $$('.viewtabs .tab');
        var i = tabs.indexOf(tab);
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); next.focus(); setView(next.getAttribute('data-view')); }
      });
    });

    // ---- 模块 / 性质 chips ----
    $('#chip-modules').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chip') : null;
      if (!btn) return;
      var m = btn.getAttribute('data-value');
      if (state.modules[m]) delete state.modules[m]; else state.modules[m] = true;
      syncChips();
      render();
    });
    $('#chip-natures').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chip') : null;
      if (!btn) return;
      var n = btn.getAttribute('data-value');
      if (state.natures[n]) delete state.natures[n]; else state.natures[n] = true;
      syncChips();
      render();
    });

    // ---- 责任人 ----
    $('#sel-owner').addEventListener('change', function (e) {
      state.owner = e.target.value;
      render();
    });

    // ---- 关键词（防抖） ----
    var kwTimer = null;
    $('#txt-keyword').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(kwTimer);
      kwTimer = setTimeout(function () { state.keyword = v; render(); }, 150);
    });

    // ---- 本周开关 ----
    $('#chk-weekonly').addEventListener('change', function (e) {
      state.weekOnly = e.target.checked;
      render();
    });

    // ---- 排序 ----
    $('#sel-sort').addEventListener('change', function (e) {
      state.sortKey = e.target.value;
      render();
    });
    $('#btn-sortdir').addEventListener('click', function () {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      syncSortDir();
      render();
    });

    // ---- 表头点击排序（事项视图） ----
    $$('#tbl-items thead th[data-sort]').forEach(function (th) {
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      function doSort() {
        var k = th.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = k; state.sortDir = 'asc'; }
        $('#sel-sort').value = state.sortKey;
        syncSortDir();
        render();
      }
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); }
      });
    });

    // ---- 重置 ----
    $('#btn-reset').addEventListener('click', function () {
      state.modules = {}; state.natures = {}; state.owner = '';
      state.keyword = ''; state.weekOnly = false;
      state.sortKey = 'seq'; state.sortDir = 'asc';
      state.expanded = {};
      $('#sel-owner').value = '';
      $('#txt-keyword').value = '';
      $('#chk-weekonly').checked = false;
      $('#sel-sort').value = 'seq';
      syncChips(); syncSortDir();
      render();
    });

    // ---- 导出 / 打印 ----
    $('#btn-csv').addEventListener('click', function () { exportCsv(computeFiltered().rows); });
    $('#btn-print').addEventListener('click', function () { window.print(); });

    // ---- 展开 / 收起 ----
    $('#btn-expand-all').addEventListener('click', function () {
      computeFiltered().items.forEach(function (it) { state.expanded[it.name] = true; });
      render();
    });
    $('#btn-collapse-all').addEventListener('click', function () {
      state.expanded = {};
      render();
    });

    $('#tbody-items').addEventListener('click', function (e) {
      // 展开按钮
      var btn = e.target.closest ? e.target.closest('[data-toggle]') : null;
      if (btn) {
        e.preventDefault();
        toggleItem(btn.getAttribute('data-toggle'));
        return;
      }
      // 点整行展开（选中文本时不触发）
      if (window.getSelection && String(window.getSelection()).length > 0) return;
      var tr = e.target.closest ? e.target.closest('tr.item-row') : null;
      if (!tr) return;
      toggleItem(tr.getAttribute('data-item'));
    });

    // 窗口尺寸变化时重画甘特（宽度变了）
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (state.view !== 'gantt') return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { renderGantt(computeFiltered().items); }, 120);
    });

    // 浅色 / 深色主题切换时重画甘特（SVG 里画的是解析后的颜色）
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () {
        if (state.view === 'gantt') renderGantt(computeFiltered().items);
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  }

  function syncChips() {
    $$('#chip-modules .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', state.modules[c.getAttribute('data-value')] ? 'true' : 'false');
    });
    $$('#chip-natures .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', state.natures[c.getAttribute('data-value')] ? 'true' : 'false');
    });
  }

  function syncSortDir() {
    var btn = $('#btn-sortdir');
    btn.setAttribute('data-dir', state.sortDir);
    $('#sortdir-icon').textContent = state.sortDir === 'asc' ? '↑' : '↓';
    $('#sortdir-text').textContent = state.sortDir === 'asc' ? '升序' : '降序';
    btn.setAttribute('aria-label', '当前' + (state.sortDir === 'asc' ? '升序' : '降序') + '，点击切换');
  }

  /* ---------------------------------------------------------------------
     13. 初始化
     --------------------------------------------------------------------- */

  function buildChips() {
    var modCounts = {}, natCounts = {};
    MODEL.models.forEach(function (it) {
      modCounts[it.module] = (modCounts[it.module] || 0) + 1;
      natCounts[it.nature] = (natCounts[it.nature] || 0) + 1;
    });

    $('#chip-modules').innerHTML = MODULES.filter(function (m) { return modCounts[m]; }).map(function (m) {
      return '<button type="button" class="chip" data-value="' + esc(m) + '" aria-pressed="false">' +
        '<span class="chip__dot" data-mod="' + esc(m) + '" aria-hidden="true"></span>' +
        esc(m) + '<span class="chip__n">' + modCounts[m] + '</span></button>';
    }).join('');

    $('#chip-natures').innerHTML = NATURES.filter(function (n) { return natCounts[n]; }).map(function (n) {
      return '<button type="button" class="chip" data-value="' + esc(n) + '" aria-pressed="false">' +
        esc(n) + '<span class="chip__n">' + natCounts[n] + '</span></button>';
    }).join('');

    // 责任人下拉：多值拆开后平铺
    var owners = [];
    MODEL.models.forEach(function (it) {
      it.ownerNames.forEach(function (n) { if (owners.indexOf(n) === -1) owners.push(n); });
    });
    owners.sort(byText);
    $('#sel-owner').innerHTML = '<option value="">全部</option>' + owners.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
  }

  function renderMeta() {
    // 「数据截至」= 有进展内容的最晚日期（纯计划的未来日期不计入）
    var asof = null;
    (DATA.rows || []).forEach(function (r) {
      if (!String(r['进展内容'] || '').trim()) return;
      if (!asof || r['进展日期'] > asof) asof = r['进展日期'];
    });
    DATA_ASOF = asof;

    if (asof) {
      $('#data-stamp').textContent = '数据截至 ' + fmtDate(asof);
      var lag = daysBetween(parseDate(asof), TODAY);
      if (lag > STALE_DAYS) {
        $('#stale-badge').hidden = false;
        $('#stale-days').textContent = lag;
      } else {
        $('#stale-badge').hidden = true;
      }
    }

    var gen = (DATA.generatedAt || '').replace('T', ' ');
    $('#generated-stamp').textContent = gen ? '数据快照 ' + gen : '';
    $('#footer-meta').textContent =
      '共 ' + MODEL.models.length + ' 个事项 / ' + (DATA.rows || []).length + ' 行明细　·　' +
      '数据快照 ' + (gen || '—') + '　·　口径与待核项见「口径说明」　·　' +
      '打印：Ctrl/⌘ + P　·　导出：CSV（含 BOM，Excel 直接打开）';
  }

  function init() {
    if (!DATA || !DATA.rows || !DATA.rows.length) {
      var err = $('#load-error');
      if (err) err.hidden = false;
      return;
    }

    TODAY = todayDate();
    WEEK = weekRange(TODAY);
    MODEL = buildModel();

    GLOBAL_MIN = null; GLOBAL_MAX = null;
    MODEL.models.forEach(function (it) {
      if (it.startDate && (!GLOBAL_MIN || it.startDate < GLOBAL_MIN)) GLOBAL_MIN = it.startDate;
      if (it.endDate && (!GLOBAL_MAX || it.endDate > GLOBAL_MAX)) GLOBAL_MAX = it.endDate;
    });

    buildChips();
    renderMeta();
    syncSortDir();
    bindEvents();
    var wanted = (window.location.hash || '').slice(1);
    setView(['items', 'detail', 'gantt'].indexOf(wanted) >= 0 ? wanted : 'items');
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
