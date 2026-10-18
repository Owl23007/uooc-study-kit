import test, { afterEach } from 'node:test';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { createModernAdapter, MODERN_SELECTORS, flattenSections, parseCourseRoute } from '../src/platform/modern.js';
import { createLegacyAdapter } from '../src/platform/legacy.js';
import { resolvePlatform } from '../src/platform/index.js';

const windows = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

function modernFixture(chapters, hash) {
    const window = new Window({ url: `https://www.uooc.net.cn/home/learn/new/index${hash}` });
    windows.push(window);
    const document = window.document;
    const location = window.location;
    const states = new Map();
    const current = parseCourseRoute(hash);
    let clicked = null;
    let generation = 0;
    let chapterClicks = 0;
    let sectionClicks = 0;
    for (const chapter of chapters) {
        chapter.hide ??= String(chapter.id) !== current.chapterId;
        for (const section of chapter.children || []) {
            states.set(String(section.id), { ...section, hide: section.hide ?? String(section.id) !== current.sectionId });
        }
    }
    const render = () => {
        document.body.replaceChildren();
        for (const chapter of chapters) {
            const chapterNode = document.createElement('li');
            chapterNode.setAttribute('ng-repeat', 'chapterItem in chapterList');
            chapterNode.scope = { chapterItem: chapter };
            const toggle = document.createElement('button');
            toggle.setAttribute('ng-click', 'toggleChapter(chapterItem)');
            toggle.onclick = () => { chapterClicks++; generation++; chapter.hide = !chapter.hide; render(); };
            chapterNode.append(toggle);
            document.body.append(chapterNode);
            if (chapter.hide) continue;
            for (const section of chapter.children || []) {
                const data = states.get(String(section.id));
                const sectionNode = document.createElement('li');
                sectionNode.setAttribute('ng-repeat', 'sectionItem in chapterItem.children');
                sectionNode.scope = { chapterList: chapters, chapterItem: chapter, sectionItem: data };
                const title = document.createElement('button');
                title.className = 'level_2_title';
                title.setAttribute('ng-click', 'toggleSection(sectionItem)');
                title.onclick = () => {
                    sectionClicks++; generation++;
                    states.set(String(section.id), { ...data, hide: !data.hide });
                    if (section.pending) {
                        window.setTimeout(() => {
                            states.set(String(section.id), { ...states.get(String(section.id)), unitSource: section.pending });
                            render();
                        }, 5);
                    }
                    render();
                };
                sectionNode.append(title);
                chapterNode.append(sectionNode);
                if (data.hide || data.renderResources === false) continue;
                for (const source of data.unitSource || []) {
                    const resource = document.createElement('button');
                    resource.className = 'level_2_resourcelist_item';
                    resource.setAttribute('ng-click', 'selectSource(source)');
                    // 资源节点仅需 source，所属小节由目录容器保证
                    resource.scope = { source };
                    resource.onclick = () => { clicked = source.id; location.hash = `#/c/${chapter.id}/${section.id}/${source.id}/section`; };
                    sectionNode.append(resource);
                }
            }
        }
    };
    render();
    const page = { angular: { element: node => ({ scope: () => node?.scope }) } };
    const adapter = createModernAdapter({ document, page, location });
    return {
        adapter, document, page, location, states, render,
        get clicked() { return clicked; }, get generation() { return generation; },
        get chapterClicks() { return chapterClicks; }, get sectionClicks() { return sectionClicks; },
    };
}

test('新版严格解析路由，保持章节和资源原始顺序', () => {
    assert.equal(parseCourseRoute('#/c/ch/s/v/section').sourceId, 'v');
    assert.equal(parseCourseRoute('#/c/ch/s/v/exam'), null);
    const chapters = [{ id: 'a', children: [{ id: '2' }, { id: '1' }] }, { id: 'b', children: [{ id: '3' }] }];
    assert.deepEqual(flattenSections(chapters).map(x => x.section.id), ['2', '1', '3']);
});

test('新版跨小节、跨章节定位，跳过非视频并等待异步资源', async () => {
    const chapters = [
        { id: 'ch1', children: [{ id: 's1', unitSource: [{ id: 'v1', type: 10 }] }, { id: 's2', unitSource: [{ id: 'doc', type: 20 }] }] },
        { id: 'ch2', children: [{ id: 's3', pending: [{ id: 'doc2', type: 20 }, { id: 'v2', type: 10 }] }] },
    ];
    const fixture = modernFixture(chapters, '#/c/ch1/s1/v1/section');
    let accepts;
    const moved = await fixture.adapter.navigate({ signal: new AbortController().signal, onTarget: predicate => { accepts = predicate; } });
    assert.equal(moved, true);
    assert.equal(fixture.clicked, 'v2');
    assert.ok(fixture.generation >= 2);
    assert.equal(accepts(fixture.location.hash), true);
});

