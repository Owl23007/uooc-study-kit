import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createLegacyAdapter } from '../src/platform/legacy.js';

let browser;
let document;
let clicked;
let events;
beforeEach(() => {
    browser = new Window({ url: 'https://www.uooc.net.cn/home/learn/index#/c/ch/s/v/section' });
    document = browser.document;
    clicked = [];
    events = [];
});
afterEach(async () => { await browser.happyDOM.close(); });

// 保留实测旧版的目录属性、资源容器和纯文本提示，简化课程名称与 ID
const point = id => `<li id="${id}" ng-repeat="pointItem in sectionItem.children"><div class="basic" ui-sref="main.chapter.section.point({ pointId: pointItem.id })" ng-click="toggleChapter(pointItem)"><div class="oneline">${id}</div><i class="iconfont icon-xiangshang"></i></div></li>`;
const section = (id, contents = '') => `<li id="${id}" ng-repeat="sectionItem in chapterItem.children"><div class="basic" ui-sref="main.chapter.section({ sectionId: sectionItem.id })" ng-click="toggleChapter(sectionItem)"><div class="oneline">${id}</div><i></i></div>${contents}</li>`;
const chapter = (id, contents = '') => `<li id="${id}" ng-repeat="chapterItem in chapterList"><div class="basic" ui-sref="main.chapter({ chapterId: chapterItem.id })" ng-click="toggleChapter(chapterItem)"><div class="oneline">${id}</div><i></i></div>${contents}</li>`;
const resources = (id, type = 'section', active = false, video = true) => `<div class="resourcelist" ng-if="showSourceList(${type}Item.unitSource)"><div id="${id}" class="basic${active ? ' active' : ''}" ng-repeat="source in ${type}Item.unitSource" ng-click="goSource(source, '${type}')"><span class="${video ? 'icon-video' : 'icon-huixingzhen'}"></span><span class="tag-source-name">${video ? '视频' : '附件'}</span></div></div>`;
const emptyInfo = '<div class="unfoldInfo" style="text-align:center">点击下方继续学习</div>';

function bindResource(id) {
    document.getElementById(id).onclick = () => clicked.push(id);
}
function expand(id, html, after = () => {}) {
    const item = document.getElementById(id);
    item.firstElementChild.onclick = () => {
        events.push(id);
        item.insertAdjacentHTML('beforeend', html);
        after();
    };
}
async function navigate(canIgnoreTest = false, signal = new AbortController().signal) {
    const adapter = createLegacyAdapter({ document, canIgnoreTest: () => canIgnoreTest });
    let accepts;
    const moved = await adapter.navigate({ signal, onTarget: predicate => { accepts = predicate; } });
    return { moved, accepts };
}

test('旧版当前是 section 资源时先查同级视频，不点击附件', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s', resources('v1', 'section', true))}</ul>`);
    const list = document.querySelector('.resourcelist');
    list.insertAdjacentHTML('beforeend', '<div id="file" class="basic"><span class="icon-huixingzhen"></span></div><div id="v2" class="basic" ng-click="goSource(source, \'section\')"><span class="icon-video"></span></div>');
    bindResource('file');
    bindResource('v2');
    const result = await navigate();
    assert.equal(result.moved, true);
    assert.deepEqual(clicked, ['v2']);
    assert.equal(result.accepts(browser.location.hash), true);
});

test('section 资源结束后进入 point 子目录，跳过纯文本提示并选择下一个 point 视频', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s', resources('v1', 'section', true) + `<ul>${point('p1')}${point('p2')}</ul>`)}</ul>`);
    expand('p1', emptyInfo);
    expand('p2', resources('v2', 'point'), () => bindResource('v2'));
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(events, ['p1', 'p2']);
    assert.deepEqual(clicked, ['v2']);
});

test('当前 basic active 是已展开的 point 标题时，不重复点击标题把它折叠', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s', `<ul>${point('p1')}${point('p2')}</ul>`)}</ul>`);
    const first = document.getElementById('p1');
    first.firstElementChild.classList.add('active');
    first.insertAdjacentHTML('beforeend', emptyInfo);
    first.firstElementChild.onclick = () => { throw new Error('不能重复折叠当前 point'); };
    expand('p2', resources('v2', 'point'), () => bindResource('v2'));
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(events, ['p2']);
    assert.deepEqual(clicked, ['v2']);
});

test('最后一个空 point 会退出子目录并进入下一个 section', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s1', resources('v1', 'section', true) + `<ul>${point('p1')}</ul>`)}${section('s2')}</ul>`);
    expand('p1', emptyInfo);
    expand('s2', resources('v2'), () => bindResource('v2'));
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(events, ['p1', 's2']);
    assert.deepEqual(clicked, ['v2']);
});

test('跨章节依次展开 chapter 与 section 后点击资源，不点击 oneline 代替目录标题', async () => {
    document.body.innerHTML = `<ul>${chapter('ch1', `<ul>${section('s1', resources('v1', 'section', true))}</ul>`)}${chapter('ch2')}</ul>`;
    expand('ch2', `<ul>${section('s2')}</ul>`, () => {
        expand('s2', resources('v2'), () => bindResource('v2'));
    });
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(events, ['ch2', 's2']);
    assert.deepEqual(clicked, ['v2']);
});

test('unfoldInfo 后存在资源列表时继续读取资源，不把说明区当成视频容器', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s1', resources('v1', 'section', true))}${section('s2')}</ul>`);
    expand('s2', '<div class="unfoldInfo">课程说明</div>' + resources('v2'), () => bindResource('v2'));
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(clicked, ['v2']);
});

test('非视频资源节点按原课程模式决定停止或继续查找', async () => {
    for (const canIgnoreTest of [false, true]) {
        clicked = [];
        document.body.innerHTML = chapter('ch', `<ul>${section('s1', resources('v1', 'section', true))}${section('s2')}${section('s3')}</ul>`);
        expand('s2', resources('file', 'section', false, false));
        expand('s3', resources('v3'), () => bindResource('v3'));
        assert.equal((await navigate(canIgnoreTest)).moved, canIgnoreTest);
        assert.deepEqual(clicked, canIgnoreTest ? ['v3'] : []);
    }
});

test('旧版目录全部遍历结束后返回结束，不把标题展开视为成功切换', async () => {
    document.body.innerHTML = `<ul>${chapter('ch', `<ul>${section('s', resources('v1', 'section', true) + `<ul>${point('p')}</ul>`)}</ul>`)}</ul>`;
    expand('p', emptyInfo);
    assert.equal((await navigate()).moved, false);
    assert.deepEqual(clicked, []);
});

test('已选中的目录如果箭头表明仍折叠，应点击标题展开资源', async () => {
    document.body.innerHTML = chapter('ch', `<ul>${section('s', `<ul>${point('p')}</ul>`)}</ul>`);
    const title = document.getElementById('p').firstElementChild;
    title.classList.add('active');
    title.querySelector('i').classList.add('icon-xiangxia');
    expand('p', resources('v2', 'point'), () => bindResource('v2'));
    assert.equal((await navigate()).moved, true);
    assert.deepEqual(events, ['p']);
    assert.deepEqual(clicked, ['v2']);
});
