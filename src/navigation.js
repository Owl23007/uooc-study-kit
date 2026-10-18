import { waitFor } from './core.js';

export function createNavigationCoordinator({ resolveAdapter, snapshot, restore, log, onState, timeout = 30000 }) {
    let active = null;
    return {
        get busy() { return !!active; },
        cancel() { active?.controller.abort(); },
        routeChanged(hash) {
            if (!active) return;
            const now = snapshot();
            const courseOf = value => value.replace(/^#\/?/, '').split('/')[0];
            const leftCourse = courseOf(hash) !== courseOf(active.before.hash);
            const leftPage = now.pathname !== active.before.pathname;
            // 目录展开可产生同课程内的中间路由，选定资源后才严格匹配目标
            if (leftCourse || leftPage || (active.acceptHash && !active.acceptHash(hash))) active.controller.abort();
        },
        async next() {
            if (active) return false;
            const operation = { controller: new AbortController(), acceptHash: null, before: snapshot(), released: false };
            active = operation;
            onState(true);
            const timer = setTimeout(() => operation.controller.abort(), timeout);
            const signal = operation.controller.signal;
            try {
                const adapter = resolveAdapter();
                if (!adapter) throw new Error('平台版本或目录特征不匹配，停止导航');
                const before = operation.before;
                const moved = await adapter.navigate({ signal, onTarget: predicate => { operation.acceptHash = predicate; } });
                if (!moved) { log('已到课程末尾，没有后续视频'); return false; }
                if (!operation.acceptHash) throw new Error('目录适配器未登记目标资源');
                await waitFor(() => operation.acceptHash(snapshot().hash), { signal, message: '视频路由切换超时' });
                // 先启动新媒体再等待缓冲，避免 preload=none 的播放器互相等待
                await waitFor(() => {
                    const now = snapshot();
                    const changed = now.video !== before.video || now.src !== before.src || now.mediaEpoch > before.mediaEpoch || now.source !== before.source;
                    return operation.acceptHash(now.hash) && changed && now.video?.isConnected && (now.video.readyState >= 1 || now.src || now.source) && !now.video.ended && !now.video.error;
                }, { signal, message: '新播放器就绪超时' });
                // 先释放切换态，恢复逻辑才会接受自动播放
                onState(false);
                operation.released = true;
                const restored = await restore(signal);
                signal.throwIfAborted();
                if (restored === false) { log('已切换视频，但未能开始播放，请点击播放或查看运行记录'); return false; }
                return true;
            } catch (error) {
                log(error.name === 'AbortError' ? '视频切换已取消或超时' : `视频切换失败：${error.message}`);
                return false;
            } finally {
                clearTimeout(timer);
                if (active === operation) { active = null; if (!operation.released) onState(false); }
            }
        },
    };
}