test('新版支持同小节下一个视频及课程末尾', async () => {
    const chapters = [{ id: 'ch', children: [{ id: 's', unitSource: [{ id: 'v1', type: 10 }, { id: 'doc', type: 30 }, { id: 'v2', type: '10' }] }] }];
    const fixture = modernFixture(chapters, '#/c/ch/s/v1/section');
    const args = { signal: new AbortController().signal, onTarget: () => {} };
    assert.equal(await fixture.adapter.navigate(args), true);
    assert.equal(fixture.clicked, 'v2');
    assert.equal(await fixture.adapter.navigate(args), false);
});

test('新版当前资源丢失时停止，不猜测下一个位置', async () => {
    const fixture = modernFixture([{ id: 'ch', children: [{ id: 's', unitSource: [{ id: 'v', type: 10 }] }] }], '#/c/ch/s/missing/section');
    await assert.rejects(fixture.adapter.navigate({ signal: new AbortController().signal, onTarget: () => {} }), /当前资源/);
    assert.equal(fixture.clicked, null);
});

test('版本识别失败时不混用选择器', () => {
    const document = { querySelector: () => ({}) };
    assert.equal(resolvePlatform({ document, location: { pathname: '/home/learn/new/index' }, page: {}, canIgnoreTest: () => false }), null);
    assert.equal(resolvePlatform({ document, location: { pathname: '/unknown' }, page: {}, canIgnoreTest: () => false }), null);
    assert.equal(resolvePlatform({ document, location: { pathname: '/home/learn/index' }, page: {}, canIgnoreTest: () => false }).id, 'legacy');
});

test('旧版在原目录中跳过非视频资源并点击下一个视频', async () => {
    let clicked = false;
    const target = { isConnected: true, querySelector: selector => selector === 'span.icon-video' ? {} : null, click: () => { clicked = true; } };
    const documentNode = { querySelector: () => null, nextElementSibling: target };
    const current = { parentNode: { isConnected: true }, nextElementSibling: documentNode };
    const adapter = createLegacyAdapter({ document: { querySelector: () => current }, location: { hash: '#old' }, canIgnoreTest: () => false });
    assert.equal(await adapter.navigate({ signal: new AbortController().signal, onTarget: () => {} }), true);
    assert.equal(clicked, true);
});

test('新版跳过已加载的空小节，不重复折叠已展开的小节', async () => {
    const chapters = [{ id: 'ch', children: [
        { id: 's1', unitSource: [{ id: 'v1', type: 10 }] },
        { id: 'empty', unitSource: [] },
        { id: 's2', unitSource: [{ id: 'v2', type: 10 }] },
    ] }];
    const fixture = modernFixture(chapters, '#/c/ch/s1/v1/section');
    assert.equal(await fixture.adapter.navigate({ signal: new AbortController().signal, onTarget() {} }), true);
    assert.equal(fixture.clicked, 'v2');
    assert.equal(fixture.sectionClicks, 2);
    assert.equal(fixture.chapterClicks, 0);
});

test('新版只点击目标小节内的资源，不要求资源 Scope 再包含 sectionItem', async () => {
    const fixture = modernFixture([{ id: 'ch', children: [{ id: 's', unitSource: [{ id: 'v1', type: 10 }, { id: 'v2', type: 10 }] }] }], '#/c/ch/s/v1/section');
    const unrelated = fixture.document.createElement('button');
    unrelated.className = 'level_2_resourcelist_item';
    unrelated.setAttribute('ng-click', 'selectSource(source)');
    unrelated.scope = { source: { id: 'v2' } };
    let wrongClicks = 0;
    unrelated.onclick = () => { wrongClicks++; };
    fixture.document.body.prepend(unrelated);
    let accepts;
    await fixture.adapter.navigate({ signal: new AbortController().signal, onTarget: predicate => { accepts = predicate; } });
    assert.equal(fixture.clicked, 'v2');
    assert.equal(wrongClicks, 0);
    assert.equal(accepts('#/c/other/s/v2/section'), false);
    assert.equal(accepts('#/c/ch/s/v20/section'), false);
    assert.equal(accepts('#c/ch/s/v2/section'), true);
});

test('新版在 Scope 已加载但资源 DOM 尚未渲染时等待新节点', async () => {
    const fixture = modernFixture([{ id: 'ch', children: [{ id: 's', renderResources: false, unitSource: [{ id: 'v1', type: 10 }, { id: 'v2', type: 10 }] }] }], '#/c/ch/s/v1/section');
    const timer = setTimeout(() => {
        fixture.states.set('s', { ...fixture.states.get('s'), renderResources: true });
        fixture.render();
    }, 5);
    try {
        assert.equal(await fixture.adapter.navigate({ signal: new AbortController().signal, onTarget() {} }), true);
        assert.equal(fixture.clicked, 'v2');
        assert.equal(fixture.sectionClicks, 0);
    } finally { clearTimeout(timer); }
});

test('新版资源等待支持取消，不继续点击过期目录', async () => {
    const fixture = modernFixture([{ id: 'ch', children: [
        { id: 's1', unitSource: [{ id: 'v1', type: 10 }] }, { id: 's2' },
    ] }], '#/c/ch/s1/v1/section');
    const controller = new AbortController();
    const pending = fixture.adapter.navigate({ signal: controller.signal, onTarget() {} });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fixture.clicked, null);
});
