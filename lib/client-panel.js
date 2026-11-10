/**
 * dsh-mimavault —— 侧栏常驻面板（Client half / web bundle）
 *
 * 由 client-modules 通过 window.__ModuleLoader__ 加载，CommonJS 风格 factory(require)。
 * 无构建期依赖：
 *   1) 在侧栏面板列表（sidebar.panellist）注册一行，order 紧随 purge（30）之后；
 *   2) 点击该行切到 main 页，页面挂载时**自动调用宿主 /launch** 拉起密匣；
 *   3) 状态来自宿主 /status，只显示连接状态，不接触任何密码数据。
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

      function readJson(response) {
        return response.json();
      }

      function fetchStatus() {
        return fetch(BASE + '/status', { cache: 'no-store' }).then(readJson);
      }

      function requestLaunch() {
        return fetch(BASE + '/launch', { method: 'POST' }).then(readJson);
      }

      var TITLES = {
        loading: '正在检测…',
        ready: '已连接密匣',
        locked: '密匣已启动，未就绪',
        not_running: '密匣未运行',
        no_app: '未找到密匣',
        error: '检测失败',
      };

      var COLORS = {
        loading: '#999999',
        ready: '#27AE60',
        locked: '#E67E22',
        not_running: '#E74C3C',
        no_app: '#E74C3C',
        error: '#E74C3C',
      };

      function describe(state) {
        var phase = state.phase;
        if (phase === 'ready') {
          return '本地 API 端口 ' + state.port + '。密码 / API Key / 动态验证码均可检索。';
        }
        if (phase === 'locked') {
          return state.message || '请登录密匣，并在托盘菜单勾选「Local API (DSH)」。';
        }
        if (phase === 'not_running') {
          return '点击下方按钮启动密匣，然后在托盘菜单勾选「Local API (DSH)」。';
        }
        if (phase === 'no_app') {
          return state.message || '请在本插件配置里填写 appPath。';
        }
        return state.message || '';
      }

      function Panel() {
        var pair = React.useState({ phase: 'loading' });
        var state = pair[0];
        var setState = pair[1];

        function refresh() {
          fetchStatus().then(setState).catch(function (error) {
            setState({ phase: 'error', message: String((error && error.message) || error) });
          });
        }

        function launch() {
          setState({ phase: 'loading' });
          requestLaunch().then(setState).catch(function (error) {
            setState({ phase: 'error', message: String((error && error.message) || error) });
          });
        }

        React.useEffect(function () {
          var alive = true;
          // 进入面板即尝试拉起一次；已就绪时宿主会直接回报状态，不会重复启动。
          requestLaunch()
            .then(function (next) {
              if (alive) setState(next);
            })
            .catch(function () {
              if (alive) refresh();
            });
          var timer = setInterval(function () {
            if (alive) refresh();
          }, 4000);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        var phase = state.phase || 'loading';
        var buttonStyle = {
          padding: '5px 12px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,.35)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
        };

        return h(
          'div',
          { style: { padding: '18px 18px', fontSize: 13, lineHeight: 1.7 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            h('span', {
              style: {
                width: 8,
                height: 8,
                borderRadius: 4,
                background: COLORS[phase] || '#999999',
                flex: '0 0 auto',
              },
            }),
            h('strong', null, TITLES[phase] || phase),
          ),
          h('div', { style: { color: 'rgba(127,127,127,1)' } }, describe(state)),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 14 } },
            h('button', { style: buttonStyle, onClick: launch }, '启动 / 刷新'),
            h('button', { style: buttonStyle, onClick: refresh }, '只刷新状态'),
          ),
          h(
            'div',
            { style: { marginTop: 16, fontSize: 12, color: 'rgba(127,127,127,.9)' } },
            '本插件只读取元数据；密码、备注内容、TOTP 种子不会进入模型对话。',
          ),
          state.appPath
            ? h(
                'div',
                { style: { marginTop: 6, fontSize: 11, color: 'rgba(127,127,127,.7)', wordBreak: 'break-all' } },
                state.appPath,
              )
            : null,
        );
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
