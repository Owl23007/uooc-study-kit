import { ui } from './runtime.js';
import { SCORE_SELECTOR, state, log, info, warn, normalize, textOf, letterAt } from './runtime.js';
import { Storage } from './storage.js';

// ------------------------------------
// 题目 DOM：提交前后使用同一套题目提取函数，提交后额外读取评分
// ------------------------------------
export function quizDocs() {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
        try { if (frame.contentDocument?.documentElement) docs.push(frame.contentDocument); }
        catch (_) {} // 不越过跨域访问限制
    }
    return docs;
}

export function quizRoot(doc) {
    // 部分页面评分区 #testPaperShow 与题目表单不在同一子树
    // 优先选择实际包含题目的容器
    const roots = [doc.querySelector('#testPaperShow'), doc.querySelector('#examMain'), doc]
        .filter(Boolean);
    return roots.find(root => questionNodes(root).length) || roots[0];
}

export function questionNodes(root) {
    const known = [...root.querySelectorAll('.queContainer')];
    if (known.length) return known;
    // 旧/新模板备选：由选项向上找到同时包含题干和选项的最近容器
    const candidates = [];
    for (const input of root.querySelectorAll('input[type="radio"],input[type="checkbox"]')) {
        if (!input.closest('.ti-a')) continue;
        let node = input.closest('.ti-a')?.parentElement;
        while (node && node !== root) {
            if (node.querySelector('.ti-q-c, .question-title, .question-content') &&
                node.querySelectorAll('.ti-a input[type="radio"],.ti-a input[type="checkbox"]').length >= 2) {
                candidates.push(node); break;
            }
            node = node.parentElement;
        }
    }
    const unique = [...new Set(candidates)];
    return unique.filter(node => !unique.some(other => other !== node && node.contains(other)));
}

