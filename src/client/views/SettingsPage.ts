/**
 * views/SettingsPage.ts — 配置页（TPL 表 + 设置，5.9）真源 ESM，build 拼回 src/client/index.ts leaf。
 * （原来是 .js：调试分组搬进 views/diagnosticLog/ 之后按「动到哪里转到哪里」转成 TypeScript。
 * 本页现在只剩标题、总览、调试那一组一行挂载。2.0 硬分叉起删掉了上游的自更新入口与 base 包推广内容
 * （页头联系 / Star / Issue 静默簇、底部作者插件卡）：分叉版的更新改走插件市场索引，见 issue #3。）
 *
 * 跨叶子的值引用按仓里规矩写模块级 declare（实现只在闭包里有一份，类型检查各看各的）：
 * 全局已声明的（React、DswsCtx、tr）直接用；下面这几行是本文件自己声明的，只写本页实际用的形状。
 */
declare function useStore(sessionId?: unknown): { notice?: { kind: string; text: string } | null };
declare function useWsOverview(cx: unknown, sharedSt: unknown): { wsOverview: unknown; loadRef: unknown };
declare function renderWsOverview(
  h: unknown,
  sharedSt: unknown,
  wsOverview: unknown,
  loadRef: unknown,
  foldVer: number,
  setFoldVer: (v: number) => void,
): unknown;
declare const Icon: (props: { scheme: string; size: number }) => unknown;
declare const Ic: (props: { n: string; size: number; color?: string }) => unknown;
declare const NOTICE_COLOR: Record<string, string>;
declare function noticeIcon(kind: unknown): string;
declare const DSW_REPO_URL: string;
declare const DSW_VERSION: unknown;
declare const DiagnosticLogSection: (props: { sessionId?: unknown }) => unknown;
// #1802：设置页每次挂上来都重读一次本机设置文档。内核的惰性读只问一次，重开设置页不再重读，
//   于是别的窗口刚写进去的值看不到；重读要合并本窗还没落盘的待写格再替换内存文档（实现见 kernel/settings-view-reload.ts）。
declare function settingsViewReload(): void;
export     const SettingsPage = (props: { sessionId?: unknown }): unknown => {
      const cx = React.useContext(DswsCtx)
      const h = cx ? cx.h : React.createElement
      // T5 修订：订阅 store（设置页独立于面板 dock，需自己订阅 shared 才能渲染 flash toast）
      const sharedSt = cx ? cx.storeSvc.useStore(props && props.sessionId) : useStore(props && props.sessionId)
      // T2 悬停提示迁移：设置提示框的挂顶显示已统一交给 HoverTip 负责，显示悬停提示、移动悬停提示、隐藏悬停提示三个旧函数（showCfgTip/moveCfgTip/hideCfgTip）已经下线，移除了全局显示时序，方位与样式走统一配置表，页面行为没有变化
      const [foldVer, setFoldVer] = React.useState(0)
      // #1802 读侧：每次打开设置页重读一次文件，看到别的窗口刚写进去的值（不要求实时推送）。
      //   挂载时读一次，与仓里其它页面「挂载时取数」同一个模式；重读失败时保留原内存文档，不拿旧文档覆盖别人。
      React.useEffect(function (): void { settingsViewReload() }, [])
      // #492 调试分组已搬进 views/diagnosticLog/DiagnosticLogSection.ts（状态、跑腿、画法全在里面，
      //   本页只剩一行挂载）；拨开关写本机设置文件 debug 节、导出四键走宿主电话，口径一点没变。
      // 2026-09-21：这里原来有一项「打开位置」（点一下就写 cfg + 存档 + 全组广播，并落一行 settings.save）。
      //   面板现在只有 DSH 原生右侧边栏一条路，没有可选的入口，所以整项删除：
      //   两个状态、pickOpenIn、那一行 settings.save 日志与页面上的那一栏一并去掉。
      // #155 Q1 改：只读全局总览（wf.bindings + workspaces.list + wf.registry 色值，不可改；不调 wf.bind）
      // 数据装载与跳转收进 views/SettingsWorkspaces.js 的 useWsOverview（纯结构搬移，行为零变化）
      const overview = useWsOverview(cx, sharedSt)
      // T5 修订：设置页内 toast（独立于面板 dock 的 notice 渲染）
      const cfgNotice = sharedSt.notice
      return h('div', { className: 'dsws-cfg', style: { position: 'relative' } }, [
        cfgNotice ? h('div', { className: 'dsws-note', style: { display: 'flex', alignItems: 'center', gap: 6, top: 10, bottom: 'auto', right: 'auto', left: 14 } }, [
          Ic({ n: noticeIcon(cfgNotice.kind), size: 13, color: NOTICE_COLOR[cfgNotice.kind] || '#4ade80' }),
          h('span', null, cfgNotice.text),
        ]) : null,
        // 标题行：图标、标题、状态小字；状态小字旁显示构建注入的版本号（去 v 前缀），点了跳仓库首页。
        h('div', { className: 'dsws-cfg-head', style: { flexWrap: 'wrap' } }, [
          Icon({ scheme: 'compass', size: 20 }),
          h('span', { className: 't' }, tr('panel.title')),
          h('span', { className: 's', style: { color: 'var(--dsw-alias-label-caption,#8b8b95)' } }, [
            Ic({ n: 'dot', size: 12 }),
            h('span', null, tr('cfg.status')),
            // 版本号这一颗也是可点控件（点了跳仓库首页）：这次需求要求「每个可点控件」都有悬停、按压与点击日志，
            //   原清单没点名它，按同一意图补齐，日志名与同屏其它页面导航保持同一套英文枚举。
            h('a', { className: 'dsws-hov', 'data-press': 'icon', 'data-log': 'settings.version', href: DSW_REPO_URL, target: '_blank', rel: 'noreferrer', style: { fontSize: 11, color: 'var(--dsw-alias-label-caption,#8b8b95)', textDecoration: 'none' } }, (typeof DSW_VERSION === 'string' ? DSW_VERSION.replace(/^v/, '') : '')),
          ]),
        ]),
        h('div', { className: 'dsws-cfg-sub' }, tr('cfg.sub')),
        // 2026-09-21：这里原来是「打开位置」那一栏（DSH 右侧边栏 / BetterSidebar 二选一），整栏已删。
        //   面板只有 DSH 原生右侧边栏一条路，没有什么可选的，所以这一栏连着它的文案键一起撤掉。
        // #155 Q1 改：只读全局总览（wf.bindings + workspaces.list + wf.registry 色值，不可改；不调 wf.bind）
        // 分组渲染收进 views/SettingsWorkspaces.js 的 renderWsOverview（纯结构搬移，行为零变化）
        renderWsOverview(h, sharedSt, overview.wsOverview, overview.loadRef, foldVer, setFoldVer),

        // #492 沉底调试分组（布局文案沿 #334 原型：主开关默认关，写经 settingsDebugToggle（真源是本机设置文件的
        //   debug 节，宿主开机直接读它，见 #1012 第 8 条与 #1432），保存即广播；四键调宿主三电话加复用目录电话）
        h(DiagnosticLogSection, { sessionId: props && props.sessionId }),
        // T2 HoverTip 迁移：移除 sharedSt.cfgTip 全局 portal，改由 HoverTip 统一（行为零变化，翻转/样式走契约）
        null,
      ])
    }
