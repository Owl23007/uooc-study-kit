import { Storage } from './storage.js';
import { redact } from './core.js';

// UI 回调由面板注册，业务模块无需反向依赖面板实现
export const ui = { refresh() {}, records() {}, toast() {}, settings() {} };

export const TAG = '[UOOC AI]';
export const SCORE_SELECTOR = 'span[ng-if*="grade_score"]';
export const DEFAULTS = Object.freeze({
    rate: true, mute: true, continuous: true,
    collapsed: false, panelX: null, panelY: 76,
    concurrency: 4, batchSize: 3, timeout: 90000, retries: 1,
});
export const state = {
    prefs: { ...DEFAULTS }, busy: false, switching: false,
    panel: null, uiRoot: null, host: null, toastElement: null,
    currentVideo: null, videoSrc: '', mediaEpoch: 0,
    videoEvents: new WeakSet(), observedDocs: new WeakSet(), observers: [],
    scanTimer: null, quizTimer: null, switchTimer: null,
    activeQuiz: null, started: false, canIgnoreTest: false,
    lastInlineQuiz: '',
    task: null, taskSeq: 0, lastResult: null,
    logs: [], requests: [], requestSeq: 0, recordOpen: false,
    recordTab: 'requests', recordSelected: null,
    primaryMode: 'all', secondaryMode: 'all',
    wantsPlayback: true, manuallyPaused: false, lastPlayerGesture: -Infinity,
    resumeTimer: null, recoveryStart: 0, recoveryAttempts: 0,
    rateRestoreTimer: null, rateRestoreStart: 0, rateRestoreAttempts: 0,
    checkedCourseId: null, lastPlaybackStarted: 0,
};
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export function emitLog(level, ...args) {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const format = value => {
        if (value instanceof Error) return value.message;
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    };
    const message = redact(args.map(format).join(' '), Storage.get('llm_config', {})?.apiKey).slice(0, 500);
    state.logs.push({ level, time, message });
    if (state.logs.length > 250) state.logs.shift();
    (console[level] || console.log).call(console, TAG, message);
    if (state.recordOpen && state.recordTab === 'logs') ui.records();
}
export const log = (...args) => emitLog('log', ...args);
export const info = (...args) => emitLog('info', ...args);
export const warn = (...args) => emitLog('warn', ...args);
export const error = (...args) => emitLog('error', ...args);
export const normalize = (s) => String(s ?? '').replace(/\s+/g, '').replace(/^第?\d+[题.、:：)]/, '').trim();
export const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
export const letterAt = (i) => String.fromCharCode(65 + i);

Object.assign(state.prefs, Storage.get('assistant_prefs', {}) || {});
// 旧版 autoplay 与 continuous 合并，连播统一负责切节和新视频启动
delete state.prefs.autoplay;
export function savePrefs() { Storage.set('assistant_prefs', state.prefs); }

// 持久化数据也要校验，避免旧设置或异常值破坏调度
for (const [key, min, max] of [['concurrency', 1, 8], ['batchSize', 1, 10], ['retries', 0, 3], ['timeout', 5000, 180000]]) {
    const value = Number(state.prefs[key]);
    state.prefs[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : DEFAULTS[key];
}
