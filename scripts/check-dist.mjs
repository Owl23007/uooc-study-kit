import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';
import { Window } from 'happy-dom';
import { metadata } from './metadata.mjs';

const code = readFileSync('dist/uooc-study-plugin.user.js', 'utf8');
const meta = readFileSync('dist/uooc-study-plugin.meta.js', 'utf8');
assert.ok(code.startsWith(`${metadata()}\n`), '用户脚本头必须位于文件首行');
assert.equal(meta.trim(), metadata());
assert.deepEqual(readdirSync('dist').sort(), ['uooc-study-plugin.meta.js', 'uooc-study-plugin.user.js']);
assert.ok(!/^\s*(?:import |export )/m.test(code), '产物必须独立执行');
assert.ok(!/\beval\s*\(|new Function\s*\(|@require\s/.test(code), '不允许混淆或远程代码');
assert.ok(code.includes('function createNavigationCoordinator'), '保留可读函数名');
assert.ok(code.split('\n').length > 1000, '产物必须保留格式');
new Script(code);
console.log('产物检查通过：单文件、元数据一致、语法有效、可读代码');

// 使用最终产物挂载面板，补充模块测试无法覆盖的打包运行检查
const browser = new Window({ url: 'https://www.uooc.net.cn/home/exam/demo' });
browser.GM_getValue = (_key, fallback) => fallback;
browser.GM_setValue = () => {};
browser.GM_xmlhttpRequest = () => { throw new Error('初始化不应发送 AI 请求'); };
try {
    browser.eval(code);
    browser.document.dispatchEvent(new browser.Event('DOMContentLoaded'));
    assert.equal(browser.document.querySelectorAll('#uooc-assistant-host').length, 1);
    browser.eval(code);
    assert.equal(browser.document.querySelectorAll('#uooc-assistant-host').length, 1);
    console.log('产物运行检查通过：面板挂载成功、重复执行不重复初始化');
} finally { await browser.happyDOM.close(); }
