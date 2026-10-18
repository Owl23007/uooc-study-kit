import { ui, state, log, warn, error, savePrefs } from './runtime.js';
import { getWrongCache } from './quiz.js';
import { gmRequest } from './llm.js';
import { cancelTask, runQuiz } from './workflow.js';
import { resetRecovery, scheduleResume, togglePlayback, navigation } from './video.js';
import { Storage } from './storage.js';
import { redact, validateConfig } from './core.js';

export const ICON_PATHS = {
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1.05 1.56V20h-2.9v-.04A1.7 1.7 0 0 0 11 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 7.6 15a1.7 1.7 0 0 0-1.56-1.05H6v-2.9h.04A1.7 1.7 0 0 0 7.6 10a1.7 1.7 0 0 0-.34-1.88L7.2 8.06 9.06 6.2l.06.06A1.7 1.7 0 0 0 11 6.6a1.7 1.7 0 0 0 1.05-1.56V5h2.9v.04A1.7 1.7 0 0 0 16 6.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.05H21v2.9h-.04A1.7 1.7 0 0 0 19.4 15Z" transform="translate(-.5,-.5) scale(.96)"/>',
    minus: '<path d="M5 12h14"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    gauge: '<path d="M5 17a8 8 0 1 1 14 0"/><path d="m12 14 4-4"/><path d="M8 18h8"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a5 5 0 0 1 0 6"/><path d="M18 6a9 9 0 0 1 0 12"/>',
    muted: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 6m0-6-5 6"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    terminal: '<path d="m4 6 5 5-5 5"/><path d="M12 18h8"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
};
export const iconSvg = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

