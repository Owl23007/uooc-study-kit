import { ui, state, log, info, warn, error } from './runtime.js';
import { getQuizContext, getWrongCache, selectionSnapshot, saveWrongCache, collectWrongFeedback, isKnownWrongAnswer } from './quiz.js';
import { parseBatch, gmRequest } from './llm.js';
import { Storage } from './storage.js';
import { validateConfig, waitFor } from './core.js';

export function cancelTask(reason = '手动停止') {
    const task = state.task;
    if (!task || task.cancelled) return;
    task.cancelled = true;
    task.controller.abort();
    warn(`任务 #${task.id} 已停止：${reason}`);
    for (const cancel of [...task.activeRequests]) cancel();
    task.activeRequests.clear();
    ui.refresh();
}

export async function callLLM(questions,feedback = new Map(),task) {
    let config = Storage.get('llm_config',null);
    if (!config?.baseUrl || !config?.apiKey || !config?.model) {
        ui.settings();
        throw new Error('请先配置 API URL、API Key 和模型');
    }
    config = validateConfig(config);
    const prefs = { ...state.prefs };
    const size = Math.max(1,Math.min(10,Number(prefs.batchSize) || 3));
    const batches = [];
    for (let i=0;i<questions.length;i+=size) batches.push(questions.slice(i,i+size));
    const workers = Math.min(batches.length,Math.max(1,Math.min(8,Number(prefs.concurrency) || 4)));
    const endpoint = `${config.baseUrl.replace(/\/+$/,'')}/chat/completions`;
    info(`启动 ${workers} 并发 · ${questions.length} 题 · ${batches.length} 批`);
    let cursor = 0;
    async function worker(workerId) {
        while (!task.cancelled && cursor < batches.length) {
            const index = cursor++;
            const batch = batches[index];
            const batchNo = index+1;
            let output;
            info(`Worker ${workerId} · 批次 ${batchNo}/${batches.length} · ${batch.map(q=>q.id).join(',')}`);
            try {
                for (let retry=0;retry<=prefs.retries && !task.cancelled;retry++) {
                    try {
                        const response = await gmRequest(endpoint,config,batch,prefs.timeout,feedback,new Map(),{
                            task,batchNo,attempt:retry+1,
                        });
                        if (task.cancelled) break;
                        output = parseBatch(response.message,batch);

                        break;
                    } catch (err) {
                        if (task.cancelled) break;
                        warn(`批次 ${batchNo} 第 ${retry+1} 次失败`,err.message);
                        if (retry >= prefs.retries) throw err;
                        const retryAt = Date.now() + 600 * (retry + 1);
                        await waitFor(() => Date.now() >= retryAt, { signal: task.controller.signal, timeout: 3000 });
                    }
                }
                if (task.cancelled) break;
                if (!output) throw new Error('批次没有解析结果');
                const repeated = batch.filter(q => isKnownWrongAnswer(q,output.get(q.id),feedback.get(q.id)));
                if (repeated.length) {
                    const rejected = new Map(repeated.map(q=>[q.id,output.get(q.id)]));
                    warn(`批次 ${batchNo} 检测到重复失分答案，重新请求 ${repeated.map(q=>q.id).join(',')}`);
                    try {
                        const revised = await gmRequest(endpoint,config,repeated,prefs.timeout,feedback,rejected,{
                            task,batchNo,attempt:1,correction:true,
                        });
                        if (task.cancelled) break;
                        const corrected = parseBatch(revised.message,repeated);
                        for (const q of repeated) {
                            const next = corrected.get(q.id);
                            if (next && !isKnownWrongAnswer(q,next,feedback.get(q.id))) { output.set(q.id,next); if (corrected.explanations?.has(q.id)) output.explanations.set(q.id, corrected.explanations.get(q.id)); }
                            else { output.delete(q.id); warn(`题目 ${q.id} 仍是已知错误组合，跳过`); }
                        }
                    } catch (err) {
                        if (task.cancelled) break;
                        for (const q of repeated) output.delete(q.id);
                        warn(`批次 ${batchNo} 修正失败`,err.message);
                    }
                }
                if (task.cancelled) break;
                if (location.pathname+location.hash !== task.route) {
                    cancelTask('已切换试卷');
                    break;
                }
                let result;
                try { result = fillAnswers(batch,output,task.mode,feedback); }
                catch (err) {
                    warn(`批次 ${batchNo} 回填失败`,err);
                    result = { filled:0, skipped:batch.length, filledIds:[], skippedIds:batch.map(q=>q.id) };
                }
                task.filled += result.filled;
                for (const id of result.filledIds) {
                    const q = batch.find(q=>q.id===id);
                    if (q) task.completedKeys.add(q.fingerprint);
                }
                for (const id of result.skippedIds) {
                    const q = batch.find(q=>q.id===id);
                    if (q) task.failedKeys.add(q.fingerprint);
                }
                info(`批次 ${batchNo} 回填 ${result.filled}/${batch.length}`);
            } catch (err) {
                if (task.cancelled) break;
                for (const q of batch) task.failedKeys.add(q.fingerprint);
                error(`批次 ${batchNo} 失败`,err);
            } finally {
                // 取消时仍保留已完成的题目，未处理的题目交给下一次重试
                if (!task.cancelled) {
                    task.finished += batch.length;
                    ui.refresh();
                }
            }
        }
    }
    await Promise.all(Array.from({length:workers},(_,i)=>worker(i+1)));
}

