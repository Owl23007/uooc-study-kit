export function abortError() {
    return new DOMException('操作已取消', 'AbortError');
}

// 轮询只检查真实条件，超时和取消都会释放监听器
export function waitFor(probe, { signal, timeout = 12000, interval = 100, message = '等待超时' } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        const deadline = Date.now() + timeout;
        const finish = (error, value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve(value);
        };
        const cancel = () => finish(abortError());
        const check = () => {
            if (signal?.aborted) return cancel();
            try {
                const value = probe();
                if (value) return finish(null, value);
                if (Date.now() >= deadline) return finish(new Error(message));
                timer = setTimeout(check, interval);
            } catch (error) { finish(error); }
        };
        signal?.addEventListener('abort', cancel, { once: true });
        check();
    });
}

export function validateConfig(config) {
    let url;
    try { url = new URL(config?.baseUrl); } catch { throw new Error('API Base URL 无效'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw new Error('仅支持 HTTPS 或本地 HTTP');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('API 地址不能包含凭证、查询参数或片段');
    }
    if (!config.apiKey?.trim() || !config.model?.trim()) throw new Error('请填写 API Key 和模型');
    const temperature = config.temperature === '' || config.temperature == null ? undefined : Number(config.temperature);
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        throw new Error('温度应为 0 到 2，或留空');
    }
    return { baseUrl: url.href.replace(/\/+$/, ''), apiKey: config.apiKey.trim(), model: config.model.trim(), temperature };
}

export function redact(value, secret = '') {
    let result = String(value ?? '');
    if (secret) result = result.split(secret).join('[已隐藏]');
    return result.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
        .replace(/sk-[\w-]+/g, '[已隐藏]');
}
