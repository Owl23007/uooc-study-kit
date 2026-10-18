import { start } from './lifecycle.js';

// 挂载标记位于油猴隔离环境，防止同一脚本重复初始化
if (window === window.top && !globalThis.__uoocStudyPluginStarted) {
    globalThis.__uoocStudyPluginStarted = true;
    start();
}
