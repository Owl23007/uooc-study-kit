import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { state } from '../src/runtime.js';
import { navigation, nextVideo, scanVideo, resetRecovery } from '../src/video.js';
import { waitFor } from '../src/core.js';

let browser;
beforeEach(() => {
    browser = new Window({ url: 'https://www.uooc.net.cn/home/learn/index#/c/ch/s1/v1/section' });
    for (const key of ['document', 'location', 'Element']) {
        Object.defineProperty(globalThis, key, { configurable: true, value: browser[key] });
    }
    globalThis.window = browser;
    state.currentVideo = null;
    state.videoSrc = '';
    state.panel = null;
    state.manuallyPaused = false;
    state.wantsPlayback = true;
    state.lastPlayerGesture = -Infinity;
    Object.assign(state.prefs, { continuous: true, rate: true, mute: true });
    browser.addEventListener('hashchange', () => navigation.routeChanged(location.hash));
});
afterEach(async () => {
    navigation.cancel();
    resetRecovery();
    clearTimeout(state.rateRestoreTimer);
    state.rateRestoreTimer = null;
    state.videoBinding?.abort();
    state.currentVideo = null;
    await browser.happyDOM.close();
});

function player({ src = 'https://media.example/old.mp4', ended = true, deferred = false } = {}) {
    const video = document.createElement('video');
    video.id = 'player_html5_api';
    video.src = src;
    const media = { readyState: ended ? 4 : 0, ended, paused: true, currentSrc: src, plays: 0 };
    for (const key of ['readyState', 'ended', 'paused', 'currentSrc']) {
        Object.defineProperty(video, key, { configurable: true, get: () => media[key] });
    }
    const started = () => {
        media.readyState = 4;
        media.ended = false;
        media.paused = false;
        media.currentSrc = video.src;
        video.dispatchEvent(new browser.Event('loadedmetadata'));
        video.dispatchEvent(new browser.Event('play'));
    };
    video.play = () => {
        media.plays++;
        if (deferred) return new Promise(resolve => { media.complete = () => { started(); resolve(); }; });
        started();
        return Promise.resolve();
    };
    video.pause = () => { media.paused = true; video.dispatchEvent(new browser.Event('pause')); };
    document.body.append(video);
    return { video, media };
}

function resourcePair(onNext) {
    const list = document.createElement('div');
    list.innerHTML = '<div class="basic active"><span class="icon-video"></span></div><div class="basic"><span class="icon-video"></span></div>';
    document.body.append(list);
    list.lastElementChild.onclick = onNext;
}

test('旧版跨小节展开的中间路由不会取消任务，资源点击后会启动未缓冲的视频', async () => {
    const old = player();
    document.body.insertAdjacentHTML('beforeend', '<div id="catalog"><div><div class="basic active"><span class="icon-video"></span></div></div><div><div id="next-section"><button>展开小节</button></div></div></div>');
    const section = document.querySelector('#next-section');
    let next;
    let resourceClicks = 0;
    section.firstElementChild.onclick = () => {
        location.hash = '#/c/ch/s2';
        navigation.routeChanged(location.hash);
        section.insertAdjacentHTML('beforeend', '<div class="resourcelist"></div>');
        browser.setTimeout(() => {
            section.lastElementChild.innerHTML = '<div class="basic"><span class="icon-video"></span></div>';
            section.lastElementChild.firstElementChild.onclick = () => {
                resourceClicks++;
                location.hash = '#/c/ch/s2/v2/section';
                // 路由先变化，目录的 active 节点随后才重建
                navigation.routeChanged(location.hash);
                document.querySelector('.basic.active').classList.remove('active');
                section.lastElementChild.innerHTML = '<div class="basic active"><span class="icon-video"></span></div>';
                old.video.remove();
                next = player({ src: 'https://media.example/new.mp4', ended: false });
            };
        }, 5);
    };
    scanVideo();
    assert.equal(await nextVideo(), true);
    assert.equal(resourceClicks, 1);
    assert.equal(next.media.plays, 1);
    assert.equal(next.media.paused, false);
    assert.equal(next.video.playbackRate, 2);
    assert.equal(next.video.muted, true);
    assert.equal(navigation.busy, false);
    assert.equal(state.switching, false);
});

