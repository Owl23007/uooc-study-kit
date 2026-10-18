import { state, log } from './runtime.js';
import { ensureUI } from './ui.js';
import { quizDocs, updateQuizContext } from './quiz.js';
import { cancelTask } from './workflow.js';
import { resetRecovery, navigation, checkTestIgnorable, scanVideo, bindKeyboard, checkInlineQuiz } from './video.js';

export function scanAll() {
    state.scanTimer = null;
    if (!document.body) return;
    if (!state.panel?.isConnected) ensureUI();
    if (state.task && state.task.route !== `${location.pathname}${location.hash}`) cancelTask('已切换试卷');
    scanVideo();
    updateQuizContext();
    checkInlineQuiz();
    for (const observer of [...state.observers]) {
        if (observer.doc !== document && !observer.doc.defaultView?.frameElement?.isConnected) {
            observer.instance.disconnect();
            state.observedDocs.delete(observer.doc);
            state.observers.splice(state.observers.indexOf(observer), 1);
        }
    }
    for (const doc of quizDocs()) attachObserver(doc);
}
export function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(scanAll, 180);
}
export function attachObserver(doc) {
    if (state.observedDocs.has(doc) || !doc.documentElement) return;
    state.observedDocs.add(doc);
    const observer = new MutationObserver(records => {
        if (records.every(r => {
            const t = r.target instanceof Element ? r.target : r.target?.parentElement;
            return t?.closest?.('#uooc-assistant-host');
        })) return;
        scheduleScan();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'disabled', 'ng-if'] });
    state.observers.push({ doc, instance: observer });
    for (const iframe of doc.querySelectorAll('iframe')) iframe.addEventListener('load', scheduleScan, { once: true });
}

export function init() {
    if (state.started || !document.body) return;
    state.started = true;
    ensureUI();
    bindKeyboard();
    const markPlayerGesture = target => {
        const video = state.currentVideo;
        if (!video?.isConnected) return;
        const player = video.closest('.video-js, [uooc-video], .vjs-tech');
        if (target === video || player?.contains(target)) state.lastPlayerGesture = performance.now();
    };
    const interruptNavigation = event => {
        // 脚本原生 click 不产生可信手势，用户主动操作时取消尚未完成的连播
        const player = state.currentVideo?.closest('.video-js, [uooc-video], .vjs-tech');
        if (event.isTrusted && navigation.busy && !event.composedPath().includes(state.host) &&
            event.target !== state.currentVideo && !player?.contains(event.target)) navigation.cancel();
    };
    document.addEventListener('pointerdown', e => { interruptNavigation(e); markPlayerGesture(e.target); }, true);
    document.addEventListener('keydown', e => {
        interruptNavigation(e);
        if ([' ', 'Enter', 'k', 'K'].includes(e.key)) markPlayerGesture(e.target);
    }, true);
    attachObserver(document);
    scanAll();
    checkTestIgnorable();
    // SPA 路由与 iframe 动态挂载可能不触发全部监听，使用低频兜底
    setInterval(scheduleScan, 3000);
    const routeChanged = () => {
        navigation.routeChanged(location.hash);
        resetRecovery();
        clearTimeout(state.rateRestoreTimer);
        state.rateRestoreTimer = null;
        if (state.task && state.task.route !== `${location.pathname}${location.hash}`) cancelTask('已切换试卷');
        scheduleScan();checkTestIgnorable();
    };
    addEventListener('hashchange', routeChanged);
    addEventListener('popstate', routeChanged);
    addEventListener('pagehide', () => { cancelTask('离开页面'); navigation.cancel(); resetRecovery(); });
    log(`UOOC Assistant v${__APP_VERSION__} 已启动`);
}
export function start() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
}
