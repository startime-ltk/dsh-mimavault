/**
 * dsh-mimavault —— 侧栏常驻面板（Client half / web bundle）
 *
 * 由 client-modules 通过 window.__ModuleLoader__ 加载，CommonJS 风格 factory(require)。
 * 无构建期依赖：所有数据读写都走宿主 HTTP 路由（浏览器半部没有 fs 权限）。
 *
 * 面板功能：
 *  1) 模式开关：PC 密匣（external，更安全）/ 内置明文库（builtin，不加密）
 *  2) external：显示连接状态，自动尝试拉起密匣
 *  3) builtin：明文 CSV 导入、条目列表、一键清除（二次确认）、AI 清除请求确认
 */
(() => {
  window.__ModuleLoader__.load({
    id: 'dsh-mimavault',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = require('react');
      var h = React.createElement;
      var BASE = '/plugins/dsh-mimavault';
      var PANEL_ID = 'dsh-mimavault';
      // purge 用 order 30；这里取 31，稳定排在它下方。
      var PANEL_ORDER = 31;

      function Glyph() {
        return h('span', { style: { fontSize: 14, lineHeight: 1 } }, '\u{1F510}');
      }

      function get(url) {
        return fetch(BASE + url, { cache: 'no-store' }).then(function (r) { return r.json(); });
      }
      function post(url, body) {
        return fetch(BASE + url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json(); });
      }

      var STATUS_TITLES = {
        loading: '正在检测…',
        ready: '已就绪',
        locked: '已启动，未就绪',
        not_running: '密匣未运行',
        no_app: '未找到密匣',
        error: '检测失败',
      };
      var STATUS_COLORS = {
        loading: '#999999', ready: '#27AE60', locked: '#E67E22',
        not_running: '#E74C3C', no_app: '#E74C3C', error: '#E74C3C',
      };

      var btn = {
        padding: '5px 12px', borderRadius: 6,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent', color: 'inherit',
        cursor: 'pointer', fontSize: 12,
      };
      var btnPrimary = Object.assign({}, btn, {
        border: '1px solid rgba(30,136,229,.6)', color: '#1E88E5',
      });
      var btnDanger = Object.assign({}, btn, {
        border: '1px solid rgba(231,76,60,.6)', color: '#E74C3C',
      });
      var box = {
        padding: '9px 11px', borderRadius: 8,
        border: '1px solid rgba(127,127,127,.25)',
        marginBottom: 12,
      };
      var label = { fontSize: 12, color: 'rgba(127,127,127,.95)' };

      /** 明文警告条：内置模式下始终可见，避免用户误以为数据加密 */
      function PlaintextWarning() {
        return h('div', {
          style: {
            padding: '8px 10px', borderRadius: 6, marginBottom: 12,
            background: 'rgba(231,76,60,.10)',
            border: '1px solid rgba(231,76,60,.35)',
            fontSize: 12, lineHeight: 1.6,
          },
        },
          h('strong', { style: { color: '#E74C3C' } }, '内置库：明文存盘，不加密'),
          h('div', null, '密码以明文写在本地 JSON 文件里，任何能读该文件的程序都能看到。装 PC 密匣更安全。'),
        );
      }

      /** 确认框组件：所有清除动作都必须经它，人点「确认清空」才发 confirm */
      function ConfirmBar(props) {
        return h('div', {
          style: Object.assign({}, box, {
            background: 'rgba(231,76,60,.08)',
            border: '1px solid rgba(231,76,60,.5)',
          }),
        },
          h('strong', { style: { color: '#E74C3C' } }, '确认清空内置库？'),
          h('div', { style: Object.assign({}, label, { margin: '6px 0 10px' }) },
            props.reason || '这会删除全部条目。执行前会自动留一份备份。'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: btnDanger, onClick: props.onConfirm }, '确认清空'),
            h('button', { style: btn, onClick: props.onCancel }, '取消'),
          ),
        );
      }

      var CATEGORIES = ['网站', '应用', '其他', 'WiFi', '银行卡', '证件', 'API Key'];
      /** 分类 -> 专属字段 [{key,label}] */
      var EXTRA_FIELDS = {
        'WiFi': [
          { key: 'wifi_ssid', label: 'SSID' },
          { key: 'wifi_encryption', label: '加密方式' },
        ],
        '银行卡': [
          { key: 'bank_card_no', label: '卡号' },
          { key: 'bank_holder', label: '持卡人' },
          { key: 'bank_expiry', label: '有效期' },
          { key: 'bank_cvv', label: 'CVV' },
          { key: 'bank_name', label: '银行' },
        ],
        '证件': [
          { key: 'id_type', label: '证件类型' },
          { key: 'id_number', label: '证件号' },
          { key: 'id_name', label: '姓名' },
          { key: 'id_authority', label: '签发机关' },
          { key: 'id_expiry', label: '有效期' },
        ],
        'API Key': [
          { key: 'api_key', label: 'Key' },
          { key: 'api_endpoint', label: '接口地址' },
          { key: 'api_model', label: '模型 / 备注' },
        ],
      };

      function emptyEntry() {
        return {
          category: '网站', platform: '', account: '', password: '',
          phone: '', email: '', note: '', totpUri: '',
          extra: {},
        };
      }

      var fieldStyle = {
        width: '100%', boxSizing: 'border-box', padding: '4px 6px',
        fontSize: 12, border: '1px solid rgba(127,127,127,.35)',
        borderRadius: 5, background: 'transparent', color: 'inherit',
      };
      var rowStyle = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 };
      var captionStyle = Object.assign({}, label, { width: 74, flex: '0 0 74px' });

      /** 新增 / 编辑表单 */
      function EntryForm(props) {
        var pair = React.useState(props.initial || emptyEntry());
        var form = pair[0];
        var setForm = pair[1];
        var showPair = React.useState(false);
        var showPwd = showPair[0];
        var setShowPwd = showPair[1];
        var savingPair = React.useState(false);
        var saving = savingPair[0];
        var setSaving = savingPair[1];
        var rootRef = React.useRef(null);

        // 打开表单后滚到它：长表单展开时用户不必自己往下找
        React.useEffect(function () {
          if (rootRef.current && rootRef.current.scrollIntoView) {
            try { rootRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
          }
        }, []);

        function set(k, v) {
          var next = Object.assign({}, form);
          next[k] = v;
          setForm(next);
        }
        function setExtra(k, v) {
          setForm(Object.assign({}, form, { extra: Object.assign({}, form.extra || {}, { [k]: v }) }));
        }

        function input(k, ph, type) {
          return h('input', {
            type: type || 'text', value: form[k] || '',
            placeholder: ph || '', style: fieldStyle,
            onChange: function (e) { set(k, e.target.value); },
          });
        }

        function save() {
          if (!String(form.platform || '').trim()) { props.onMessage('平台名称不能为空'); return; }
          setSaving(true);
          // 清掉空的专属字段
          var extra = {};
          Object.keys(form.extra || {}).forEach(function (k) {
            if (String(form.extra[k] || '').trim()) extra[k] = String(form.extra[k]).trim();
          });
          var payload = {
            category: form.category, platform: String(form.platform).trim(),
            account: form.account, password: form.password,
            phone: form.phone, email: form.email, note: form.note,
            totpUri: form.totpUri, extra: extra,
          };
          var p = props.editing
            ? post('/entries', { action: 'update', id: props.editing, patch: payload })
            : post('/entries', { action: 'add', entry: payload });
          p.then(function (r) {
            setSaving(false);
            if (!r.ok) { props.onMessage(r.message || '保存失败'); return; }
            props.onMessage(props.editing ? '已保存修改' : '已新增条目');
            props.onSaved();
          }).catch(function (e) {
            setSaving(false);
            props.onMessage('保存失败：' + String(e));
          });
        }

        var extraDefs = EXTRA_FIELDS[form.category] || [];

        return h('div', { ref: rootRef, style: Object.assign({}, box, { background: 'rgba(30,136,229,.05)' }) },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('strong', null, props.editing ? '编辑条目 #' + props.editing : '新增条目'),
            h('button', { style: btn, onClick: props.onCancel }, '关闭'),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '分类'),
            h('select', {
              value: form.category || '网站', style: fieldStyle,
              onChange: function (e) { set('category', e.target.value); },
            }, CATEGORIES.map(function (c) { return h('option', { key: c, value: c }, c); })),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '平台 *'),
            input('platform', '如 GitHub'),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '账号'),
            input('account', '用户名 / 邮箱 / 手机'),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '密码'),
            input('password', '密码', showPwd ? 'text' : 'password'),
            h('button', {
              style: Object.assign({}, btn, { padding: '3px 8px' }),
              onClick: function () { setShowPwd(!showPwd); },
            }, showPwd ? '隐藏' : '显示'),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '邮箱'),
            input('email', ''),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, '手机'),
            input('phone', ''),
          ),
          h('div', { style: rowStyle },
            h('span', { style: captionStyle }, 'TOTP'),
            input('totpUri', 'otpauth:// 链接或 Base32 密钥'),
          ),
          h('div', { style: { marginBottom: 6 } },
            h('span', { style: captionStyle }, '备注'),
            h('textarea', {
              value: form.note || '', placeholder: '备注',
              // 固定 3 行 + 自身滚动，避免长文本把表单撑得过高
              style: Object.assign({}, fieldStyle, { height: 62, marginTop: 4, resize: 'none' }),
              onChange: function (e) { set('note', e.target.value); },
            }),
          ),
          extraDefs.length > 0
            ? h('div', { style: { marginTop: 6, marginBottom: 6 } },
                h('div', { style: Object.assign({}, label, { marginBottom: 4 }) }, '专属字段（' + form.category + '）'),
                extraDefs.map(function (d) {
                  return h('div', { key: d.key, style: rowStyle },
                    h('span', { style: captionStyle }, d.label),
                    h('input', {
                      type: 'text', style: fieldStyle,
                      value: (form.extra || {})[d.key] || '',
                      onChange: function (e) { setExtra(d.key, e.target.value); },
                    }),
                  );
                }),
              )
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { style: btnPrimary, disabled: saving, onClick: save },
              saving ? '保存中…' : (props.editing ? '保存修改' : '添加')),
            h('button', { style: btn, onClick: function () { setForm(emptyEntry()); } }, '清空表单'),
          ),
        );
      }

      function Panel() {
        var cfgPair = React.useState({ mode: 'external' });
        var cfg = cfgPair[0];
        var setCfg = cfgPair[1];
        var statusPair = React.useState({ phase: 'loading' });
        var status = statusPair[0];
        var setStatus = statusPair[1];
        var listPair = React.useState([]);
        var items = listPair[0];
        var setItems = listPair[1];
        var pendingPair = React.useState(null);
        var pending = pendingPair[0];
        var setPending = pendingPair[1];
        var noticePair = React.useState('');
        var notice = noticePair[0];
        var setNotice = noticePair[1];
        var csvPair = React.useState('');
        var csv = csvPair[0];
        var setCsv = csvPair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0];
        var setBusy = busyPair[1];
        var updPair = React.useState({ state: 'idle' });
        var upd = updPair[0];
        var setUpd = updPair[1];
        var formPair = React.useState(null); // null=关闭；{editing:id|null, initial:entry}
        var form = formPair[0];
        var setForm = formPair[1];

        function checkUpdate(force) {
          setUpd({ state: 'loading' });
          var p = force ? post('/update', {}) : get('/update');
          return p.then(function (r) {
            setUpd(Object.assign({ state: 'done' }, r));
          }).catch(function (e) {
            setUpd({ state: 'error', message: String(e) });
          });
        }

        function openAddForm() { setForm({ editing: null, initial: emptyEntry() }); }

        function openEditForm(id) {
          post('/entry', { id: id }).then(function (r) {
            if (!r.ok) { flash(r.message || '读取失败'); return; }
            setForm({ editing: id, initial: r.entry });
          });
        }

        function deleteEntry(id) {
          if (typeof window !== 'undefined' && window.confirm
              && !window.confirm('确定删除条目 #' + id + '？')) return;
          post('/entries', { action: 'delete', id: id }).then(function (r) {
            flash(r.ok ? '已删除' : ('删除失败：' + (r.message || '')));
            if (form && form.editing === id) setForm(null);
            return loadAll();
          });
        }

        function loadAll() {
          return Promise.all([
            get('/config').catch(function () { return { mode: 'external', entries: 0 }; }),
            get('/status').catch(function (e) { return { phase: 'error', message: String(e) }; }),
            get('/entries').catch(function () { return { items: [] }; }),
            get('/clear').catch(function () { return { hasPending: false }; }),
          ]).then(function (all) {
            setCfg(all[0]);
            setStatus(all[1]);
            setItems(all[2].items || []);
            setPending(all[3].hasPending ? all[3] : null);
          });
        }

        React.useEffect(function () {
          var alive = true;
          loadAll();
          // 每 4 秒轮询：external 状态 + 是否有 AI 发起的清除请求
          var timer = setInterval(function () {
            if (!alive) return;
            Promise.all([
              get('/status').catch(function () { return null; }),
              get('/clear').catch(function () { return null; }),
            ]).then(function (all) {
              if (!alive) return;
              if (all[0]) setStatus(all[0]);
              if (all[1] && all[1].hasPending) setPending(all[1]);
            });
          }, 4000);
          return function () { alive = false; clearInterval(timer); };
        }, []);

        function flash(msg) {
          setNotice(msg);
          setTimeout(function () { setNotice(''); }, 5000);
        }

        function switchMode(mode) {
          setBusy(true);
          post('/mode', { mode: mode }).then(function (r) {
            setBusy(false);
            flash(r.message || '已切换');
            return loadAll();
          }).catch(function (e) {
            setBusy(false);
            flash('切换失败：' + String(e));
          });
        }

        function launch() {
          setStatus({ phase: 'loading' });
          post('/launch', {}).then(setStatus).catch(function (e) {
            setStatus({ phase: 'error', message: String(e) });
          });
        }

        function importCsv() {
          if (!csv.trim()) { flash('先粘贴 CSV 内容'); return; }
          setBusy(true);
          post('/import', { csv: csv }).then(function (r) {
            setBusy(false);
            flash(r.message || '导入完成');
            if (r.ok) setCsv('');
            return loadAll();
          }).catch(function (e) {
            setBusy(false);
            flash('导入失败：' + String(e));
          });
        }

        function requestClear() {
          post('/clear/request', { source: 'panel', reason: '用户在侧栏点了「清空内置库」' })
            .then(function (r) {
              setPending({ hasPending: true, reason: r.reason, source: 'panel', entries: cfg.entries });
            });
        }

        function confirmClear() {
          setBusy(true);
          post('/clear/confirm', { token: pending && pending.token }).then(function (r) {
            setBusy(false);
            setPending(null);
            flash(r.ok
              ? ('已清空 ' + r.removed + ' 条' + (r.backupSaved ? '，备份已留' : ''))
              : ('清空失败：' + (r.message || '')));
            return loadAll();
          }).catch(function (e) {
            setBusy(false);
            flash('清空失败：' + String(e));
          });
        }

        function cancelClear() {
          post('/clear/cancel', {}).then(function () { setPending(null); });
        }

        function restore() {
          post('/clear/restore', {}).then(function (r) {
            flash(r.ok ? ('已恢复 ' + r.restored + ' 条') : ('恢复失败：' + (r.message || '')));
            return loadAll();
          });
        }

        var isBuiltin = cfg.mode === 'builtin';
        var phase = status.phase || 'loading';

        // 整个面板自己滚动：右侧栏容器往往没有可滚动的祖先，
        // 表单展开后内容会超出视口却滚不动。这里显式占满高度并开启纵向滚动。
        return h('div', { style: {
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '16px 18px 32px',
          fontSize: 13,
          lineHeight: 1.7,
          WebkitOverflowScrolling: 'touch',
        } },
          // ---- 模式开关 ----
          h('div', { style: box },
            h('div', { style: { marginBottom: 8 } },
              h('strong', null, '数据源'),
              h('span', { style: Object.assign({}, label, { marginLeft: 8 }) },
                '（切换只影响本插件，不改动 PC 密匣）'),
            ),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                style: isBuiltin ? btn : btnPrimary,
                disabled: busy,
                onClick: function () { switchMode('external'); },
              }, 'PC 密匣（更安全）'),
              h('button', {
                style: isBuiltin ? btnPrimary : btn,
                disabled: busy,
                onClick: function () { switchMode('builtin'); },
              }, '内置明文库（免安装）'),
            ),
            h('div', { style: Object.assign({}, label, { marginTop: 8 }) },
              isBuiltin
                ? '当前：插件自带的明文库，数据独立，PC 密匣里的条目不会自动出现。'
                : '当前：读取 PC 密匣的本地 API，密钥不出密匣进程。',
            ),
          ),

          isBuiltin ? PlaintextWarning() : null,

          // ---- 状态 ----
          h('div', { style: box },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', {
                style: {
                  width: 8, height: 8, borderRadius: 4,
                  background: STATUS_COLORS[phase] || '#999999', flex: '0 0 auto',
                },
              }),
              h('strong', null, STATUS_TITLES[phase] || phase),
            ),
            h('div', { style: label },
              status.message || (isBuiltin ? '内置库无需启动任何程序。' : describeStatus(phase)),
            ),
            !isBuiltin
              ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
                  h('button', { style: btn, onClick: launch }, '启动 / 刷新'),
                )
              : null,
          ),

          // ---- 清除确认（AI 请求或面板按钮，统一走这里） ----
          pending && isBuiltin ? ConfirmBar({
            reason: (pending.source === 'agent' ? 'AI 发起了清除请求：' : '')
              + (pending.reason || '') + '（当前 ' + (pending.entries ?? cfg.entries) + ' 条，执行前自动留备份）',
            onConfirm: confirmClear,
            onCancel: cancelClear,
          }) : null,

          // ---- 内置库操作 ----
          isBuiltin
            ? h('div', { style: box },
                h('strong', null, '内置库'),
                h('div', { style: label }, '共 ' + (cfg.entries ?? 0) + ' 条'),
                h('textarea', {
                  value: csv,
                  onChange: function (e) { setCsv(e.target.value); },
                  placeholder: '粘贴密匣导出的明文 CSV（表头含 name,username,password,notes 等）',
                  style: {
                    width: '100%', boxSizing: 'border-box', height: 70,
                    marginTop: 8, padding: 6, fontSize: 11,
                    border: '1px solid rgba(127,127,127,.35)', borderRadius: 6,
                    background: 'transparent', color: 'inherit', resize: 'none',
                  },
                }),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                  h('button', { style: btnPrimary, disabled: busy, onClick: importCsv }, '导入 CSV'),
                  h('button', { style: btn, disabled: busy, onClick: openAddForm }, '新增条目'),
                  h('button', { style: btnDanger, disabled: busy, onClick: requestClear }, '清空内置库'),
                  h('button', { style: btn, disabled: busy, onClick: restore }, '从备份恢复'),
                ),
                h('div', { style: Object.assign({}, label, { marginTop: 8 }) },
                  '导入走本地解析，不经过 AI；CSV 里的密码明文只在你硬盘上短暂存在。',
                ),
              )
            : null,

          // ---- 新增 / 编辑表单 ----
          isBuiltin && form
            ? h(EntryForm, {
                key: 'form-' + (form.editing || 'new'),
                editing: form.editing,
                initial: form.initial,
                onMessage: flash,
                onCancel: function () { setForm(null); },
                onSaved: function () { setForm(null); return loadAll(); },
              })
            : null,

          // ---- 条目列表（内置库） ----
          isBuiltin && items.length > 0
            ? h('div', { style: box },
                h('strong', null, '条目'),
                // 不在这里开内部滚动：嵌套滚动容器会吞掉滚轮事件，
                // 整个面板统一由根节点滚动。
                h('div', { style: { marginTop: 6 } },
                  items.map(function (it) {
                    return h('div', {
                      key: it.id,
                      style: {
                        display: 'flex', justifyContent: 'space-between', gap: 8,
                        alignItems: 'center', padding: '3px 0',
                        borderBottom: '1px solid rgba(127,127,127,.12)',
                      },
                    },
                      h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
                        '#' + it.id + '  ' + (it.platform || '(无平台)')),
                      h('span', { style: label }, it.category),
                      h('button', {
                        style: Object.assign({}, btn, { padding: '2px 7px' }),
                        onClick: function () { openEditForm(it.id); },
                      }, '编辑'),
                      h('button', {
                        style: Object.assign({}, btnDanger, { padding: '2px 7px' }),
                        onClick: function () { deleteEntry(it.id); },
                      }, '删'),
                    );
                  }),
                ),
              )
            : null,

          // ---- 关于 / 检查更新 ----
          h('div', { style: box },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              h('strong', null, '关于插件'),
              h('span', { style: label }, 'v' + (cfg.version || '?')),
            ),
            h('div', { style: Object.assign({}, label, { margin: '4px 0 8px' }) },
              '多源检查更新（GitHub 直连 / 镜像 / Tags API），取版本号最大者。',
            ),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                style: btnPrimary,
                disabled: upd.state === 'loading',
                onClick: function () { checkUpdate(true); },
              }, upd.state === 'loading' ? '正在检查…' : '检查更新'),
              h('a', {
                href: cfg.repository || 'https://github.com/startime-ltk/dsh-mimavault',
                target: '_blank', rel: 'noopener noreferrer',
                style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }),
              }, '仓库主页'),
            ),
            upd.state === 'done'
              ? UpdateResult(upd)
              : null,
            upd.state === 'error'
              ? h('div', { style: { color: '#E74C3C', marginTop: 8 } }, '检查失败：' + (upd.message || ''))
              : null,
          ),

          notice ? h('div', { style: { color: '#1E88E5', marginBottom: 10 } }, notice) : null,

          h('div', { style: Object.assign({}, label, { fontSize: 11 }) },
            '本插件只向模型返回元数据；密码、备注内容、TOTP 种子不会进入对话。',
          ),
        );
      }

      /** 检查结果展示：已是最新 / 有新版本 / 检查失败 */
      function UpdateResult(r) {
        if (!r.ok) {
          return h('div', { style: { marginTop: 8 } },
            h('div', { style: { color: '#E74C3C' } }, r.message || '检查更新失败'),
            r.sources
              ? h('div', { style: Object.assign({}, label, { fontSize: 11, marginTop: 4 }) },
                  '源状态：' + r.sources.map(function (s) {
                    return s.name + (s.ok ? ' ✓' : ' ✗');
                  }).join(' · '),
                )
              : null,
          );
        }
        if (!r.hasUpdate) {
          return h('div', { style: { marginTop: 8, color: '#27AE60' } },
            '已是最新版本（v' + r.currentVersion + '）' + (r.cached ? ' · 缓存' : ''),
          );
        }
        return h('div', { style: {
          marginTop: 8, padding: '8px 10px', borderRadius: 6,
          background: 'rgba(230,126,34,.10)', border: '1px solid rgba(230,126,34,.4)',
        } },
          h('strong', { style: { color: '#E67E22' } },
            '发现新版本 v' + r.latestVersion + '（当前 v' + r.currentVersion + '）'),
          r.notes ? h('div', { style: label }, r.notes) : null,
          h('div', { style: Object.assign({}, label, { marginTop: 4 } ) },
            '版本源：' + (r.source || '-') + (r.cached ? ' · 缓存' : ''),
          ),
          r.updateHint ? h('div', { style: Object.assign({}, label, { marginTop: 6 } ) }, r.updateHint) : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('a', {
              href: r.releaseUrl || r.releasesUrl,
              target: '_blank', rel: 'noopener noreferrer',
              style: Object.assign({}, btnPrimary, { textDecoration: 'none', display: 'inline-block' }),
            }, '查看 Release'),
            h('a', {
              href: r.releasesUrl,
              target: '_blank', rel: 'noopener noreferrer',
              style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }),
            }, '全部版本'),
          ),
        );
      }

      function describeStatus(phase) {
        if (phase === 'ready') return '本地 API 可用。';
        if (phase === 'locked') return '请登录密匣，并在托盘菜单勾选「Local API (DSH)」。';
        if (phase === 'not_running') return '点「启动」拉起密匣。';
        if (phase === 'no_app') return '未找到安装位置，可在插件配置里填 appPath。';
        return '';
      }

      function apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: '密匣' },
            Glyph,
          );
        });
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel);
        });
      }

      exports.name = 'dsh-mimavault';
      exports.inject = ['slots'];
      exports.apply = apply;
      return module.exports;
    },
  });
})();
