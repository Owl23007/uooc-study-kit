import { readFileSync } from 'node:fs';
import { releaseChannel } from './release-policy.mjs';

export const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const repository = 'Owl23007/uooc-study-kit';
export function metadata() {
    const raw = `https://raw.githubusercontent.com/${repository}/${releaseChannel(pkg.version)}`;
    return `// ==UserScript==
// @name         UOOC Study Kit（UOOC 学习工具箱）
// @namespace    https://github.com/Owl23007
// @version      ${pkg.version}
// @description  UOOC 学习辅助工具箱：双版本导航、播放控制、BYOK 题目辅助与运行记录
// @author       Owl23007
// @homepageURL  https://github.com/${repository}
// @supportURL   https://github.com/${repository}/issues
// @updateURL    ${raw}/uooc-study-plugin.meta.js
// @downloadURL  ${raw}/uooc-study-plugin.user.js
// @match        https://www.uooc.net.cn/home/learn/*
// @match        https://www.uooc.net.cn/home/course/exam/*
// @match        https://www.uooc.net.cn/home/exam/*
// @match        https://www.uooc.net.cn/exam/*
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.openai.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @license      MIT
// ==/UserScript==`;
}
