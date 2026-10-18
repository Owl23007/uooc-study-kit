import { waitFor } from '../core.js';

// 新版使用目录 li 的 Scope 定位，展开动作交给页面原生事件
export const MODERN_SELECTORS = Object.freeze({
    chapter: 'li[ng-repeat*="chapterItem in chapterList"]',
    section: 'li[ng-repeat*="sectionItem in chapterItem.children"]',
    sectionTrigger: '.level_2_title[ng-click]',
    resource: '.level_2_resourcelist_item[ng-click]',
});

export function parseCourseRoute(hash) {
    const parts = hash.replace(/^#\/?/, '').split('/');
    if (parts.length !== 5 || parts[4] !== 'section' || parts.slice(0, 4).some(x => !x)) return null;
    const [courseId, chapterId, sectionId, sourceId] = parts;
    return { courseId, chapterId, sectionId, sourceId };
}

export function flattenSections(chapters) {
    return chapters.flatMap(chapter => (chapter.children || []).map(section => ({ chapter, section })));
}

export function createModernAdapter({ document, page, location }) {
    const scopeOf = node => {
        try { return node && page.angular?.element(node).scope(); } catch { return null; }
    };
    const find = (selector, key, id) => [...document.querySelectorAll(selector)]
        .find(node => String(scopeOf(node)?.[key]?.id) === String(id));
    const findSection = id => find(MODERN_SELECTORS.section, 'sectionItem', id);
    const findChapter = id => find(MODERN_SELECTORS.chapter, 'chapterItem', id);
    return {
        id: 'modern',
        async navigate({ signal, onTarget }) {
            const route = parseCourseRoute(location.hash);
            if (!route) throw new Error('新版课程路由不匹配，停止导航');
            const wait = (probe, message, timeout = 6000) => waitFor(() => {
                // 原生展开可能更新小节路由，但不能跳到其他课程
                if (location.hash.replace(/^#\/?/, '').split('/')[0] !== route.courseId) {
                    throw new Error('目录定位期间已离开当前课程');
                }
                return probe();
            }, { signal, timeout, message });
            const chapters = await wait(() => {
                const list = scopeOf(findSection(route.sectionId))?.chapterList;
                return Array.isArray(list) && list.length && list;
            }, '无法从当前小节 Scope 读取 chapterList');
            const sections = flattenSections(chapters);
            const start = sections.findIndex(item => String(item.chapter.id) === route.chapterId && String(item.section.id) === route.sectionId);
            if (start < 0) throw new Error('当前小节不在新版目录中');

            async function openSection(chapter, section) {
                let node = findSection(section.id);
                const chapterNode = findChapter(chapter.id);
                const chapterData = scopeOf(chapterNode)?.chapterItem;
                if (!node || chapterData?.hide) {
                    if (!chapterNode) throw new Error(`找不到新版章节 ${chapter.id}`);
                    if (chapterData?.hide) {
                        const trigger = [...chapterNode.querySelectorAll('[ng-click]')].find(candidate =>
                            candidate.getAttribute('ng-click')?.includes('toggleChapter(chapterItem)'));
                        if (!trigger) throw new Error(`未找到章节 ${chapter.id} 的展开按钮`);
                        trigger.click();
                    }
                    node = await wait(() => findSection(section.id), `章节 ${chapter.id} 展开超时`);
                }
                const sectionData = scopeOf(node)?.sectionItem;
                if (!sectionData) throw new Error(`无法读取小节 ${section.id} 的 Scope`);
                if (sectionData.hide) {
                    const trigger = node.querySelector(MODERN_SELECTORS.sectionTrigger);
                    if (!trigger) throw new Error(`未找到小节 ${section.id} 的展开按钮`);
                    trigger.click();
                }
                return wait(() => {
                    // 展开和加载过程可能替换节点及 Scope，不能读取旧目录对象
                    const liveNode = findSection(section.id);
                    const data = scopeOf(liveNode)?.sectionItem;
                    return !data?.hide && Array.isArray(data?.unitSource) && { sources: data.unitSource };
                }, `小节 ${section.id} 资源加载超时`, 8000);
            }

            for (let index = start; index < sections.length; index++) {
                signal?.throwIfAborted();
                const { chapter, section } = sections[index];
                const { sources } = await openSection(chapter, section);
                let from = 0;
                if (index === start) {
                    const current = sources.findIndex(source => String(source.id) === route.sourceId);
                    if (current < 0) throw new Error('当前资源不在小节目录中，停止导航');
                    from = current + 1;
                }
                const next = sources.slice(from).find(source => Number(source.type) === 10);
                if (!next) continue;
                const resource = await wait(() => {
                    const node = findSection(section.id);
                    return node && [...node.querySelectorAll(MODERN_SELECTORS.resource)]
                        .find(candidate => String(scopeOf(candidate)?.source?.id) === String(next.id));
                }, `视频 ${next.id} 的资源节点未渲染`, 5000);
                onTarget(hash => {
                    const target = parseCourseRoute(hash);
                    return target?.courseId === route.courseId && target.chapterId === String(chapter.id) &&
                        target.sectionId === String(section.id) && target.sourceId === String(next.id);
                });
                resource.click();
                return true;
            }
            return false;
        },
    };
}
