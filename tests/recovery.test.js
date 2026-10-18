import test from 'node:test';
import assert from 'node:assert/strict';
import { quizFixture } from './helpers.js';
import { state } from '../src/runtime.js';
import { extractQuestions } from '../src/quiz.js';
import { callLLM, runQuiz } from '../src/workflow.js';

const config = { baseUrl: 'https://example.com/v1', apiKey: 'test-private-key', model: 'demo' };
function setup() {
    const fixture = quizFixture();
    globalThis.document = fixture.document;
    globalThis.location = { pathname: '/home/exam/test', hash: '#quiz' };
    globalThis.GM_getValue = (key, fallback) => key === 'llm_config' ? config : fallback;
    state.panel = null;
    state.task = null;
    state.requests = [];
    Object.assign(state.prefs, { concurrency: 1, batchSize: 1, retries: 1, timeout: 200 });
    const questions = extractQuestions().questions;
    const task = { id: 1, route: '/home/exam/test#quiz', mode: 'wrong', questions, activeRequests: new Set(), controller: new AbortController(), cancelled: false, filled: 0, finished: 0, failedKeys: new Set(), completedKeys: new Set() };
    state.task = task;
    return { fixture, questions, task };
}
function success(options, choices) {
    options.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: [{ id: 1, choices }] }) } }] }) });
}

test('429 后有限重试，同一任务最终只回填一次', async () => {
    const { fixture, questions, task } = setup();
    let calls = 0;
    globalThis.GM_xmlhttpRequest = options => {
        calls++;
        queueMicrotask(() => calls === 1 ? options.onload({ status: 429 }) : success(options, ['B']));
        return { abort() {} };
    };
    await callLLM(questions, new Map(), task);
    assert.equal(calls, 2);
    assert.equal(task.filled, 1);
    assert.equal(fixture.questions[0].inputs[1].checked, true);
    assert.deepEqual(state.requests.map(request => request.status), ['error', 'success']);
    assert.equal(state.requests[1].attempt, 2);
});

test('模型重复失分组合时追加修正请求，修正成功后才回填', async () => {
    const { fixture, questions, task } = setup();
    let calls = 0;
    const feedback = new Map([[1, { score: { actual: 0, full: 10 }, selected: [{ label: 'A', text: questions[0].options[0].text }] }]]);
    globalThis.GM_xmlhttpRequest = options => {
        calls++;
        assert.ok(fixture.questions[0].inputs.every(input => !input.checked));
        queueMicrotask(() => success(options, calls === 1 ? ['A'] : ['C']));
        return { abort() {} };
    };
    await callLLM(questions, feedback, task);
    assert.equal(calls, 2);
    assert.equal(fixture.questions[0].inputs[2].checked, true);
    assert.equal(state.requests[1].correction, true);
});

test('配置失败也会计入未完成题目并释放任务状态', async () => {
    setup();
    state.task = null;
    globalThis.GM_getValue = (_key, fallback) => fallback;
    await runQuiz();
    assert.equal(state.task, null);
    assert.equal(state.busy, false);
    assert.equal(state.lastResult.filled, 0);
    assert.equal(state.lastResult.failedKeys.length, 1);
});
