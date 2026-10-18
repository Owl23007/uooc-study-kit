import { ui, state, log, info, warn, normalize } from './runtime.js';
import { createNavigationCoordinator } from './navigation.js';
import { PLAYER_SELECTOR, resolvePlatform } from './platform/index.js';

// ------------------------------------
// 视频控制：保持原有功能，不与测验面板重复挂载
// ------------------------------------
export function activeVideo() {
    return document.querySelector(PLAYER_SELECTOR);
}
export function hasInlineQuiz() {
    const layer = document.querySelector('#quizLayer');
    return !!(layer?.isConnected && layer.getClientRects?.().length);
}
const cancelledPlayback = new WeakSet();

export async function safePlay(video, reason = '恢复播放', { signal } = {}) {
    if (!video?.isConnected || video.ended || signal?.aborted) return false;
    cancelledPlayback.delete(video);
    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            let stopped = false;
            const finish = error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                if (error) reject(error); else resolve();
            };
            const cancel = () => {
                stopped = true;
                cancelledPlayback.add(video);
                video.pause();
                finish(new DOMException('播放已取消', 'AbortError'));
            };
            const timer = setTimeout(() => {
                stopped = true;
                cancelledPlayback.add(video);
                video.pause();
                finish(new Error('播放启动超时，请手动点击播放'));
            }, 10000);
            signal?.addEventListener('abort', cancel, { once: true });
            try {
                Promise.resolve(video.play()).then(() => {
                    if (stopped) { cancelledPlayback.add(video); video.pause(); }
                    finish();
                }, finish);
            } catch (error) { finish(error); }
        });
        return true;
    } catch (e) {
        if (e?.name === 'NotAllowedError') { state.wantsPlayback = false; ui.toast('浏览器阻止自动播放，请点击播放'); }
        if (e?.name !== 'AbortError') warn(`${reason}失败`, e?.message || e);
        return false;
    }
}
export function resetRecovery() {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
    state.recoveryStart = 0;
    state.recoveryAttempts = 0;
}
export function scheduleResume(video, reason = '播放被中断') {
    if (!video?.isConnected || video !== state.currentVideo || !state.wantsPlayback ||
        state.manuallyPaused || video.ended || state.switching || navigation.busy || cancelledPlayback.has(video) || hasInlineQuiz()) return;
    if (state.resumeTimer || !video.paused) return;
    if (video.readyState < 1 && !video.currentSrc && !video.src) return;
    const now = performance.now();
    if (now - state.recoveryStart > 12000) {
        state.recoveryStart = now;
        state.recoveryAttempts = 0;
    }
    // 限制异常播放器反复暂停时的恢复次数
    if (state.recoveryAttempts >= 3) return;
    state.resumeTimer = setTimeout(async () => {
        state.resumeTimer = null;
        if (video !== state.currentVideo || !video.isConnected || !video.paused || video.ended ||
            !state.wantsPlayback || state.manuallyPaused || state.switching || navigation.busy || cancelledPlayback.has(video) || hasInlineQuiz()) return;
        state.recoveryAttempts++;
        const ok = await safePlay(video, reason);
        if (ok) log('已恢复视频播放', reason);
        ui.refresh();
    }, 280);
}
export function togglePlayback() {
    const video = state.currentVideo;
    if (!video?.isConnected) return;
    if (video.paused) {
        state.manuallyPaused = false;
        state.wantsPlayback = true;
        resetRecovery();
        safePlay(video, '手动播放');
    } else {
        state.manuallyPaused = true;
        state.wantsPlayback = false;
        resetRecovery();
        clearTimeout(state.switchTimer);
        navigation.cancel();
        video.pause();
    }
    ui.refresh();
}
export function applyVideoPrefs(video, newMedia = false) {
    if (!video?.isConnected) return;
    if (newMedia) cancelledPlayback.delete(video);
    video.muted = !!state.prefs.mute;
    video.playbackRate = state.prefs.rate ? 2 : 1;
    // 连播开启时，新视频沿用播放意图，手动暂停始终优先
    if (newMedia && state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused) {
        scheduleResume(video, '新视频自动播放');
    }
}
export function restoreRate(video) {
    const desired = state.prefs.rate ? 2 : 1;
    if (video !== state.currentVideo || Math.abs(video.playbackRate - desired) < .01) return;
    if (state.rateRestoreTimer) return;
    const now = performance.now();
    if (now - state.rateRestoreStart > 12000) {
        state.rateRestoreStart = now;
        state.rateRestoreAttempts = 0;
    }
    if (state.rateRestoreAttempts >= 3) return;
    state.rateRestoreTimer = setTimeout(() => {
        state.rateRestoreTimer = null;
        if (video !== state.currentVideo || !video.isConnected) return;
        state.rateRestoreAttempts++;
        video.playbackRate = desired;
        ui.refresh();
    }, 100);
}
export const navigation = createNavigationCoordinator({
    resolveAdapter: () => resolvePlatform({ document, location, page: typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, canIgnoreTest: () => state.canIgnoreTest, log: info }),
    snapshot: () => {
        const video = activeVideo();
        return {
            hash: location.hash, pathname: location.pathname, video,
            src: video?.currentSrc || video?.src || '',
            source: video?.src || video?.querySelector('source[src]')?.src || video?.currentSrc || '',
            mediaEpoch: state.mediaEpoch,
        };
    },
    restore: async signal => {
        scanVideo();
        const video = state.currentVideo;
        if (!video) return;
        applyVideoPrefs(video);
        if (state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused && !hasInlineQuiz()) return safePlay(video, '连播恢复', { signal });
    },
    log: message => { info(message); ui.toast(message); },
    onState: busy => { state.switching = busy; ui.refresh(); },
});
export function nextVideo() { return navigation.next(); }