export function fillAnswers(original,answers,mode = 'all',feedback = new Map()) {
    const current = getQuizContext();
    if (!current) throw new Error('题目 DOM 已消失');
    const filledIds = [],skippedIds = [];
    for (const q of original) {
        const choices = answers.get(q.id);
        if (!choices) { skippedIds.push(q.id); continue; }
        // 优先使用同一位置的题目，确保重复题干不会回填到其他题
        const direct = current.questions[q.id-1];
        const live = direct?.fingerprint === q.fingerprint ? direct :
            current.questions.filter(item=>item.fingerprint===q.fingerprint).length === 1
                ? current.questions.find(item=>item.fingerprint===q.fingerprint) : null;
        if (!live) { skippedIds.push(q.id);warn(`题目 ${q.id} 已变化，跳过`);continue; }
        if ((mode === 'wrong' || mode === 'retry') && isKnownWrongAnswer(live,choices,feedback.get(q.id))) {
            skippedIds.push(q.id);warn(`题目 ${q.id} 仍是上次失分答案`);continue;
        }
        const before = selectionSnapshot(live);
        const explanation = answers.explanations?.get(q.id);
        if (explanation) info(`题目 ${q.id} AI 解析：${explanation}`);
        const desired = new Set(choices);
        const targets = live.options.filter(o=>desired.has(o.label));
        if (targets.length !== desired.size || (live.isRadio && targets.length !== 1) ||
            live.options.some(o=>!o.input.isConnected || o.input.disabled || o.input.closest('fieldset[disabled]'))) {
            skippedIds.push(q.id);warn(`题目 ${q.id} 不可回填`);continue;
        }
        if (live.isRadio) {
            if (!targets[0].input.checked) targets[0].input.click();
        } else {
            for (const option of live.options) {
                if (option.input.checked !== desired.has(option.label)) option.input.click();
            }
        }
        const selected = live.options.filter(o=>o.input.checked).map(o=>o.label);
        if (selected.length===desired.size && selected.every(x=>desired.has(x))) filledIds.push(q.id);
        else skippedIds.push(q.id);
        log(`题目 ${q.id} 回填`,{before,expected:choices,selected,ok:filledIds.includes(q.id)});
    }
    return {filled:filledIds.length,skipped:skippedIds.length,filledIds,skippedIds};
}

export async function runQuiz(mode = 'all') {
    if (state.task) return;
    const context = getQuizContext();
    if (!context?.questions.length) { ui.toast('未找到题目');return; }
    const scored = context.questions.filter(q=>q.score?.graded);
    if (scored.length) saveWrongCache(context);
    let questions = context.questions;
    if (mode === 'wrong') {
        if (scored.length) questions = questions.filter(q=>q.score?.wrong);
        else {
            const keys = new Set(getWrongCache(context)?.keys || []);
            questions = questions.filter(q=>keys.has(q.fingerprint));
        }
    } else if (mode === 'retry') {
        const keys = new Set(state.lastResult?.route===`${location.pathname}${location.hash}` ? state.lastResult.failedKeys : []);
        questions = questions.filter(q=>keys.has(q.fingerprint));
    }
    if (!questions.length) { ui.toast('没有需要处理的题目');return; }
    const editable = questions.filter(q => q.options.every(o=>o.input?.isConnected && !o.input.disabled && !o.input.closest('fieldset[disabled]')));
    if (!editable.length) { ui.toast('选项不可编辑');warn('题目已锁定，请使用平台的重新作答入口');return; }
    if (editable.length < questions.length) warn(`跳过 ${questions.length-editable.length} 道锁定题目`);
    questions = editable;
    const feedback = mode === 'wrong' || mode === 'retry' ? collectWrongFeedback(questions,context) : new Map();
    const task = {
        id:++state.taskSeq,route:`${location.pathname}${location.hash}`,mode,
        questions,feedback,started:performance.now(),activeRequests:new Set(),
        controller:new AbortController(),cancelled:false,filled:0,finished:0,failedKeys:new Set(),completedKeys:new Set(),
    };
    state.task = task;
    state.busy = true;
    state.lastResult = null;
    const label = mode === 'wrong' ? '重做错题' : mode === 'retry' ? '重试未完成' : '开始答题';
    info(`${label} · ${questions.length} 题`);
    const ticker = setInterval(() => ui.refresh(),500);
    ui.refresh();
    try {
        await callLLM(questions,feedback,task);
    } catch (err) {
        error('任务运行异常',err);
    } finally {
        clearInterval(ticker);
        for (const q of questions) {
            if (!task.completedKeys.has(q.fingerprint)) task.failedKeys.add(q.fingerprint);
        }
        state.lastResult = {
            route:task.route,total:questions.length,filled:task.filled,
            failedKeys:[...task.failedKeys],cancelled:task.cancelled,
        };
        state.busy = false;
        state.task = null;
        info(`${label}结束 · 已填 ${task.filled}/${questions.length} · 待处理 ${task.failedKeys.size}`);
        ui.toast(task.cancelled ? `已停止 · ${task.filled}/${questions.length}` : `已回填 ${task.filled}/${questions.length}，请检查后手动提交`);
        ui.refresh();
    }
}
