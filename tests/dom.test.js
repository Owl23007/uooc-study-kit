import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { state } from '../src/runtime.js';
import { ensureUI, showSettings, refreshButtons } from '../src/ui.js';
import { checkInlineQuiz, scanVideo, resetRecovery, bindVideo } from '../src/video.js';
import { extractQuestions } from '../src/quiz.js';
import { fillAnswers } from '../src/workflow.js';

const window = new Window({ url: 'https://www.uooc.net.cn/home/learn/index#/c/ch/s/v/section' });
const storage = new Map();
before(() => {
    for (const key of ['document', 'location', 'MutationObserver', 'Element', 'navigator']) {
        Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
    }
    globalThis.window = window;
    globalThis.addEventListener = window.addEventListener.bind(window);
    globalThis.GM_getValue = (key, fallback) => storage.get(key) ?? fallback;
    globalThis.GM_setValue = (key, value) => storage.set(key, value);
});
afterEach(() => {
    resetRecovery();
    state.videoBinding?.abort();
    state.currentVideo = null;
    state.activeQuiz = null;
    state.task = null;
    state.host?.remove();
    state.panel = null;
    state.uiRoot = null;
    state.toastElement = null;
    window.document.body.replaceChildren();
});
after(async () => { await window.happyDOM.close(); });

test('面板重复初始化只创建一个实例，设置校验后保存在 GM 存储', () => {
    ensureUI();
    ensureUI();
    assert.equal(document.querySelectorAll('#uooc-assistant-host').length, 1);
    showSettings();
    const root = state.uiRoot;
    root.querySelector('#uc-url').value = 'https://example.com/v1';
    root.querySelector('#uc-key').value = 'local-test-token';
    root.querySelector('#uc-model').value = 'demo';
    root.querySelector('#uc-concurrency').value = '99';
    root.querySelector('#uc-save').click();
    assert.equal(storage.get('llm_config').apiKey, 'local-test-token');
    assert.equal(storage.get('assistant_prefs').concurrency, 8);
    assert.equal(window.localStorage.length, 0);
    assert.equal(root.querySelector('.overlay'), null);
});

test('连接测试使用未保存的表单配置且不会发送真实题目', async () => {
    ensureUI();
    showSettings();
    let payload;
    globalThis.GM_xmlhttpRequest = options => {
        payload = JSON.parse(options.data);
        queueMicrotask(() => options.onload({ status: 200, responseText: '{"choices":[{"message":{"content":"OK"}}]}' }));
        return { abort() {} };
    };
    state.uiRoot.querySelector('#uc-test').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.uiRoot.querySelector('#uc-test-status').textContent, '连接成功，模型已响应');
    assert.ok(payload.messages[1].content.includes('连接测试'));
    assert.ok(!payload.messages[1].content.includes('题目内容'));
});

test('两种页面使用同一个面板，测验仅回填而不提交', () => {
    document.body.innerHTML = `<video id="player_html5_api"></video>
      <div id="examMain"><div class="queContainer"><div class="ti-q-c">测试题干</div>
      <label class="ti-a"><span class="ti-a-i">A</span><span class="ti-a-c">答案一</span><input name="q" type="radio"></label>
      <label class="ti-a"><span class="ti-a-i">B</span><span class="ti-a-c">答案二</span><input name="q" type="radio"></label></div>
      <button id="submit-paper">提交试卷</button></div>`;
    state.prefs.continuous = false;
    ensureUI();
    const panel = state.panel;
    scanVideo();
    refreshButtons();
    assert.equal(panel.querySelector('#uooc-video-view').hidden, false);
    state.activeQuiz = extractQuestions();
    refreshButtons();
    assert.equal(state.panel, panel);
    assert.equal(panel.querySelector('#uooc-quiz-view').hidden, false);
    let submissions = 0;
    document.querySelector('#submit-paper').onclick = () => { submissions++; };
    const result = fillAnswers(state.activeQuiz.questions, new Map([[1, ['B']]]));
    assert.equal(result.filled, 1);
    assert.equal(document.querySelectorAll('input')[1].checked, true);
    assert.equal(submissions, 0);
});

test('保留课中小测自动选择和点击，重复扫描不会重复执行', () => {
    state.lastInlineQuiz = '';
    document.body.innerHTML = `<div uooc-video></div><div id="quizLayer">
      <div class="smallTest-view"><div class="ti-q-c">题干</div></div>
      <div class="ti-alist"><li>A</li><li>B</li></div><button id="inline-submit">确认</button></div>`;
    document.querySelector('[uooc-video]').setAttribute('source', JSON.stringify({ quiz: [{ question: '题干', answer: ['B'] }] }));
    document.querySelector('#quizLayer').getClientRects = () => [{}];
    let choices = 0;
    let submissions = 0;
    document.querySelector('#inline-submit').onclick = () => { submissions++; };
    document.querySelector('.ti-alist').children[1].onclick = () => { choices++; };
    checkInlineQuiz();
    checkInlineQuiz();
    assert.equal(choices, 1);
    assert.equal(submissions, 1);
});

test('播放器重建后移除旧事件监听，新播放器恢复倍速和静音', () => {
    state.prefs.continuous = false;
    state.prefs.rate = true;
    state.prefs.mute = true;
    document.body.innerHTML = '<video id="player_html5_api"></video>';
    const old = document.querySelector('video');
    scanVideo();
    bindVideo(old);
    document.body.innerHTML = '<video id="player_html5_api"></video>';
    const current = document.querySelector('video');
    scanVideo();
    assert.equal(current.muted, true);
    assert.equal(current.playbackRate, 2);
    state.manuallyPaused = true;
    old.dispatchEvent(new window.Event('play'));
    assert.equal(state.manuallyPaused, true);
    current.dispatchEvent(new window.Event('play'));
    assert.equal(state.manuallyPaused, false);
});
