import { waitFor } from '../core.js';

// 保留原版多层 li/ul 目录遍历顺序，展开后等待真实内容
export function createLegacyAdapter({ document, canIgnoreTest, log = () => {} }) {
    return {
        id: 'legacy',
        async navigate({ signal, onTarget }) {
            const current = document.querySelector('.basic.active');
            if (!current) throw new Error('旧版当前课程节点不存在');
            let part = current.parentNode;
            const hasVideo = node => !!node?.querySelector?.('span.icon-video');
            const nextVideo = node => {
                let next = node?.nextElementSibling;
                while (next && !hasVideo(next)) next = next.nextElementSibling;
                return next;
            };
            const firstVideo = parent => {
                let node = parent?.firstElementChild;
                while (node && !hasVideo(node)) node = node.nextElementSibling;
                return node;
            };
            const click = node => {
                if (!node?.isConnected) throw new Error('旧版资源节点已被替换，请重试');
                // 旧版由 goSource 原生点击切换资源，不强制套用新版的资源路由条件
                onTarget(() => true);
                log('旧版导航：点击视频资源', node.textContent?.trim().slice(0, 80) || '视频');
                node.click();
                return true;
            };
            async function search(mode, depth = 0) {
                signal.throwIfAborted();
                if (depth > 30) throw new Error('旧版目录遍历超过安全深度');
                if (!part) return false;
                if (!part.isConnected) throw new Error('旧版目录已重建，请重试');
                switch (mode) {
                    case 'next-video': {
                        const node = nextVideo(current);
                        if (node) return click(node);
                        return search(part.nextElementSibling?.childElementCount ? 'last-list' : 'outer-item', depth + 1);
                    }
                    case 'first-video': {
                        const node = firstVideo(part);
                        if (node) return click(node);
                        if (part.nextElementSibling?.childElementCount) return search('last-list', depth + 1);
                        if (canIgnoreTest() && part.lastElementChild) {
                            part = part.lastElementChild;
                            return search('outer-list', depth + 1);
                        }
                        return false;
                    }
                    case 'last-list':
                        part = part.nextElementSibling?.firstElementChild;
                        return search('inner-list', depth + 1);
                    case 'next-list':
                        part = part.nextElementSibling;
                        return search('inner-list', depth + 1);
                    case 'inner-list': {
                        // 当前选中的 basic 可能是 point 标题，目录容器必须回到对应 li
                        if (part.matches?.('.basic[ui-sref]')) part = part.parentElement;
                        const title = part?.firstElementChild;
                        if (!title) return false;
                        const container = part;
                        const hasContent = !!title.nextElementSibling;
                        if (!hasContent && (!title.classList.contains('active') || title.querySelector('.icon-xiangxia'))) {
                            log('旧版导航：展开目录', title.textContent?.trim().slice(0, 80));
                            title.click();
                        }
                        const content = await waitFor(() => {
                            const live = container.isConnected ? container : container.id && document.getElementById(container.id);
                            if (!live) {
                                if (!container.id) throw new Error('旧版目录已重建且没有稳定 ID，停止导航');
                                return false;
                            }
                            part = live;
                            const candidate = live.firstElementChild?.nextElementSibling;
                            if (!candidate) return false;
                            const resources = candidate.classList.contains('unfoldInfo') ? candidate.nextElementSibling : candidate;
                            // resourcelist 出现时资源已经可用，仅等待其内部原生节点完成渲染
                            if (resources?.classList.contains('resourcelist') && !resources.childElementCount) return false;
                            return candidate;
                        }, { signal, message: '旧版目录展开或资源渲染超时' });
                        const body = content.classList.contains('unfoldInfo') ? content.nextElementSibling : content;
                        if (!body?.childElementCount) {
                            // 纯文本 unfoldInfo 是无资源提示，不是异步加载占位
                            log('旧版导航：跳过无资源目录', title.textContent?.trim().slice(0, 80));
                            return search(part.nextElementSibling ? 'next-list' : 'outer-list', depth + 1);
                        }
                        part = body;
                        if (part?.tagName === 'UL') {
                            part = part.firstElementChild;
                            return search('inner-list', depth + 1);
                        }
                        return search('first-video', depth + 1);
                    }
                    case 'outer-list':
                        part = part.parentNode?.parentNode;
                        if (!part) return false;
                        if (part.nextElementSibling) return search('next-list', depth + 1);
                        if (part.parentNode?.parentNode?.tagName === 'LI') return search('outer-list', depth + 1);
                        return false;
                    case 'outer-item':
                        part = part.parentNode;
                        if (!part) return false;
                        if (part.nextElementSibling) return search('next-list', depth + 1);
                        if (part.parentNode?.parentNode?.tagName === 'LI') return search('outer-list', depth + 1);
                        return false;
                    default: return false;
                }
            }
            // 原站标题和资源都使用 basic active，只有资源才从下一个兄弟节点查找
            return search(current.hasAttribute?.('ui-sref') ? 'inner-list' : 'next-video');
        },
    };
}
