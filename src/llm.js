import { ui } from './runtime.js';
import { DEFAULTS, state, info, warn, error } from './runtime.js';
import { remapWrongChoices } from './quiz.js';
import { redact, validateConfig } from './core.js';

export function buildPrompt(batch, feedback = new Map(), rejected = new Map()) {
    const sections = [
        '请独立分析以下选择题，并仅返回 JSON。',
        '返回格式：{"answers":[{"id":1,"choices":["A"],"explanation":"简要依据"}]}',
        'id 必须使用题目提供的编号；choices 使用当前题目中的选项字母。',
        '多选题可返回多个字母；explanation 给出简要依据，不添加 Markdown。',
        '对于附带批改反馈的题，先逐项检查上次的选择，再得出修正答案。',
        '低于满分只代表上次的整组答案不完全正确，尤其多选题不能断定每个已选项都错误。',
        '勿照抄明确已判错的整组答案；如果证据不足，仍须审慎推理，而非机械反选。',
    ];
    for (const q of batch) {
        sections.push(`\n题目 ${q.id}（${q.isRadio ? '单选/判断' : '多选'}）\n${q.title}`);
        for (const opt of q.options) sections.push(`${opt.label}. ${opt.text}`);
        const record = feedback.get(q.id);
        if (record) {
            const selected = remapWrongChoices(q, record);
            const formatted = selected.length
                ? selected.map(o => `${o.label}（${o.text}）`).join('；')
                : (record.selected?.length ? '已选答案未匹配当前选项' : '未选择');
            sections.push(`【上次批改反馈】实际得分 ${record.score.actual}/${record.score.full}；` +
                `上次提交的答案：${formatted}。这组答案未得满分，请找出遗漏或错误的选项并重新判断。`);
        }
        const rejectedChoices = rejected.get(q.id);
        if (rejectedChoices?.length) {
            sections.push(`【需要再次修正】你刚返回了 ${rejectedChoices.join(',')}，` +
                '与已判定失分的上次答案完全一致。请重新逐项核对并给出修正后的组合。');
        }
    }
    return sections.join('\n');
}

export function parseBatch(text, batch) {
    const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('模型未返回合法 JSON 对象');
    const parsed = JSON.parse(cleaned.slice(a, b + 1));
    if (!Array.isArray(parsed.answers)) throw new Error('缺少 answers 数组');
    const map = new Map();
    map.explanations = new Map();
    for (const item of parsed.answers) {
        const q = batch.find(x => x.id === Number(item.id));
        if (!q || map.has(q.id)) continue;
        const allowed = new Set(q.options.map(o => o.label));
        const choices = (Array.isArray(item.choices) ? item.choices : [item.choices])
            .flatMap(s => String(s ?? '').toUpperCase().split(/[,，、\s]+/))
            .filter(Boolean);
        if (choices.some(x => !allowed.has(x))) { warn(`题目 ${q.id} 含无效选项，跳过`); continue; }
        const unique = [...new Set(choices)];
        if (unique.length && (!q.isRadio || unique.length === 1)) {
            map.set(q.id, unique);
            if (typeof item.explanation === 'string') map.explanations.set(q.id, item.explanation.slice(0, 500));
        }
    }
    return map;
}

export function recordRequest(task, context) {
    const record = {
        id: ++state.requestSeq,
        taskId: task?.id ?? null,
        method: 'POST', batch: context.batchNo,
        questionIds: context.batch.map(q => q.id).join(', '),
        attempt: context.attempt, correction: !!context.correction,
        status: 'running', httpStatus: null, tokens: null,
        started: performance.now(), duration: null, error: '',
    };
    state.requests.push(record);
    if (state.requests.length > 180) state.requests.splice(0,state.requests.length-180);
    ui.records();
    return record;
}
export function finishRequest(record, status, extra = {}) {
    if (record.status !== 'running') return;
    record.status = status;
    record.duration = Math.round(performance.now() - record.started);
    Object.assign(record,extra);
    const message = `#${record.id} 批次 ${record.batch} ${status} · ${record.duration}ms${record.httpStatus ? ` · HTTP ${record.httpStatus}` : ''}`;
    if (status === 'success') info(message);
    else warn(message,record.error);
    ui.records();
}
export function gmRequest(url, config, batch, timeout, feedback, rejected = new Map(), context = {}) {
    try { config = validateConfig(config); }
    catch (err) { return Promise.reject(err); }
    if (url !== `${config.baseUrl}/chat/completions`) return Promise.reject(new Error('API 请求地址不匹配'));
    const task = context.task;
    if (task?.cancelled) return Promise.reject(new Error('任务已停止'));
    const record = recordRequest(task,{ batchNo:context.batchNo || 1, batch, attempt:context.attempt || 1, correction:context.correction });
    return new Promise((resolve,reject) => {
        const payload = {
            model: config.model,
            messages: [
                { role:'system',content:'请输出准确、可解析的 JSON 答案，保持题目编号' },
                { role:'user',content:context.test ? '请简短回复 OK，用于连接测试' : buildPrompt(batch,feedback,rejected) },
            ],
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        };
        const limit = Number(timeout) > 0 ? Number(timeout) : DEFAULTS.timeout;
        let request;
        let timer;
        let settled = false;
        const finish = (status,value,details = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            task?.activeRequests.delete(cancelRequest);
            finishRequest(record,status,details);
            if (status === 'success') resolve(value);
            else reject(value instanceof Error ? value : new Error(String(value)));
        };
        const cancelRequest = () => {
            finish('cancelled',new Error('请求已取消'));
            try { request?.abort?.(); } catch (err) { warn('中止请求异常',err); }
        };
        task?.activeRequests.add(cancelRequest);
        timer = setTimeout(() => {
            finish('timeout',new Error(`请求超时 ${limit}ms`),{error:`超过 ${limit}ms`});
            try { request?.abort?.(); } catch (err) { warn('中止超时请求异常',err); }
        },limit);
        try {
            request = GM_xmlhttpRequest({
                method:'POST',url,timeout:limit,anonymous:true,redirect:'error',
                headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${config.apiKey}` },
                data:JSON.stringify(payload),
                onload: res => {
                    if (res.status < 200 || res.status >= 300) {
                        const err = new Error(`HTTP ${res.status}`);
                        finish('error',err,{httpStatus:res.status,error:`HTTP ${res.status}，请检查服务商、模型和凭证`});
                        return;
                    }
                    try {
                        if (res.finalUrl && new URL(res.finalUrl).href !== new URL(url).href) throw new Error('拒绝 API 重定向响应');
                        let data;
                        try { data = JSON.parse(res.responseText); } catch { throw new Error('服务端未返回合法 JSON'); }
                        const message = data?.choices?.[0]?.message?.content;
                        if (!message) throw new Error('模型返回内容为空');
                        const usage = data.usage || null;
                        const tokens = usage?.total_tokens ?? null;
                        finish('success',{message,usage},{httpStatus:res.status,tokens});
                    } catch (err) {
                        finish('error',err,{httpStatus:res.status,error:redact(err.message, config.apiKey)});
                    }
                },
                onerror: () => finish('error',new Error('网络请求失败，请检查网络或 Tampermonkey 域名权限'),{error:'网络连接异常'}),
                ontimeout: () => finish('timeout',new Error(`请求超时 ${limit}ms`),{error:'Tampermonkey 超时'}),
                onabort: () => finish('cancelled',new Error('请求已取消')),
            });
            if (task?.cancelled) cancelRequest();
        } catch (err) {
            finish('error',err,{error:redact(err.message, config.apiKey)});
        }
    });
}