export function ensureUI() {
    Object.assign(ui, { refresh: refreshButtons, records: renderRecords, toast, settings: showSettings });
    if (state.panel?.isConnected) return;
    state.host?.remove();
    const host = document.createElement('div');
    host.id = 'uooc-assistant-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;contain:layout style';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    state.host = host;
    state.uiRoot = root;
    const style = document.createElement('style');
    style.textContent = `
        :host { color-scheme: dark; }
        *, *::before, *::after { box-sizing: border-box; }
        button, input { font: inherit; }
        button { cursor: pointer; border: 0; }
        button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        button:disabled { opacity: .43; cursor: not-allowed; }
        .panel, .modal, .toast { --surface:#222326;--raised:#2d2e32;--hover:#36373b;
            --line:#414246;--text:#e9e5df;--dim:#9c9a98;--accent:#c7b6a4;
            --accent-bg:rgba(199,182,164,.16);--success:#a6b8a5;--danger:#d08d90;
            font: 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
            color:var(--text);-webkit-font-smoothing:antialiased; }
        .panel { position:fixed;top:76px;right:20px;width:304px;max-width:calc(100vw - 16px);
            max-height:calc(100dvh - 16px);pointer-events:auto;display:flex;flex-direction:column;
            background:var(--surface);border:1px solid #454548;border-radius:14px;
            box-shadow:0 16px 55px rgba(0,0,0,.34);overflow:hidden;user-select:none; }
        .panel.dragging { box-shadow:0 20px 65px rgba(0,0,0,.47); }
        .hd { height:43px;min-height:43px;padding:0 10px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line); }
        .drag { width:24px;height:28px;display:grid;place-items:center;background:none;color:var(--dim);touch-action:none;
            cursor:grab;padding:0;border-radius:7px; }
        .drag:hover { color:var(--text);background:var(--hover); }
        .drag:active { cursor:grabbing; }
        .brand { font-size:12px;font-weight:750;letter-spacing:.3px; }
        .signal { width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--accent); }
        .status { color:var(--dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-align:right; }
        .icon { width:27px;height:27px;display:inline-flex;align-items:center;justify-content:center;
            border-radius:7px;background:none;color:var(--dim);line-height:1;padding:0; }
        .icon svg,.drag svg,.log-toggle svg { width:15px;height:15px;flex-shrink:0; }
        .icon:hover { background:var(--hover);color:var(--text); }
        .body { padding:12px;min-height:108px;overflow-y:auto;scrollbar-width:thin; }
        .panel.collapsed { width:164px; }
        .panel.collapsed .body, .panel.collapsed .log-section { display:none; }
        .panel.collapsed .hd { border-bottom:0; }
        .context-head { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:11px; }
        .context-title { color:var(--text);font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .context-meta { color:var(--dim);font-size:10px;white-space:nowrap; }
        .track { width:100%;height:3px;background:#454347;border-radius:99px;overflow:hidden; }
        .track > i { height:100%;display:block;width:0%;background:var(--accent);border-radius:99px;transition:width .18s linear; }
        .timeline { display:flex;justify-content:space-between;align-items:center;color:var(--dim);
            font-size:10px;font-variant-numeric:tabular-nums;margin:7px 0 11px; }
        .controls { display:grid;grid-template-columns:1.18fr .78fr 1fr 1fr;gap:6px; }
        .control { display:flex;align-items:center;justify-content:center;gap:5px;height:36px;
            min-width:0;background:var(--raised);color:var(--text);border-radius:9px;
            font-size:11px;font-weight:600;white-space:nowrap;padding:0 5px;transition:background .14s ease; }
        .control svg { width:14px;height:14px;flex-shrink:0; }
        .control:hover { background:var(--hover); }
        .control.on { color:var(--accent);background:var(--accent-bg); }
        .control.play { background:var(--accent);color:#252527; }
        .control.play:hover { background:#d9cabb; }
        .control[aria-pressed="true"] { border:1px solid rgba(199,182,164,.24); }
        .actions { display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:7px;margin-top:12px; }
        .btn { height:34px;border-radius:8px;padding:0 9px;color:var(--text);background:var(--raised);
            white-space:nowrap;font-size:11px;font-weight:650; }
        .btn:hover:not(:disabled) { background:var(--hover); }
        .btn.main { color:#252527;background:var(--accent); }
        .btn.main:hover:not(:disabled) { background:#d9cabb; }
        .btn.stop { color:var(--danger);background:rgba(208,141,144,.14); }
        .btn[hidden], .context[hidden], .task-stat[hidden], .log-section[hidden] { display:none !important; }
        .task-stat { display:grid;gap:7px;margin-top:12px; }
        .task-head { display:flex;justify-content:space-between;font-size:10px;color:var(--dim); }
        .log-section { border-top:1px solid var(--line); }
        .log-toggle { width:100%;display:flex;gap:8px;align-items:center;height:35px;padding:0 13px;
            color:#b4b0ac;background:none;text-align:left;font-size:11px; }
        .log-toggle .log-icon { display:inline-flex;align-items:center;justify-content:center;color:var(--dim); }
        .log-toggle .chevron { display:inline-flex;align-items:center;justify-content:center; }
        .log-toggle:hover { color:var(--text); }
        .log-toggle .count { color:var(--dim);margin-left:auto;font-variant-numeric:tabular-nums;font-size:10px; }
        .log-content { border-top:1px solid var(--line);padding:9px 10px 10px;max-height:min(42dvh,380px);overflow:auto;scrollbar-width:thin; }
        .tabs { display:flex;align-items:center;gap:4px;margin-bottom:8px; }
        .tab { padding:5px 10px;color:var(--dim);border-radius:6px;background:transparent;font-size:11px; }
        .tab.active { color:var(--text);background:var(--raised); }
        .tab-spacer { flex:1; }
        .text-action { font-size:10px;color:var(--dim);padding:4px 6px;border-radius:6px;background:none; }
        .text-action:hover { background:var(--hover);color:var(--text); }
        .request-row { display:flex;width:100%;align-items:center;gap:8px;text-align:left;padding:8px 5px;
            color:var(--text);background:transparent;border-radius:7px; }
        .request-row:hover { background:var(--raised); }
        .request-row .number { min-width:31px;color:var(--dim);font-size:10px; }
        .request-row .details { flex:1;min-width:0;display:grid;gap:1px; }
        .request-row .details strong { font-size:11px;font-weight:550; }
        .request-row .details small { font-size:10px;color:var(--dim); }
        .request-row .elapsed { color:var(--dim);font-variant-numeric:tabular-nums;font-size:10px; }
        .dot { width:6px;height:6px;border-radius:50%;background:#8a8786;flex:0 0 6px; }
        .dot.running { background:var(--accent); }
        .dot.success { background:var(--success); }
        .dot.error, .dot.timeout { background:var(--danger); }
        .dot.cancelled { background:#8a8786; }
        .request-extra { padding:7px 10px 10px;margin:0 5px 5px 13px;border-left:1px solid var(--line);
            font:10px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dim);white-space:pre-wrap;word-break:break-word; }
        .log-row { padding:5px 4px;border-bottom:1px solid #37383b;font:10px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
            white-space:pre-wrap;word-break:break-word;color:#bdbab5; }
        .log-row .log-time { color:#898786;padding-right:9px; }
        .log-row.warn { color:var(--accent); }.log-row.error { color:var(--danger); }
        .empty { padding:18px 6px;text-align:center;color:var(--dim);font-size:11px; }
        .toast { position:fixed;bottom:18px;right:18px;max-width:min(370px,calc(100vw - 36px));
            background:#292a2d;color:var(--text);padding:10px 12px;border-radius:9px;border:1px solid #48484a;
            box-shadow:0 15px 45px #0006;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s; }
        .toast.show { opacity:1;transform:translateY(0); }
        .overlay { position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;
            background:rgba(10,10,12,.63);pointer-events:auto;backdrop-filter:blur(4px); }
        .modal { width:min(410px,100%);max-height:calc(100dvh - 32px);overflow:auto;scrollbar-width:thin;
            background:#252629;border:1px solid #49494d;border-radius:13px;padding:17px 18px;
            box-shadow:0 22px 70px #0009; }
        .modal h3 { font-size:14px;margin:0 0 13px;font-weight:700; }
        .modal label { display:block;width:100%;min-width:0;margin:0 0 10px;color:#c5c0b9;font-size:11px; }
        .modal input[type="text"],.modal input[type="password"],.modal input[type="number"] {
            display:block;width:100%;height:35px;margin-top:5px;min-width:0;border:1px solid #515157;
            border-radius:7px;background:#303136;padding:0 10px;color:var(--text);font-size:12px;outline:none; }
        .modal input:focus { border-color:var(--accent); }
        .modal .grid2 { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px; }
        .modal #uc-test-status { align-self:end;min-width:0;margin:0;color:var(--dim);font-size:11px; }
        .modal .row { display:flex;align-items:center;gap:8px;margin:7px 0 13px;font-size:11px;color:var(--dim); }
        .modal .row input { accent-color:var(--accent); }
        .modal .buttons { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:15px; }
        .modal .buttons .btn { min-width:66px; }
        .modal .button-group { display:flex;gap:8px; }
        @media(max-width:370px) { .modal .grid2 { grid-template-columns:1fr;gap:0; } }
    `;
    root.append(style);
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `
        <div class="hd">
            <button class="drag" title="拖动" aria-label="拖动">${iconSvg('grip')}</button>
            <span class="signal"></span><span class="brand">UOOC</span>
            <span class="status" id="uooc-status">就绪</span>
            <button class="icon" id="uooc-settings" title="设置" aria-label="设置">${iconSvg('settings')}</button>
            <button class="icon" id="uooc-collapse" title="收起" aria-label="收起">${iconSvg('minus')}</button>
        </div>
        <div class="body">
            <div class="context" id="uooc-video-view" hidden>
                <div class="context-head"><span class="context-title">视频播放</span><span class="context-meta" id="uooc-video-rate">1×</span></div>
                <div class="track"><i id="uooc-video-fill"></i></div>
                <div class="timeline"><span id="uooc-video-time">00:00</span><span id="uooc-video-duration">00:00</span></div>
                <div class="controls">
                    <button class="control play" id="uooc-play">${iconSvg('play')}<span>播放</span></button>
                    <button class="control" id="uooc-rate" title="倍速">${iconSvg('gauge')}<span>2×</span></button>
                    <button class="control" id="uooc-mute">${iconSvg('muted')}<span>静音</span></button>
                    <button class="control" id="uooc-continuous" title="自动播放并切换下一节">${iconSvg('repeat')}<span>连播</span></button>
                </div>
            </div>
            <div class="context" id="uooc-quiz-view" hidden>
                <div class="context-head"><span class="context-title">章节测验</span><span class="context-meta" id="uooc-quiz-state">0 题</span></div>
                <div class="actions">
                    <button class="btn main" id="uooc-primary">开始答题</button>
                    <button class="btn" id="uooc-secondary">全部答题</button>
                </div>
                <div class="task-stat" id="uooc-task-stat" hidden>
                    <div class="task-head"><span id="uooc-task-description"></span><span id="uooc-task-elapsed"></span></div>
                    <div class="track"><i id="uooc-task-fill"></i></div>
                </div>
            </div>
            <div class="context" id="uooc-empty-view"><div class="context-head" style="margin:0"><span class="context-title">等待课程内容</span></div></div>
        </div>
        <div class="log-section">
            <button class="log-toggle" id="uooc-log-toggle" aria-expanded="false">
                <span class="log-icon">${iconSvg('terminal')}</span><span>运行记录</span><span class="count" id="uooc-log-count">0</span><span class="chevron" id="uooc-log-chevron">${iconSvg('chevronDown')}</span>
            </button>
            <div class="log-content" id="uooc-log-content" hidden>
                <div class="tabs">
                    <button class="tab active" data-log-tab="requests">请求</button>
                    <button class="tab" data-log-tab="logs">日志</button>
                    <span class="tab-spacer"></span>
                    <button class="text-action" id="uooc-log-copy">复制</button>
                    <button class="text-action" id="uooc-log-clear">清空</button>
                </div>
                <div id="uooc-log-items"></div>
            </div>
        </div>`;
    root.append(panel);
    const toastElement = document.createElement('div');
    toastElement.className = 'toast';
    root.append(toastElement);
    state.toastElement = toastElement;
    state.panel = panel;

    const $ = sel => panel.querySelector(sel);
    $('#uooc-collapse').addEventListener('click', () => {
        state.prefs.collapsed = !state.prefs.collapsed;
        savePrefs(); refreshButtons(); clampPanel();
    });
    $('#uooc-settings').addEventListener('click', showSettings);
    $('#uooc-play').addEventListener('click', () => togglePlayback());
    for (const key of ['rate', 'mute', 'continuous']) {
        $(`#uooc-${key}`).addEventListener('click', () => {
            state.prefs[key] = !state.prefs[key];
            savePrefs();
            const v = state.currentVideo;
            if (v && key === 'rate') v.playbackRate = state.prefs.rate ? 2 : 1;
            if (v && key === 'mute') v.muted = state.prefs.mute;
            if (key === 'continuous' && !state.prefs.continuous) { navigation.cancel(); resetRecovery(); }
            if (key === 'continuous' && state.prefs.continuous && v && !state.manuallyPaused && v.paused && !v.ended) {
                state.wantsPlayback = true;
                scheduleResume(v, '开启连播');
            }
            refreshButtons();
        });
    }
    $('#uooc-primary').addEventListener('click', () => {
        if (state.task) cancelTask();
        else runQuiz(state.primaryMode || 'all');
    });
    $('#uooc-secondary').addEventListener('click', () => runQuiz(state.secondaryMode || 'all'));
    $('#uooc-log-toggle').addEventListener('click', () => {
        state.recordOpen = !state.recordOpen;
        $('#uooc-log-content').hidden = !state.recordOpen;
        $('#uooc-log-toggle').setAttribute('aria-expanded', String(state.recordOpen));
        $('#uooc-log-chevron').innerHTML = iconSvg(state.recordOpen ? 'chevronUp' : 'chevronDown');
        renderRecords();
    });
    panel.querySelectorAll('[data-log-tab]').forEach(btn => btn.addEventListener('click', () => {
        state.recordTab = btn.dataset.logTab;
        renderRecords();
    }));
    $('#uooc-log-clear').addEventListener('click', () => {
        state.logs = [];
        state.requests = state.requests.filter(r => r.status === 'running');
        state.recordSelected = null;
        renderRecords();
    });
    $('#uooc-log-copy').addEventListener('click', async () => {
        const content = state.recordTab === 'requests'
            ? state.requests.map(r => `${r.id}\t${r.method}\t${r.batch}\t${r.status}\t${r.httpStatus || '-'}\t${r.duration || '-'}ms\t${r.error || ''}`).join('\n')
            : state.logs.map(r => `${r.time}\t${r.level}\t${r.message}`).join('\n');
        try { await navigator.clipboard.writeText(content); toast('已复制'); }
        catch (err) { warn('复制失败', err?.message || err); toast('复制失败'); }
    });
    $('#uooc-log-items').addEventListener('click', e => {
        const row = e.target.closest('[data-request-id]');
        if (!row) return;
        state.recordSelected = state.recordSelected === Number(row.dataset.requestId) ? null : Number(row.dataset.requestId);
        renderRecords();
    });
    installDrag(panel, $('.drag'));
    refreshButtons();
    log('面板就绪');
}

