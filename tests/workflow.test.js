import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { quizFixture } from './helpers.js';
import { state } from '../src/runtime.js';
import { extractQuestions, isKnownWrongAnswer } from '../src/quiz.js';
import { gmRequest, parseBatch } from '../src/llm.js';
import { callLLM, fillAnswers, cancelTask } from '../src/workflow.js';

const config = { baseUrl: 'https://example.com/v1', apiKey: 'private-test-token', model: 'demo' };
const endpoint = `${config.baseUrl}/chat/completions`;
const response = message => ({ status: 200, finalUrl: endpoint, responseText: JSON.stringify({ choices: [{ message: { content: message } }] }) });
const makeTask = questions => ({ id: 1, route: '/home/exam/test#quiz', mode: 'all', questions, activeRequests: new Set(), controller: new AbortController(), cancelled: false, filled: 0, finished: 0, failedKeys: new Set(), completedKeys: new Set() });

beforeEach(() => {
    globalThis.location = { pathname: '/home/exam/test', hash: '#quiz' };
    globalThis.GM_getValue = (key, fallback) => key === 'llm_config' ? config : fallback;
    state.panel = null;
    state.task = null;
    state.requests = [];
    state.logs = [];
    Object.assign(state.prefs, { concurrency: 2, batchSize: 1, retries: 0, timeout: 200 });
});

test('答案解析拒绝无效选项和单选多答案，保留解析依据', () => {
    const fixture = quizFixture();
    const { questions } = extractQuestions(fixture.document);
    assert.equal(parseBatch('{"answers":[{"id":1,"choices":["A","Z"]}]}', questions).size, 0);
    assert.equal(parseBatch('{"answers":[{"id":1,"choices":["A","B"]}]}', questions).size, 0);
    const answers = parseBatch('```json\n{"answers":[{"id":1,"choices":["B"],"explanation":"依据"}]}\n```', questions);
    assert.deepEqual(answers.get(1), ['B']);
    assert.equal(answers.explanations.get(1), '依据');
});

test('多选回填验证实际选中集合，禁用输入和题干变化时跳过', () => {
    const fixture = quizFixture(1, 'checkbox');
    globalThis.document = fixture.document;
    const { questions } = extractQuestions();
    fixture.questions[0].inputs[0].checked = true;
    assert.equal(fillAnswers(questions, new Map([[1, ['B', 'C']]])).filled, 1);
    assert.deepEqual(fixture.questions[0].inputs.map(x => x.checked), [false, true, true]);
    fixture.questions[0].inputs[0].disabled = true;
    assert.equal(fillAnswers(questions, new Map([[1, ['A']]])).filled, 0);
    fixture.questions[0].inputs[0].disabled = false;
    questions[0].fingerprint = '已变化';
    assert.equal(fillAnswers(questions, new Map([[1, ['A']]])).filled, 0);
});

test('网络请求使用无 Cookie 模式，拒绝重定向且错误记录不含服务端原文', async () => {
    let options;
    globalThis.GM_xmlhttpRequest = supplied => {
        options = supplied;
        queueMicrotask(() => supplied.onload({ status: 401, responseText: config.apiKey }));
        return { abort() {} };
    };
    await assert.rejects(gmRequest(endpoint, config, [], 100, new Map()), /HTTP 401/);
    assert.equal(options.anonymous, true);
    assert.equal(options.redirect, 'error');
    assert.ok(!JSON.stringify(state.requests).includes(config.apiKey));
    assert.ok(!JSON.stringify(state.logs).includes(config.apiKey));
});

test('请求超时和任务取消会中止网络句柄且只结算一次', async () => {
    let aborts = 0;
    globalThis.GM_xmlhttpRequest = options => ({ abort() { aborts++; options.onabort(); } });
    await assert.rejects(gmRequest(endpoint, config, [], 5, new Map()), /超时/);
    assert.equal(aborts, 1);
    const task = makeTask([]);
    state.task = task;
    const pending = gmRequest(endpoint, config, [], 100, new Map(), new Map(), { task });
    cancelTask();
    await assert.rejects(pending, /取消/);
    assert.equal(task.activeRequests.size, 0);
    assert.equal(state.requests.at(-1).status, 'cancelled');
    assert.equal(aborts, 2);
});

test('并发答题不超过配置上限，逐批回填且不点击提交', async () => {
    const fixture = quizFixture(5);
    globalThis.document = fixture.document;
    const { questions } = extractQuestions();
    let running = 0;
    let peak = 0;
    let calls = 0;
    globalThis.GM_xmlhttpRequest = options => {
        running++; calls++; peak = Math.max(peak, running);
        const id = Number(JSON.parse(options.data).messages[1].content.match(/题目 (\d+)（/)[1]);
        const timer = setTimeout(() => {
            running--;
            options.onload(response(JSON.stringify({ answers: [{ id, choices: ['B'] }] })));
        }, 5);
        return { abort() { clearTimeout(timer); options.onabort(); } };
    };
    const task = makeTask(questions);
    state.task = task;
    await callLLM(questions, new Map(), task);
    assert.equal(calls, 5);
    assert.equal(peak, 2);
    assert.equal(task.filled, 5);
    assert.ok(fixture.questions.every(question => question.inputs[1].checked));
    assert.equal(task.activeRequests.size, 0);
});

test('请求返回前切换试卷时取消任务并拒绝回填', async () => {
    const fixture = quizFixture();
    globalThis.document = fixture.document;
    const { questions } = extractQuestions();
    globalThis.GM_xmlhttpRequest = options => {
        queueMicrotask(() => {
            location.hash = '#other';
            options.onload(response('{"answers":[{"id":1,"choices":["A"]}]}'));
        });
        return { abort() {} };
    };
    const task = makeTask(questions);
    state.task = task;
    await callLLM(questions, new Map(), task);
    assert.equal(task.cancelled, true);
    assert.ok(fixture.questions[0].inputs.every(input => !input.checked));
});

test('已知失分答案不会被再次静默回填', () => {
    const fixture = quizFixture();
    globalThis.document = fixture.document;
    const { questions } = extractQuestions();
    const record = { score: { actual: 0, full: 10 }, selected: [{ label: 'A', text: questions[0].options[0].text }] };
    assert.equal(isKnownWrongAnswer(questions[0], ['A'], record), true);
    const result = fillAnswers(questions, new Map([[1, ['A']]]), 'wrong', new Map([[1, record]]));
    assert.equal(result.filled, 0);
});
