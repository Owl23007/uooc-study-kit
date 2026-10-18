import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, validateConfig, redact } from '../src/core.js';
import { createNavigationCoordinator } from '../src/navigation.js';

test('API 地址校验和凭证脱敏', () => {
    const config = { baseUrl: 'https://example.com/v1/', apiKey: 'test-token', model: 'demo' };
    assert.equal(validateConfig(config).baseUrl, 'https://example.com/v1');
    assert.equal(validateConfig({ ...config, temperature: '' }).temperature, undefined);
    assert.equal(validateConfig({ ...config, temperature: '0' }).temperature, 0);
    assert.throws(() => validateConfig({ ...config, temperature: '3' }));
    for (const baseUrl of ['http://example.com', 'file:///tmp/key', 'https://user:pass@example.com', 'https://example.com?key=x', 'https://example.com/#key']) {
        assert.throws(() => validateConfig({ ...config, baseUrl }));
    }
    assert.equal(validateConfig({ ...config, baseUrl: 'http://localhost:1234/v1' }).baseUrl, 'http://localhost:1234/v1');
    assert.ok(!redact('test-token Bearer abc sk-example', 'test-token').includes('test-token'));
    assert.ok(!redact('Bearer abc').includes('abc'));
});

test('条件等待支持真实就绪、超时和取消', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 5);
    assert.equal(await waitFor(() => ready, { interval: 2 }), true);
    await assert.rejects(waitFor(() => false, { timeout: 5, interval: 2 }), /超时/);
    const controller = new AbortController();
    const pending = waitFor(() => false, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

function coordinator(adapter, timeout = 80) {
    const before = { isConnected: true, readyState: 4, ended: true };
    const current = { hash: '#old', video: before, src: 'old', mediaEpoch: 1 };
    const transitions = [];
    const logs = [];
    let restored = 0;
    const navigation = createNavigationCoordinator({
        resolveAdapter: () => adapter,
        snapshot: () => ({ ...current }),
        restore: () => { restored++; },
        onState: value => transitions.push(value),
        log: message => logs.push(message), timeout,
    });
    return { navigation, current, transitions, logs, get restored() { return restored; } };
}

test('导航拒绝重复切换，等待新媒体后恢复，最终释放锁', async () => {
    let finish;
    const context = coordinator({ navigate: async ({ onTarget }) => {
        onTarget(hash => hash === '#new');
        await new Promise(resolve => { finish = resolve; });
        context.current.hash = '#new';
        context.current.src = 'new';
        context.current.video = { isConnected: true, readyState: 3, ended: false };
        return true;
    } });
    const pending = context.navigation.next();
    assert.equal(await context.navigation.next(), false);
    finish();
    assert.equal(await pending, true);
    assert.equal(context.restored, 1);
    assert.deepEqual(context.transitions, [true, false]);
    assert.equal(context.navigation.busy, false);
});

test('目录错误、课程末尾和无法识别平台都会释放切换锁', async () => {
    for (const adapter of [null, { navigate: async () => false }, { navigate: async () => { throw new Error('目录异常'); } }]) {
        const context = coordinator(adapter);
        assert.equal(await context.navigation.next(), false);
        assert.equal(context.navigation.busy, false);
        assert.equal(context.restored, 0);
        assert.deepEqual(context.transitions, [true, false]);
    }
});

test('切换超时和手动跳转都会取消操作，之后仍可再次尝试', async () => {
    const adapter = { navigate: async ({ signal }) => waitFor(() => false, { signal }) };
    const context = coordinator(adapter, 8);
    await context.navigation.next();
    assert.equal(context.navigation.busy, false);
    const pending = context.navigation.next();
    context.navigation.routeChanged('#other');
    await pending;
    assert.equal(context.navigation.busy, false);
    assert.equal(context.restored, 0);
});

test('路由改变而旧播放器仍在时不能提前恢复', async () => {
    const context = coordinator({ navigate: async ({ onTarget }) => {
        onTarget(hash => hash === '#new');
        context.current.hash = '#new';
        return true;
    } }, 8);
    assert.equal(await context.navigation.next(), false);
    assert.equal(context.restored, 0);
});