export function scoreOfSpan(span) {
    const label = span.closest('label');
    if (!label) return null;
    // 例如：( 10.00 <span>/ 0</span> 分 )
    const match = textOf(label).match(/(\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const full = Number(match[1]);
    const actual = Number(match[2]);
    if (!Number.isFinite(full) || !Number.isFinite(actual)) return null;
    return { full, actual, graded: actual >= 0, wrong: actual >= 0 && actual < full - 0.001, span };
}

export function extractQuestions(doc = document) {
    const root = quizRoot(doc);
    const nodes = questionNodes(root);
    const questions = [];
    const selectors = '.ti-q-c, .question-title, .question-content';
    for (const node of nodes) {
        const options = [...node.querySelectorAll('.ti-a')].map((o, i) => {
            const input = o.querySelector('input[type="radio"], input[type="checkbox"]');
            if (!input) return null;
            const rawLabel = textOf(o.querySelector('.ti-a-i')).replace(/[.．、\s]/g, '').toUpperCase();
            return {
                label: /^[A-Z]$/.test(rawLabel) ? rawLabel : letterAt(i),
                text: textOf(o.querySelector('.ti-a-c')) || textOf(o).replace(/^[A-Z][.、\s]*/, ''),
                input, node: o,
            };
        }).filter(Boolean);
        if (!options.length) continue;
        const title = textOf(node.querySelector(selectors));
        if (!title) {
            warn('发现无题干的题目，跳过', node);
            continue;
        }
        const id = questions.length + 1;
        const isRadio = options[0].input.type === 'radio';
        const fingerprint = normalize(title) + '\u241f' + options.map(o => normalize(o.text)).sort().join('\u241e');
        questions.push({ id, title, options, node, isRadio, fingerprint, score: null });
    }

    // 得分有时不在 .queContainer 内：优先 DOM 包含关系，其次仅在 1:1 时按 DOM 顺序对应
    const scoreRoot = doc.querySelector('#testPaperShow') || root;
    const marks = [...scoreRoot.querySelectorAll(SCORE_SELECTOR)]
        .map(scoreOfSpan).filter(Boolean);
    const used = new Set();
    for (const q of questions) {
        const idx = marks.findIndex((m, i) => !used.has(i) && q.node.contains(m.span));
        if (idx >= 0) { q.score = marks[idx]; used.add(idx); }
    }
    // 评分可能在同一题目外层，而不是 .queContainer 内
    for (const q of questions.filter(x => !x.score)) {
        const idx = marks.findIndex((m, i) => {
            if (used.has(i)) return false;
            let ancestor = q.node.parentElement;
            while (ancestor && ancestor !== root) {
                if (ancestor.contains(m.span) &&
                    questions.filter(item => ancestor.contains(item.node)).length === 1) return true;
                ancestor = ancestor.parentElement;
            }
            return false;
        });
        if (idx >= 0) { q.score = marks[idx]; used.add(idx); }
    }
    if (marks.length === questions.length && questions.some(q => !q.score)) {
        // 一一对应时采用顺序兜底
        questions.forEach((q, i) => { if (!q.score) q.score = marks[i]; });
    }
    return { doc, root, questions, marks };
}

export function getQuizContext() {
    const results = quizDocs().map(doc => extractQuestions(doc));
    return results.find(x => x.questions.length) || null;
}

export function cacheKey(context) {
    // 同一课程可能有多次章节测验，不使用课程 ID 作为唯一键
    // 保留 URL 的路由信息，防止不同测验互相污染
    return `wrong_questions_${location.pathname}${location.hash}`;
}

export function getWrongCache(context) {
    if (!context) return null;
    const entry = Storage.get(cacheKey(context), null);
    if (!entry || !Array.isArray(entry.keys) || !entry.keys.length) return null;
    // 不跨很长时间误用旧答案，只储存错题题目指纹，不储存模型答案
    if (Date.now() - entry.timestamp > 7 * 86400000) return null;
    return entry;
}

// 记录批改时选中的整组答案，连同得分保存，重新作答时可能重置选项
// 所以不能等到发出 LLM 请求时再读取 checked
export function selectionSnapshot(q) {
    return q.options.filter(o => o.input.checked).map(o => ({
        label: o.label, text: o.text,
    }));
}

export function saveWrongCache(context) {
    const scored = context.questions.filter(q => q.score?.graded);
    if (!scored.length) return;
    const previous = Storage.get(cacheKey(context), null);
    const wrong = scored.filter(q => q.score.wrong);
    const records = wrong.map(q => {
        // 当前 DOM 的评分未变化时保留首次批改的答案快照
        // 避免用户修正勾选项后，MutationObserver 把新答案覆盖成上次错误答案
        const existing = previous?.records?.find(r =>
            r.key === q.fingerprint &&
            r.score?.full === q.score.full && r.score?.actual === q.score.actual
        );
        return existing || {
            key: q.fingerprint,
            title: q.title,
            score: { full: q.score.full, actual: q.score.actual },
            selected: selectionSnapshot(q),
        };
    });
    Storage.set(cacheKey(context), {
        timestamp: Date.now(),
        keys: wrong.map(q => q.fingerprint),
        records,
        questionCount: context.questions.length,
    });
    info(`识别评分 ${scored.length}/${context.questions.length}；失分题 ${wrong.length}`);
    console.table(scored.map(q => ({
        id: q.id, title: q.title.slice(0, 52), full: q.score.full,
        actual: q.score.actual, wrong: q.score.wrong,
        previous: q.score.wrong
            ? (records.find(r => r.key === q.fingerprint)?.selected || []).map(o => o.label).join(',') || '未作答'
            : '-',
    })));
}

// 每次开始重做时冻结“上次被判错的答案”，后续 DOM 勾选变化不影响反馈
export function collectWrongFeedback(questions, context) {
    const cache = getWrongCache(context);
    const feedback = new Map();
    for (const q of questions) {
        const record = cache?.records?.find(r => r.key === q.fingerprint);
        if (record?.score?.actual >= 0 && record.score.actual < record.score.full &&
            Array.isArray(record.selected)) {
            feedback.set(q.id, record);
        } else if (q.score?.wrong) {
            feedback.set(q.id, {
                key: q.fingerprint,
                score: { full: q.score.full, actual: q.score.actual },
                selected: selectionSnapshot(q),
            });
        }
    }
    return feedback;
}

// 优先用选项文本定位，防止重做时 A/B/C/D 顺序变化导致错误答案串位
export function remapWrongChoices(q, record) {
    const mapped = [];
    for (const old of record?.selected || []) {
        const byText = old.text && q.options.find(o => normalize(o.text) === normalize(old.text));
        const matched = byText || (!old.text && q.options.find(o => o.label === old.label));
        if (matched) mapped.push(matched);
    }
    return [...new Map(mapped.map(o => [o.label, o])).values()];
}

export function isKnownWrongAnswer(q, choices, record) {
    if (!record || !Array.isArray(choices) || !record.selected?.length) return false;
    const failed = remapWrongChoices(q, record).map(o => o.label);
    return failed.length === record.selected.length && failed.length === choices.length &&
        failed.every(label => choices.includes(label));
}

export function updateQuizContext() {
    const next = getQuizContext();
    const prev = state.activeQuiz;
    const priorSignature = prev?.questions.map(q => `${q.fingerprint}:${q.score?.actual ?? '?'}`).join('|');
    const nextSignature = next?.questions.map(q => `${q.fingerprint}:${q.score?.actual ?? '?'}`).join('|');
    state.activeQuiz = next;
    if (next && priorSignature !== nextSignature) {
        log(`题目扫描 ${next.questions.length} 题，得分标记 ${next.marks.length} 个`);
        if (next.questions.some(q => q.score?.graded)) saveWrongCache(next);
    }
    ui.refresh();
}