export async function checkTestIgnorable() {
    const match = location.href.match(/index#\/(\d+)\//);
    if (!match) { state.canIgnoreTest = false; state.checkedCourseId = null; return; }
    if (state.checkedCourseId === match[1]) return;
    state.checkedCourseId = match[1];
    state.canIgnoreTest = false;
    const courseId = match[1];
    try {
        const response = await fetch(`/home/learn/getCourseLearn?cid=${encodeURIComponent(match[1])}`, {
            credentials: 'include', signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return;
        const result = await response.json();
        if (state.checkedCourseId !== courseId) return;
        state.canIgnoreTest = result?.data?.course_learn_mode === '20';
        log('课程允许跨过测验：', state.canIgnoreTest);
    } catch (e) { warn('读取课程学习模式失败', e); }
}
export function bindVideo(v) {
    if (!v || state.videoEvents.has(v)) return;
    state.videoEvents.add(v);
    state.videoBinding?.abort();
    const binding = new AbortController();
    state.videoBinding = binding;
    const listen = (type, handler) => v.addEventListener(type, handler, { signal: binding.signal });
    listen('loadedmetadata', () => {
        if (state.currentVideo !== v) return;
        state.mediaEpoch++;
        state.videoSrc = v.currentSrc || v.src;
        applyVideoPrefs(v, true);
        ui.refresh();
    });
    listen('canplay', () => {
        if (state.currentVideo === v && state.prefs.continuous) scheduleResume(v, '视频已就绪');
    });
    listen('timeupdate', () => {
        if (!v.paused && performance.now() - state.lastPlaybackStarted > 4000 && state.recoveryAttempts) resetRecovery();
        ui.refresh();
    });
    listen('durationchange', () => ui.refresh());
    listen('play', () => {
        if (state.currentVideo !== v) return;
        cancelledPlayback.delete(v);
        state.wantsPlayback = true;
        state.manuallyPaused = false;
        state.lastPlaybackStarted = performance.now();
        clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
        ui.refresh();
    });
    listen('pause', () => {
        if (state.currentVideo !== v || v.ended || cancelledPlayback.has(v)) return;
        // 识别用户在原播放器上的暂停操作
        if (performance.now() - state.lastPlayerGesture < 1200) {
            state.manuallyPaused = true;
            state.wantsPlayback = false;
            navigation.cancel();
            resetRecovery();
        } else {
            scheduleResume(v);
        }
        ui.refresh();
    });
    listen('ratechange', () => {
        restoreRate(v);
        ui.refresh();
    });
    listen('volumechange', () => ui.refresh());
    listen('ended', () => {
        clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
        ui.refresh();
        if (state.currentVideo === v && state.prefs.continuous && !state.manuallyPaused) {
            state.wantsPlayback = true;
            clearTimeout(state.switchTimer);
            // 先让原站完成本次 ended 事件处理，再触发目录和播放器销毁
            state.switchTimer = setTimeout(nextVideo, 0);
        }
    });
    if (v.readyState >= 1) applyVideoPrefs(v, true);
}
export function scanVideo() {
    const v = activeVideo();
    if (v && (v !== state.currentVideo || (v.currentSrc || v.src) !== state.videoSrc)) {
        resetRecovery();
        if (state.currentVideo) state.videoEvents.delete(state.currentVideo);
        state.currentVideo = v;
        state.mediaEpoch++;
        state.videoSrc = v.currentSrc || v.src;
        state.rateRestoreStart = 0;
        state.rateRestoreAttempts = 0;
        bindVideo(v);
        applyVideoPrefs(v, true);
        info('播放器就绪', state.videoSrc ? '(已载入媒体)' : '(等待媒体)');
    } else if (v && state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused && v.paused && !v.ended) {
        scheduleResume(v, '持续播放');
    } else if (!v && state.currentVideo) {
        resetRecovery();
        state.videoBinding?.abort();
        state.videoEvents.delete(state.currentVideo);
        state.currentVideo = null;
        state.videoSrc = '';
    }
}
export function bindKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
        if (state.uiRoot?.querySelector('.overlay')) return;
        if (e.composedPath?.().includes(state.host)) return;
        const el = e.target;
        if (el instanceof Element && (el.closest('input,textarea,select,button,[contenteditable="true"]') || el.isContentEditable)) return;
        const v = state.currentVideo;
        if (!v?.isConnected || state.activeQuiz?.questions.length) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime=Math.max(0,v.currentTime-10); }
        if (e.key === 'ArrowRight') {
            const complete = document.querySelector('.basic.active')?.classList.contains('complete');
            if (complete) { e.preventDefault(); v.currentTime=Math.min(Number.isFinite(v.duration)?v.duration:v.currentTime+10,v.currentTime+10); }
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault(); v.volume=Math.max(0,Math.min(1,v.volume+(e.key==='ArrowUp'?.1:-.1)));
        }
        if (e.key === ' ') {
            e.preventDefault();
            togglePlayback();
        }
    });
}
export function checkInlineQuiz() {
    const layer = document.querySelector('#quizLayer');
    const sourceDiv = document.querySelector('div[uooc-video]');
    if (!layer || !sourceDiv || !hasInlineQuiz()) return;
    try {
        const source = JSON.parse(sourceDiv.getAttribute('source') || '{}');
        const title = document.querySelector('.smallTest-view .ti-q-c');
        if (!title || !Array.isArray(source.quiz)) return;
        const quiz = source.quiz.find(q => q.question === title.innerHTML);
        if (!quiz) return;
        const key = `${location.hash}:${normalize(title.textContent)}:${JSON.stringify(quiz.answer)}`;
        if (state.lastInlineQuiz === key) return;
        const answers = Array.isArray(quiz.answer) ? quiz.answer.map(String) :
            String(quiz.answer || '').match(/[A-Z]/gi) || [];
        const options = layer.querySelector('.ti-alist');
        if (!options) return;
        state.lastInlineQuiz = key;
        for (const letter of answers) options.children[letter.toUpperCase().charCodeAt(0) - 65]?.click();
        layer.querySelector('button')?.click();
        log('课中小测已处理');
    } catch (e) { warn('课中小测解析失败：', e); }
}