test('旧版复用 video 且 currentSrc 暂未更新时，依据新 src 发起播放加载', async () => {
    const current = player();
    resourcePair(() => {
        location.hash = '#/c/ch/s1/v2/section';
        navigation.routeChanged(location.hash);
        current.video.src = 'https://media.example/new.mp4';
        current.media.readyState = 0;
        current.media.ended = false;
    });
    scanVideo();
    assert.equal(await nextVideo(), true);
    assert.equal(current.media.plays, 1);
    assert.equal(current.media.currentSrc, 'https://media.example/new.mp4');
    assert.equal(current.media.paused, false);
});

test('视频结束事件会触发跳转并启动下一视频', async () => {
    const old = player();
    let next;
    resourcePair(() => {
        location.hash = '#/c/ch/s1/v2/section';
        old.video.remove();
        next = player({ src: 'https://media.example/new.mp4', ended: false });
    });
    scanVideo();
    old.video.dispatchEvent(new browser.Event('ended'));
    await waitFor(() => next?.media.plays === 1 && !navigation.busy);
    assert.equal(next.media.paused, false);
});

test('取消尚未完成的播放后释放锁，迟到的 play 结果不会重新恢复播放', async () => {
    const old = player();
    let next;
    resourcePair(() => {
        location.hash = '#/c/ch/s1/v2/section';
        old.video.remove();
        next = player({ src: 'https://media.example/new.mp4', ended: false, deferred: true });
    });
    scanVideo();
    const pending = nextVideo();
    await waitFor(() => next?.media.plays === 1);
    assert.equal(await nextVideo(), false);
    navigation.cancel();
    assert.equal(await pending, false);
    next.media.complete();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(next.media.paused, true);
    assert.equal(next.media.plays, 1);
    assert.equal(navigation.busy, false);
    assert.equal(state.switching, false);
});

test('自动播放被浏览器拒绝时显示失败状态并释放锁', async () => {
    const old = player();
    resourcePair(() => {
        location.hash = '#/c/ch/s1/v2/section';
        old.video.remove();
        const next = player({ src: 'https://media.example/new.mp4', ended: false });
        next.video.play = () => Promise.reject(new DOMException('需要用户点击', 'NotAllowedError'));
    });
    scanVideo();
    assert.equal(await nextVideo(), false);
    assert.equal(state.wantsPlayback, false);
    assert.equal(navigation.busy, false);
    assert.equal(state.switching, false);
});

test('旧版资源切换不改变 hash 时，仍能识别新媒体并恢复播放', async () => {
    const old = player();
    let next;
    const initialHash = location.hash;
    resourcePair(() => {
        old.video.remove();
        next = player({ src: 'https://media.example/new.mp4', ended: false });
    });
    scanVideo();
    assert.equal(await nextVideo(), true);
    assert.equal(location.hash, initialHash);
    assert.equal(next.media.plays, 1);
});

test('原站 ended 处理完成前不能点击目录销毁 Video.js 播放器', async () => {
    const old = player();
    let disposed = false;
    let checked = false;
    let next;
    resourcePair(() => {
        disposed = true;
        old.video.remove();
        next = player({ src: 'https://media.example/new.mp4', ended: false });
    });
    scanVideo();
    old.video.addEventListener('ended', () => {
        checked = true;
        assert.equal(disposed, false);
        assert.equal(old.video.isConnected, true);
    });
    old.video.dispatchEvent(new browser.Event('ended'));
    assert.equal(checked, true);
    assert.equal(disposed, false);
    await waitFor(() => next?.media.plays === 1 && !navigation.busy);
    assert.equal(next.media.paused, false);
});