export const $panel = selector => state.panel?.querySelector(selector);
export function toast(message, ms = 3000) {
    const el = state.toastElement;
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}
export function renderRecords() {
    if (!state.panel) return;
    const count = state.requests.filter(r => r.status === 'running').length;
    $panel('#uooc-log-count').textContent = count ? `${count} 活动` : String(state.requests.length);
    if (!state.recordOpen) return;
    state.panel.querySelectorAll('[data-log-tab]').forEach(x => x.classList.toggle('active', x.dataset.logTab === state.recordTab));
    const root = $panel('#uooc-log-items');
    root.replaceChildren();
    if (state.recordTab === 'logs') {
        if (!state.logs.length) { root.innerHTML = '<div class="empty">暂无日志</div>'; return; }
        for (const entry of state.logs.slice(-80).reverse()) {
            const div = document.createElement('div');
            div.className = `log-row ${entry.level}`;
            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = entry.time;
            div.append(time, document.createTextNode(entry.message));
            root.append(div);
        }
        return;
    }
    if (!state.requests.length) { root.innerHTML = '<div class="empty">暂无请求</div>'; return; }
    for (const entry of state.requests.slice(-45).reverse()) {
        const row = document.createElement('button');
        row.className = 'request-row';
        row.dataset.requestId = String(entry.id);
        const statusClass = ['running', 'success', 'error', 'timeout', 'cancelled'].includes(entry.status) ? entry.status : 'running';
        row.innerHTML = `<span class="dot ${statusClass}"></span><span class="number">#${entry.id}</span><span class="details"></span><span class="elapsed"></span>`;
        row.querySelector('.details').replaceChildren();
        const strong = document.createElement('strong');
        strong.textContent = `批次 ${entry.batch}${entry.correction ? ' · 修正' : ''}`;
        const sub = document.createElement('small');
        const statusLabels = { running: '请求中', success: '已完成', error: '失败', timeout: '超时', cancelled: '已取消' };
        sub.textContent = `${entry.questionIds} · ${statusLabels[entry.status] || entry.status}`;
        row.querySelector('.details').append(strong, sub);
        row.querySelector('.elapsed').textContent = entry.status === 'running'
            ? `${((performance.now() - entry.started) / 1000).toFixed(1)}s` : `${entry.duration ?? 0}ms`;
        root.append(row);
        if (state.recordSelected === entry.id) {
            const extra = document.createElement('div');
            extra.className = 'request-extra';
            extra.textContent = `状态 ${entry.status}\nHTTP ${entry.httpStatus ?? '-'}\n尝试 ${entry.attempt}\n耗时 ${entry.duration ?? '-'}ms\nTokens ${entry.tokens ?? '-'}${entry.error ? `\n错误 ${entry.error}` : ''}`;
            root.append(extra);
        }
    }
}
export function refreshButtons() {
    const panel = state.panel;
    if (!panel) return;
    panel.classList.toggle('collapsed', !!state.prefs.collapsed);
    $panel('#uooc-collapse').innerHTML = state.prefs.collapsed ? iconSvg('chevronDown') : iconSvg('minus');
    const context = state.activeQuiz;
    const questions = context?.questions || [];
    const scores = questions.filter(q => q.score?.graded);
    const cache = getWrongCache(context);
    const wrong = scores.length ? questions.filter(q => q.score?.wrong) : questions.filter(q => cache?.keys.includes(q.fingerprint));
    const showQuiz = questions.length > 0;
    const showVideo = !showQuiz && !!state.currentVideo?.isConnected;
    $panel('#uooc-quiz-view').hidden = !showQuiz;
    $panel('#uooc-video-view').hidden = !showVideo;
    $panel('#uooc-empty-view').hidden = showQuiz || showVideo;
    const task = state.task;
    let status = task ? '运行中' : showQuiz ? (scores.length ? '已批改' : '测验') : showVideo ? '视频' : '就绪';
    $panel('#uooc-status').textContent = status;
    if (showQuiz) {
        $panel('#uooc-quiz-state').textContent = scores.length
            ? `${wrong.length} 错 / ${questions.length} 题` : `${questions.length} 题`;
        const primary = $panel('#uooc-primary');
        const secondary = $panel('#uooc-secondary');
        const failed = state.lastResult?.route === `${location.pathname}${location.hash}`
            ? state.lastResult.failedKeys.filter(key => questions.some(q => q.fingerprint === key)) : [];
        state.primaryMode = failed.length ? 'retry' : wrong.length ? 'wrong' : 'all';
        state.secondaryMode = 'all';
        primary.textContent = task ? '停止' : state.primaryMode === 'wrong' ? '重做错题' : state.primaryMode === 'retry' ? '重试未完成' : '开始答题';
        primary.classList.toggle('stop', !!task);
        primary.classList.toggle('main', !task);
        primary.disabled = !task && !!scores.length && !wrong.length && !failed.length;
        secondary.textContent = '全部答题';
        secondary.hidden = !!task || (!scores.length && !wrong.length && !failed.length);
        secondary.disabled = !!task;
        const stat = $panel('#uooc-task-stat');
        const last = state.lastResult;
        const relevantLast = last?.route === `${location.pathname}${location.hash}`;
        stat.hidden = !(task || relevantLast);
        if (task) {
            const total = task.questions.length;
            $panel('#uooc-task-description').textContent = `${task.filled}/${total} 已填 · ${task.finished}/${total} 已处理`;
            $panel('#uooc-task-fill').style.width = `${total ? task.finished / total * 100 : 0}%`;
            $panel('#uooc-task-elapsed').textContent = `${Math.round((performance.now() - task.started) / 1000)}s`;
        } else if (relevantLast) {
            $panel('#uooc-task-description').textContent = `${last.filled}/${last.total} 已填${last.failedKeys.length ? ` · ${last.failedKeys.length} 未完成` : ''}`;
            $panel('#uooc-task-fill').style.width = `${last.total ? (last.total - last.failedKeys.length) / last.total * 100 : 0}%`;
            $panel('#uooc-task-elapsed').textContent = last.cancelled ? '已停止' : '已完成';
        }
    }
    if (showVideo) {
        const video = state.currentVideo;
        $panel('#uooc-play').innerHTML = video.paused
            ? `${iconSvg('play')}<span>播放</span>` : `${iconSvg('pause')}<span>暂停</span>`;
        $panel('#uooc-play').setAttribute('aria-label', video.paused ? '播放' : '暂停');
        $panel('#uooc-rate').querySelector('span').textContent = `${video.playbackRate || 1}×`;
        $panel('#uooc-rate').classList.toggle('on', video.playbackRate > 1);
        $panel('#uooc-rate').setAttribute('aria-pressed', String(video.playbackRate > 1));
        $panel('#uooc-mute').innerHTML = `${iconSvg(video.muted ? 'muted' : 'volume')}<span>${video.muted ? '静音' : '声音'}</span>`;
        $panel('#uooc-mute').classList.toggle('on', video.muted);
        $panel('#uooc-mute').setAttribute('aria-pressed', String(video.muted));
        $panel('#uooc-continuous').classList.toggle('on', state.prefs.continuous);
        $panel('#uooc-continuous').setAttribute('aria-pressed', String(state.prefs.continuous));
        $panel('#uooc-video-rate').textContent = `${video.playbackRate || 1}×`;
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        $panel('#uooc-video-time').textContent = formatTime(video.currentTime);
        $panel('#uooc-video-duration').textContent = formatTime(duration);
        $panel('#uooc-video-fill').style.width = `${duration ? Math.max(0, Math.min(100, video.currentTime / duration * 100)) : 0}%`;
    }
    renderRecords();
}
export function formatTime(seconds) {
    const s = Math.floor(Number(seconds) || 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function progress(message) {
    if (state.task) state.task.status = message;
    refreshButtons();
}
export function clampPanel() {
    const panel = state.panel;
    if (!panel || !Number.isFinite(state.prefs.panelX)) return;
    const x = Math.max(8, Math.min(state.prefs.panelX, Math.max(8, innerWidth - panel.offsetWidth - 8)));
    const y = Math.max(8, Math.min(state.prefs.panelY ?? 76, Math.max(8, innerHeight - panel.offsetHeight - 8)));
    panel.style.left = `${x}px`;
    panel.style.right = 'auto';
    panel.style.top = `${y}px`;
    state.prefs.panelX = x;
    state.prefs.panelY = y;
}
export function installDrag(panel, handle) {
    let drag;
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const rect = panel.getBoundingClientRect();
        drag = { id: e.pointerId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
        handle.setPointerCapture?.(e.pointerId);
        panel.classList.add('dragging');
        e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        state.prefs.panelX = Math.round(Math.max(8, Math.min(e.clientX - drag.offsetX, innerWidth - panel.offsetWidth - 8)));
        state.prefs.panelY = Math.round(Math.max(8, Math.min(e.clientY - drag.offsetY, innerHeight - panel.offsetHeight - 8)));
        clampPanel();
    });
    const stop = e => {
        if (!drag || drag.id !== e.pointerId) return;
        try { if (handle.hasPointerCapture?.(drag.id)) handle.releasePointerCapture(drag.id); } catch (_) { }
        drag = null;
        panel.classList.remove('dragging');
        savePrefs();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    addEventListener('resize', clampPanel);
    clampPanel();
}
export function showSettings() {
    state.uiRoot.querySelector('.overlay')?.remove();
    const config = Storage.get('llm_config', {}) || {};
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="UOOC 设置">
        <h3>设置</h3>
        <label>API Base URL<input id="uc-url" type="text" placeholder="https://api.openai.com/v1"></label>
        <label>API Key<input id="uc-key" type="password" autocomplete="off" placeholder="sk-..."></label>
        <label>模型<input id="uc-model" type="text" placeholder="模型 ID"></label>
        <div class="grid2">
            <label>并发<input id="uc-concurrency" type="number" min="1" max="8"></label>
            <label>每批题数<input id="uc-batch" type="number" min="1" max="10"></label>
            <label>超时（秒）<input id="uc-timeout" type="number" min="5" max="180"></label>
            <label>重试<input id="uc-retries" type="number" min="0" max="3"></label>
            <label>temperature<input id="uc-temperature" type="number" min="0" max="2" step="0.1" placeholder="留空使用服务商默认值"></label>
            <p id="uc-test-status" role="status"></p>
        </div>
        <div class="buttons"><button class="btn" id="uc-test">测试连接</button><span class="button-group"><button class="btn" id="uc-cancel">取消</button><button class="btn main" id="uc-save">保存</button></span></div>
    </div>`;
    state.uiRoot.append(overlay);
    const $ = id => overlay.querySelector(`#${id}`);
    $('uc-url').value = config.baseUrl || '';
    $('uc-key').value = config.apiKey || '';
    $('uc-model').value = config.model || '';
    $('uc-temperature').value = config.temperature ?? '';
    $('uc-concurrency').value = state.prefs.concurrency;
    $('uc-batch').value = state.prefs.batchSize;
    $('uc-timeout').value = Math.round(state.prefs.timeout / 1000);
    $('uc-retries').value = state.prefs.retries;
    const testTask = { activeRequests: new Set(), cancelled: false };
    const close = () => {
        testTask.cancelled = true;
        for (const cancel of [...testTask.activeRequests]) cancel();
    };
    const watchClose = new MutationObserver(() => {
        if (!overlay.isConnected) { close(); watchClose.disconnect(); }
    });
    watchClose.observe(state.uiRoot, { childList: true });
    $('uc-test').addEventListener('click', async () => {
        const status = $('uc-test-status');
        $('uc-test').disabled = true;
        try {
            const config = validateConfig({ baseUrl: $('uc-url').value.trim(), apiKey: $('uc-key').value.trim(), model: $('uc-model').value.trim(), temperature: $('uc-temperature').value });
            status.textContent = '连接中…';
            await gmRequest(`${config.baseUrl}/chat/completions`, config, [], Math.min(state.prefs.timeout, 15000), new Map(), new Map(), { task: testTask, test: true });
            status.textContent = '连接成功，模型已响应';
        } catch (err) { status.textContent = `连接失败：${redact(err.message, $('uc-key').value.trim())}`; }
        finally { $('uc-test').disabled = false; }
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    $('uc-cancel').addEventListener('click', () => overlay.remove());
    $('uc-save').addEventListener('click', () => {
        const baseUrl = $('uc-url').value.trim().replace(/\/+$/, '');
        const apiKey = $('uc-key').value.trim();
        const model = $('uc-model').value.trim();
        try { Storage.set('llm_config', validateConfig({ baseUrl, apiKey, model, temperature: $('uc-temperature').value })); }
        catch (err) { toast(err.message); return; }
        const clamp = (id, min, max) => Math.min(max, Math.max(min, Math.floor(Number($(id).value)) || min));
        state.prefs.concurrency = clamp('uc-concurrency', 1, 8);
        state.prefs.batchSize = clamp('uc-batch', 1, 10);
        state.prefs.timeout = clamp('uc-timeout', 5, 180) * 1000;
        state.prefs.retries = clamp('uc-retries', 0, 3);
        savePrefs();
        overlay.remove(); toast('已保存');
        log('配置已更新', { concurrency: state.prefs.concurrency, batchSize: state.prefs.batchSize, timeout: state.prefs.timeout, retries: state.prefs.retries });
    });
}
