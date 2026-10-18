// ==UserScript==
// @name         UOOC Study Kit（UOOC 学习工具箱）
// @namespace    https://github.com/Owl23007
// @version      0.1.0-dev
// @description  UOOC 学习辅助工具箱：双版本导航、播放控制、BYOK 题目辅助与运行记录
// @author       Owl23007
// @homepageURL  https://github.com/Owl23007/uooc-study-kit
// @supportURL   https://github.com/Owl23007/uooc-study-kit/issues
// @updateURL    https://raw.githubusercontent.com/Owl23007/uooc-study-kit/dev/uooc-study-plugin.meta.js
// @downloadURL  https://raw.githubusercontent.com/Owl23007/uooc-study-kit/dev/uooc-study-plugin.user.js
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
// ==/UserScript==

(function() {

//#region src/storage.js
	var Storage = {
		get(key, fallback = null) {
			try {
				return GM_getValue(key, fallback);
			} catch {
				return fallback;
			}
		},
		set(key, value) {
			try {
				GM_setValue(key, value);
			} catch {
				throw new Error("Tampermonkey 存储不可用，请检查脚本权限");
			}
		}
	};

//#endregion
//#region src/core.js
	function abortError() {
		return new DOMException("操作已取消", "AbortError");
	}
	function waitFor(probe, { signal, timeout = 12e3, interval = 100, message = "等待超时" } = {}) {
		return new Promise((resolve, reject) => {
			let timer;
			const deadline = Date.now() + timeout;
			const finish = (error, value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				if (error) reject(error);
				else resolve(value);
			};
			const cancel = () => finish(abortError());
			const check = () => {
				if (signal?.aborted) return cancel();
				try {
					const value = probe();
					if (value) return finish(null, value);
					if (Date.now() >= deadline) return finish(new Error(message));
					timer = setTimeout(check, interval);
				} catch (error) {
					finish(error);
				}
			};
			signal?.addEventListener("abort", cancel, { once: true });
			check();
		});
	}
	function validateConfig(config) {
		let url;
		try {
			url = new URL(config?.baseUrl);
		} catch {
			throw new Error("API Base URL 无效");
		}
		const local = [
			"localhost",
			"127.0.0.1",
			"[::1]"
		].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("仅支持 HTTPS 或本地 HTTP");
		if (url.username || url.password || url.search || url.hash) throw new Error("API 地址不能包含凭证、查询参数或片段");
		if (!config.apiKey?.trim() || !config.model?.trim()) throw new Error("请填写 API Key 和模型");
		const temperature = config.temperature === "" || config.temperature == null ? void 0 : Number(config.temperature);
		if (temperature !== void 0 && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error("温度应为 0 到 2，或留空");
		return {
			baseUrl: url.href.replace(/\/+$/, ""),
			apiKey: config.apiKey.trim(),
			model: config.model.trim(),
			temperature
		};
	}
	function redact(value, secret = "") {
		let result = String(value ?? "");
		if (secret) result = result.split(secret).join("[已隐藏]");
		return result.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [已隐藏]").replace(/sk-[\w-]+/g, "[已隐藏]");
	}

//#endregion
//#region src/runtime.js
	var ui = {
		refresh() {},
		records() {},
		toast() {},
		settings() {}
	};
	var TAG = "[UOOC AI]";
	var SCORE_SELECTOR = "span[ng-if*=\"grade_score\"]";
	var DEFAULTS = Object.freeze({
		rate: true,
		mute: true,
		continuous: true,
		collapsed: false,
		panelX: null,
		panelY: 76,
		concurrency: 4,
		batchSize: 3,
		timeout: 9e4,
		retries: 1
	});
	var state = {
		prefs: { ...DEFAULTS },
		busy: false,
		switching: false,
		panel: null,
		uiRoot: null,
		host: null,
		toastElement: null,
		currentVideo: null,
		videoSrc: "",
		mediaEpoch: 0,
		videoEvents: /* @__PURE__ */ new WeakSet(),
		observedDocs: /* @__PURE__ */ new WeakSet(),
		observers: [],
		scanTimer: null,
		quizTimer: null,
		switchTimer: null,
		activeQuiz: null,
		started: false,
		canIgnoreTest: false,
		lastInlineQuiz: "",
		task: null,
		taskSeq: 0,
		lastResult: null,
		logs: [],
		requests: [],
		requestSeq: 0,
		recordOpen: false,
		recordTab: "requests",
		recordSelected: null,
		primaryMode: "all",
		secondaryMode: "all",
		wantsPlayback: true,
		manuallyPaused: false,
		lastPlayerGesture: -Infinity,
		resumeTimer: null,
		recoveryStart: 0,
		recoveryAttempts: 0,
		rateRestoreTimer: null,
		rateRestoreStart: 0,
		rateRestoreAttempts: 0,
		checkedCourseId: null,
		lastPlaybackStarted: 0
	};
	function emitLog(level, ...args) {
		const time = (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
		const format = (value) => {
			if (value instanceof Error) return value.message;
			if (typeof value === "string") return value;
			try {
				return JSON.stringify(value);
			} catch (_) {
				return String(value);
			}
		};
		const message = redact(args.map(format).join(" "), Storage.get("llm_config", {})?.apiKey).slice(0, 500);
		state.logs.push({
			level,
			time,
			message
		});
		if (state.logs.length > 250) state.logs.shift();
		(console[level] || console.log).call(console, TAG, message);
		if (state.recordOpen && state.recordTab === "logs") ui.records();
	}
	var log = (...args) => emitLog("log", ...args);
	var info = (...args) => emitLog("info", ...args);
	var warn = (...args) => emitLog("warn", ...args);
	var error = (...args) => emitLog("error", ...args);
	var normalize = (s) => String(s ?? "").replace(/\s+/g, "").replace(/^第?\d+[题.、:：)]/, "").trim();
	var textOf = (el) => (el?.innerText || el?.textContent || "").trim();
	var letterAt = (i) => String.fromCharCode(65 + i);
	Object.assign(state.prefs, Storage.get("assistant_prefs", {}) || {});
	delete state.prefs.autoplay;
	function savePrefs() {
		Storage.set("assistant_prefs", state.prefs);
	}
	for (const [key, min, max] of [
		[
			"concurrency",
			1,
			8
		],
		[
			"batchSize",
			1,
			10
		],
		[
			"retries",
			0,
			3
		],
		[
			"timeout",
			5e3,
			18e4
		]
	]) {
		const value = Number(state.prefs[key]);
		state.prefs[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : DEFAULTS[key];
	}

//#endregion
//#region src/quiz.js
	function quizDocs() {
		const docs = [document];
		for (const frame of document.querySelectorAll("iframe")) try {
			if (frame.contentDocument?.documentElement) docs.push(frame.contentDocument);
		} catch (_) {}
		return docs;
	}
	function quizRoot(doc) {
		const roots = [
			doc.querySelector("#testPaperShow"),
			doc.querySelector("#examMain"),
			doc
		].filter(Boolean);
		return roots.find((root) => questionNodes(root).length) || roots[0];
	}
	function questionNodes(root) {
		const known = [...root.querySelectorAll(".queContainer")];
		if (known.length) return known;
		const candidates = [];
		for (const input of root.querySelectorAll("input[type=\"radio\"],input[type=\"checkbox\"]")) {
			if (!input.closest(".ti-a")) continue;
			let node = input.closest(".ti-a")?.parentElement;
			while (node && node !== root) {
				if (node.querySelector(".ti-q-c, .question-title, .question-content") && node.querySelectorAll(".ti-a input[type=\"radio\"],.ti-a input[type=\"checkbox\"]").length >= 2) {
					candidates.push(node);
					break;
				}
				node = node.parentElement;
			}
		}
		const unique = [...new Set(candidates)];
		return unique.filter((node) => !unique.some((other) => other !== node && node.contains(other)));
	}
	function scoreOfSpan(span) {
		const label = span.closest("label");
		if (!label) return null;
		const match = textOf(label).match(/(\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
		if (!match) return null;
		const full = Number(match[1]);
		const actual = Number(match[2]);
		if (!Number.isFinite(full) || !Number.isFinite(actual)) return null;
		return {
			full,
			actual,
			graded: actual >= 0,
			wrong: actual >= 0 && actual < full - .001,
			span
		};
	}
	function extractQuestions(doc = document) {
		const root = quizRoot(doc);
		const nodes = questionNodes(root);
		const questions = [];
		const selectors = ".ti-q-c, .question-title, .question-content";
		for (const node of nodes) {
			const options = [...node.querySelectorAll(".ti-a")].map((o, i) => {
				const input = o.querySelector("input[type=\"radio\"], input[type=\"checkbox\"]");
				if (!input) return null;
				const rawLabel = textOf(o.querySelector(".ti-a-i")).replace(/[.．、\s]/g, "").toUpperCase();
				return {
					label: /^[A-Z]$/.test(rawLabel) ? rawLabel : letterAt(i),
					text: textOf(o.querySelector(".ti-a-c")) || textOf(o).replace(/^[A-Z][.、\s]*/, ""),
					input,
					node: o
				};
			}).filter(Boolean);
			if (!options.length) continue;
			const title = textOf(node.querySelector(selectors));
			if (!title) {
				warn("发现无题干的题目，跳过", node);
				continue;
			}
			const id = questions.length + 1;
			const isRadio = options[0].input.type === "radio";
			const fingerprint = normalize(title) + "␟" + options.map((o) => normalize(o.text)).sort().join("␞");
			questions.push({
				id,
				title,
				options,
				node,
				isRadio,
				fingerprint,
				score: null
			});
		}
		const marks = [...(doc.querySelector("#testPaperShow") || root).querySelectorAll(SCORE_SELECTOR)].map(scoreOfSpan).filter(Boolean);
		const used = /* @__PURE__ */ new Set();
		for (const q of questions) {
			const idx = marks.findIndex((m, i) => !used.has(i) && q.node.contains(m.span));
			if (idx >= 0) {
				q.score = marks[idx];
				used.add(idx);
			}
		}
		for (const q of questions.filter((x) => !x.score)) {
			const idx = marks.findIndex((m, i) => {
				if (used.has(i)) return false;
				let ancestor = q.node.parentElement;
				while (ancestor && ancestor !== root) {
					if (ancestor.contains(m.span) && questions.filter((item) => ancestor.contains(item.node)).length === 1) return true;
					ancestor = ancestor.parentElement;
				}
				return false;
			});
			if (idx >= 0) {
				q.score = marks[idx];
				used.add(idx);
			}
		}
		if (marks.length === questions.length && questions.some((q) => !q.score)) questions.forEach((q, i) => {
			if (!q.score) q.score = marks[i];
		});
		return {
			doc,
			root,
			questions,
			marks
		};
	}
	function getQuizContext() {
		return quizDocs().map((doc) => extractQuestions(doc)).find((x) => x.questions.length) || null;
	}
	function cacheKey(context) {
		return `wrong_questions_${location.pathname}${location.hash}`;
	}
	function getWrongCache(context) {
		if (!context) return null;
		const entry = Storage.get(cacheKey(context), null);
		if (!entry || !Array.isArray(entry.keys) || !entry.keys.length) return null;
		if (Date.now() - entry.timestamp > 6048e5) return null;
		return entry;
	}
	function selectionSnapshot(q) {
		return q.options.filter((o) => o.input.checked).map((o) => ({
			label: o.label,
			text: o.text
		}));
	}
	function saveWrongCache(context) {
		const scored = context.questions.filter((q) => q.score?.graded);
		if (!scored.length) return;
		const previous = Storage.get(cacheKey(context), null);
		const wrong = scored.filter((q) => q.score.wrong);
		const records = wrong.map((q) => {
			return previous?.records?.find((r) => r.key === q.fingerprint && r.score?.full === q.score.full && r.score?.actual === q.score.actual) || {
				key: q.fingerprint,
				title: q.title,
				score: {
					full: q.score.full,
					actual: q.score.actual
				},
				selected: selectionSnapshot(q)
			};
		});
		Storage.set(cacheKey(context), {
			timestamp: Date.now(),
			keys: wrong.map((q) => q.fingerprint),
			records,
			questionCount: context.questions.length
		});
		info(`识别评分 ${scored.length}/${context.questions.length}；失分题 ${wrong.length}`);
		console.table(scored.map((q) => ({
			id: q.id,
			title: q.title.slice(0, 52),
			full: q.score.full,
			actual: q.score.actual,
			wrong: q.score.wrong,
			previous: q.score.wrong ? (records.find((r) => r.key === q.fingerprint)?.selected || []).map((o) => o.label).join(",") || "未作答" : "-"
		})));
	}
	function collectWrongFeedback(questions, context) {
		const cache = getWrongCache(context);
		const feedback = /* @__PURE__ */ new Map();
		for (const q of questions) {
			const record = cache?.records?.find((r) => r.key === q.fingerprint);
			if (record?.score?.actual >= 0 && record.score.actual < record.score.full && Array.isArray(record.selected)) feedback.set(q.id, record);
			else if (q.score?.wrong) feedback.set(q.id, {
				key: q.fingerprint,
				score: {
					full: q.score.full,
					actual: q.score.actual
				},
				selected: selectionSnapshot(q)
			});
		}
		return feedback;
	}
	function remapWrongChoices(q, record) {
		const mapped = [];
		for (const old of record?.selected || []) {
			const matched = old.text && q.options.find((o) => normalize(o.text) === normalize(old.text)) || !old.text && q.options.find((o) => o.label === old.label);
			if (matched) mapped.push(matched);
		}
		return [...new Map(mapped.map((o) => [o.label, o])).values()];
	}
	function isKnownWrongAnswer(q, choices, record) {
		if (!record || !Array.isArray(choices) || !record.selected?.length) return false;
		const failed = remapWrongChoices(q, record).map((o) => o.label);
		return failed.length === record.selected.length && failed.length === choices.length && failed.every((label) => choices.includes(label));
	}
	function updateQuizContext() {
		const next = getQuizContext();
		const priorSignature = state.activeQuiz?.questions.map((q) => `${q.fingerprint}:${q.score?.actual ?? "?"}`).join("|");
		const nextSignature = next?.questions.map((q) => `${q.fingerprint}:${q.score?.actual ?? "?"}`).join("|");
		state.activeQuiz = next;
		if (next && priorSignature !== nextSignature) {
			log(`题目扫描 ${next.questions.length} 题，得分标记 ${next.marks.length} 个`);
			if (next.questions.some((q) => q.score?.graded)) saveWrongCache(next);
		}
		ui.refresh();
	}

//#endregion
//#region src/llm.js
	function buildPrompt(batch, feedback = /* @__PURE__ */ new Map(), rejected = /* @__PURE__ */ new Map()) {
		const sections = [
			"请独立分析以下选择题，并仅返回 JSON。",
			"返回格式：{\"answers\":[{\"id\":1,\"choices\":[\"A\"],\"explanation\":\"简要依据\"}]}",
			"id 必须使用题目提供的编号；choices 使用当前题目中的选项字母。",
			"多选题可返回多个字母；explanation 给出简要依据，不添加 Markdown。",
			"对于附带批改反馈的题，先逐项检查上次的选择，再得出修正答案。",
			"低于满分只代表上次的整组答案不完全正确，尤其多选题不能断定每个已选项都错误。",
			"勿照抄明确已判错的整组答案；如果证据不足，仍须审慎推理，而非机械反选。"
		];
		for (const q of batch) {
			sections.push(`\n题目 ${q.id}（${q.isRadio ? "单选/判断" : "多选"}）\n${q.title}`);
			for (const opt of q.options) sections.push(`${opt.label}. ${opt.text}`);
			const record = feedback.get(q.id);
			if (record) {
				const selected = remapWrongChoices(q, record);
				const formatted = selected.length ? selected.map((o) => `${o.label}（${o.text}）`).join("；") : record.selected?.length ? "已选答案未匹配当前选项" : "未选择";
				sections.push(`【上次批改反馈】实际得分 ${record.score.actual}/${record.score.full}；上次提交的答案：${formatted}。这组答案未得满分，请找出遗漏或错误的选项并重新判断。`);
			}
			const rejectedChoices = rejected.get(q.id);
			if (rejectedChoices?.length) sections.push(`【需要再次修正】你刚返回了 ${rejectedChoices.join(",")}，与已判定失分的上次答案完全一致。请重新逐项核对并给出修正后的组合。`);
		}
		return sections.join("\n");
	}
	function parseBatch(text, batch) {
		const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
		const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
		if (a === -1 || b <= a) throw new Error("模型未返回合法 JSON 对象");
		const parsed = JSON.parse(cleaned.slice(a, b + 1));
		if (!Array.isArray(parsed.answers)) throw new Error("缺少 answers 数组");
		const map = /* @__PURE__ */ new Map();
		map.explanations = /* @__PURE__ */ new Map();
		for (const item of parsed.answers) {
			const q = batch.find((x) => x.id === Number(item.id));
			if (!q || map.has(q.id)) continue;
			const allowed = new Set(q.options.map((o) => o.label));
			const choices = (Array.isArray(item.choices) ? item.choices : [item.choices]).flatMap((s) => String(s ?? "").toUpperCase().split(/[,，、\s]+/)).filter(Boolean);
			if (choices.some((x) => !allowed.has(x))) {
				warn(`题目 ${q.id} 含无效选项，跳过`);
				continue;
			}
			const unique = [...new Set(choices)];
			if (unique.length && (!q.isRadio || unique.length === 1)) {
				map.set(q.id, unique);
				if (typeof item.explanation === "string") map.explanations.set(q.id, item.explanation.slice(0, 500));
			}
		}
		return map;
	}
	function recordRequest(task, context) {
		const record = {
			id: ++state.requestSeq,
			taskId: task?.id ?? null,
			method: "POST",
			batch: context.batchNo,
			questionIds: context.batch.map((q) => q.id).join(", "),
			attempt: context.attempt,
			correction: !!context.correction,
			status: "running",
			httpStatus: null,
			tokens: null,
			started: performance.now(),
			duration: null,
			error: ""
		};
		state.requests.push(record);
		if (state.requests.length > 180) state.requests.splice(0, state.requests.length - 180);
		ui.records();
		return record;
	}
	function finishRequest(record, status, extra = {}) {
		if (record.status !== "running") return;
		record.status = status;
		record.duration = Math.round(performance.now() - record.started);
		Object.assign(record, extra);
		const message = `#${record.id} 批次 ${record.batch} ${status} · ${record.duration}ms${record.httpStatus ? ` · HTTP ${record.httpStatus}` : ""}`;
		if (status === "success") info(message);
		else warn(message, record.error);
		ui.records();
	}
	function gmRequest(url, config, batch, timeout, feedback, rejected = /* @__PURE__ */ new Map(), context = {}) {
		try {
			config = validateConfig(config);
		} catch (err) {
			return Promise.reject(err);
		}
		if (url !== `${config.baseUrl}/chat/completions`) return Promise.reject(/* @__PURE__ */ new Error("API 请求地址不匹配"));
		const task = context.task;
		if (task?.cancelled) return Promise.reject(/* @__PURE__ */ new Error("任务已停止"));
		const record = recordRequest(task, {
			batchNo: context.batchNo || 1,
			batch,
			attempt: context.attempt || 1,
			correction: context.correction
		});
		return new Promise((resolve, reject) => {
			const payload = {
				model: config.model,
				messages: [{
					role: "system",
					content: "请输出准确、可解析的 JSON 答案，保持题目编号"
				}, {
					role: "user",
					content: context.test ? "请简短回复 OK，用于连接测试" : buildPrompt(batch, feedback, rejected)
				}],
				...config.temperature !== void 0 ? { temperature: config.temperature } : {}
			};
			const limit = Number(timeout) > 0 ? Number(timeout) : DEFAULTS.timeout;
			let request;
			let timer;
			let settled = false;
			const finish = (status, value, details = {}) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				task?.activeRequests.delete(cancelRequest);
				finishRequest(record, status, details);
				if (status === "success") resolve(value);
				else reject(value instanceof Error ? value : new Error(String(value)));
			};
			const cancelRequest = () => {
				finish("cancelled", /* @__PURE__ */ new Error("请求已取消"));
				try {
					request?.abort?.();
				} catch (err) {
					warn("中止请求异常", err);
				}
			};
			task?.activeRequests.add(cancelRequest);
			timer = setTimeout(() => {
				finish("timeout", /* @__PURE__ */ new Error(`请求超时 ${limit}ms`), { error: `超过 ${limit}ms` });
				try {
					request?.abort?.();
				} catch (err) {
					warn("中止超时请求异常", err);
				}
			}, limit);
			try {
				request = GM_xmlhttpRequest({
					method: "POST",
					url,
					timeout: limit,
					anonymous: true,
					redirect: "error",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${config.apiKey}`
					},
					data: JSON.stringify(payload),
					onload: (res) => {
						if (res.status < 200 || res.status >= 300) {
							const err = /* @__PURE__ */ new Error(`HTTP ${res.status}`);
							finish("error", err, {
								httpStatus: res.status,
								error: `HTTP ${res.status}，请检查服务商、模型和凭证`
							});
							return;
						}
						try {
							if (res.finalUrl && new URL(res.finalUrl).href !== new URL(url).href) throw new Error("拒绝 API 重定向响应");
							let data;
							try {
								data = JSON.parse(res.responseText);
							} catch {
								throw new Error("服务端未返回合法 JSON");
							}
							const message = data?.choices?.[0]?.message?.content;
							if (!message) throw new Error("模型返回内容为空");
							const usage = data.usage || null;
							const tokens = usage?.total_tokens ?? null;
							finish("success", {
								message,
								usage
							}, {
								httpStatus: res.status,
								tokens
							});
						} catch (err) {
							finish("error", err, {
								httpStatus: res.status,
								error: redact(err.message, config.apiKey)
							});
						}
					},
					onerror: () => finish("error", /* @__PURE__ */ new Error("网络请求失败，请检查网络或 Tampermonkey 域名权限"), { error: "网络连接异常" }),
					ontimeout: () => finish("timeout", /* @__PURE__ */ new Error(`请求超时 ${limit}ms`), { error: "Tampermonkey 超时" }),
					onabort: () => finish("cancelled", /* @__PURE__ */ new Error("请求已取消"))
				});
				if (task?.cancelled) cancelRequest();
			} catch (err) {
				finish("error", err, { error: redact(err.message, config.apiKey) });
			}
		});
	}

//#endregion
//#region src/workflow.js
	function cancelTask(reason = "手动停止") {
		const task = state.task;
		if (!task || task.cancelled) return;
		task.cancelled = true;
		task.controller.abort();
		warn(`任务 #${task.id} 已停止：${reason}`);
		for (const cancel of [...task.activeRequests]) cancel();
		task.activeRequests.clear();
		ui.refresh();
	}
	async function callLLM(questions, feedback = /* @__PURE__ */ new Map(), task) {
		let config = Storage.get("llm_config", null);
		if (!config?.baseUrl || !config?.apiKey || !config?.model) {
			ui.settings();
			throw new Error("请先配置 API URL、API Key 和模型");
		}
		config = validateConfig(config);
		const prefs = { ...state.prefs };
		const size = Math.max(1, Math.min(10, Number(prefs.batchSize) || 3));
		const batches = [];
		for (let i = 0; i < questions.length; i += size) batches.push(questions.slice(i, i + size));
		const workers = Math.min(batches.length, Math.max(1, Math.min(8, Number(prefs.concurrency) || 4)));
		const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
		info(`启动 ${workers} 并发 · ${questions.length} 题 · ${batches.length} 批`);
		let cursor = 0;
		async function worker(workerId) {
			while (!task.cancelled && cursor < batches.length) {
				const index = cursor++;
				const batch = batches[index];
				const batchNo = index + 1;
				let output;
				info(`Worker ${workerId} · 批次 ${batchNo}/${batches.length} · ${batch.map((q) => q.id).join(",")}`);
				try {
					for (let retry = 0; retry <= prefs.retries && !task.cancelled; retry++) try {
						const response = await gmRequest(endpoint, config, batch, prefs.timeout, feedback, /* @__PURE__ */ new Map(), {
							task,
							batchNo,
							attempt: retry + 1
						});
						if (task.cancelled) break;
						output = parseBatch(response.message, batch);
						break;
					} catch (err) {
						if (task.cancelled) break;
						warn(`批次 ${batchNo} 第 ${retry + 1} 次失败`, err.message);
						if (retry >= prefs.retries) throw err;
						const retryAt = Date.now() + 600 * (retry + 1);
						await waitFor(() => Date.now() >= retryAt, {
							signal: task.controller.signal,
							timeout: 3e3
						});
					}
					if (task.cancelled) break;
					if (!output) throw new Error("批次没有解析结果");
					const repeated = batch.filter((q) => isKnownWrongAnswer(q, output.get(q.id), feedback.get(q.id)));
					if (repeated.length) {
						const rejected = new Map(repeated.map((q) => [q.id, output.get(q.id)]));
						warn(`批次 ${batchNo} 检测到重复失分答案，重新请求 ${repeated.map((q) => q.id).join(",")}`);
						try {
							const revised = await gmRequest(endpoint, config, repeated, prefs.timeout, feedback, rejected, {
								task,
								batchNo,
								attempt: 1,
								correction: true
							});
							if (task.cancelled) break;
							const corrected = parseBatch(revised.message, repeated);
							for (const q of repeated) {
								const next = corrected.get(q.id);
								if (next && !isKnownWrongAnswer(q, next, feedback.get(q.id))) {
									output.set(q.id, next);
									if (corrected.explanations?.has(q.id)) output.explanations.set(q.id, corrected.explanations.get(q.id));
								} else {
									output.delete(q.id);
									warn(`题目 ${q.id} 仍是已知错误组合，跳过`);
								}
							}
						} catch (err) {
							if (task.cancelled) break;
							for (const q of repeated) output.delete(q.id);
							warn(`批次 ${batchNo} 修正失败`, err.message);
						}
					}
					if (task.cancelled) break;
					if (location.pathname + location.hash !== task.route) {
						cancelTask("已切换试卷");
						break;
					}
					let result;
					try {
						result = fillAnswers(batch, output, task.mode, feedback);
					} catch (err) {
						warn(`批次 ${batchNo} 回填失败`, err);
						result = {
							filled: 0,
							skipped: batch.length,
							filledIds: [],
							skippedIds: batch.map((q) => q.id)
						};
					}
					task.filled += result.filled;
					for (const id of result.filledIds) {
						const q = batch.find((q) => q.id === id);
						if (q) task.completedKeys.add(q.fingerprint);
					}
					for (const id of result.skippedIds) {
						const q = batch.find((q) => q.id === id);
						if (q) task.failedKeys.add(q.fingerprint);
					}
					info(`批次 ${batchNo} 回填 ${result.filled}/${batch.length}`);
				} catch (err) {
					if (task.cancelled) break;
					for (const q of batch) task.failedKeys.add(q.fingerprint);
					error(`批次 ${batchNo} 失败`, err);
				} finally {
					if (!task.cancelled) {
						task.finished += batch.length;
						ui.refresh();
					}
				}
			}
		}
		await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));
	}
	function fillAnswers(original, answers, mode = "all", feedback = /* @__PURE__ */ new Map()) {
		const current = getQuizContext();
		if (!current) throw new Error("题目 DOM 已消失");
		const filledIds = [], skippedIds = [];
		for (const q of original) {
			const choices = answers.get(q.id);
			if (!choices) {
				skippedIds.push(q.id);
				continue;
			}
			const direct = current.questions[q.id - 1];
			const live = direct?.fingerprint === q.fingerprint ? direct : current.questions.filter((item) => item.fingerprint === q.fingerprint).length === 1 ? current.questions.find((item) => item.fingerprint === q.fingerprint) : null;
			if (!live) {
				skippedIds.push(q.id);
				warn(`题目 ${q.id} 已变化，跳过`);
				continue;
			}
			if ((mode === "wrong" || mode === "retry") && isKnownWrongAnswer(live, choices, feedback.get(q.id))) {
				skippedIds.push(q.id);
				warn(`题目 ${q.id} 仍是上次失分答案`);
				continue;
			}
			const before = selectionSnapshot(live);
			const explanation = answers.explanations?.get(q.id);
			if (explanation) info(`题目 ${q.id} AI 解析：${explanation}`);
			const desired = new Set(choices);
			const targets = live.options.filter((o) => desired.has(o.label));
			if (targets.length !== desired.size || live.isRadio && targets.length !== 1 || live.options.some((o) => !o.input.isConnected || o.input.disabled || o.input.closest("fieldset[disabled]"))) {
				skippedIds.push(q.id);
				warn(`题目 ${q.id} 不可回填`);
				continue;
			}
			if (live.isRadio) {
				if (!targets[0].input.checked) targets[0].input.click();
			} else for (const option of live.options) if (option.input.checked !== desired.has(option.label)) option.input.click();
			const selected = live.options.filter((o) => o.input.checked).map((o) => o.label);
			if (selected.length === desired.size && selected.every((x) => desired.has(x))) filledIds.push(q.id);
			else skippedIds.push(q.id);
			log(`题目 ${q.id} 回填`, {
				before,
				expected: choices,
				selected,
				ok: filledIds.includes(q.id)
			});
		}
		return {
			filled: filledIds.length,
			skipped: skippedIds.length,
			filledIds,
			skippedIds
		};
	}
	async function runQuiz(mode = "all") {
		if (state.task) return;
		const context = getQuizContext();
		if (!context?.questions.length) {
			ui.toast("未找到题目");
			return;
		}
		const scored = context.questions.filter((q) => q.score?.graded);
		if (scored.length) saveWrongCache(context);
		let questions = context.questions;
		if (mode === "wrong") {
			if (scored.length) questions = questions.filter((q) => q.score?.wrong);
			else {
				const keys = new Set(getWrongCache(context)?.keys || []);
				questions = questions.filter((q) => keys.has(q.fingerprint));
			}
		} else if (mode === "retry") {
			const keys = new Set(state.lastResult?.route === `${location.pathname}${location.hash}` ? state.lastResult.failedKeys : []);
			questions = questions.filter((q) => keys.has(q.fingerprint));
		}
		if (!questions.length) {
			ui.toast("没有需要处理的题目");
			return;
		}
		const editable = questions.filter((q) => q.options.every((o) => o.input?.isConnected && !o.input.disabled && !o.input.closest("fieldset[disabled]")));
		if (!editable.length) {
			ui.toast("选项不可编辑");
			warn("题目已锁定，请使用平台的重新作答入口");
			return;
		}
		if (editable.length < questions.length) warn(`跳过 ${questions.length - editable.length} 道锁定题目`);
		questions = editable;
		const feedback = mode === "wrong" || mode === "retry" ? collectWrongFeedback(questions, context) : /* @__PURE__ */ new Map();
		const task = {
			id: ++state.taskSeq,
			route: `${location.pathname}${location.hash}`,
			mode,
			questions,
			feedback,
			started: performance.now(),
			activeRequests: /* @__PURE__ */ new Set(),
			controller: new AbortController(),
			cancelled: false,
			filled: 0,
			finished: 0,
			failedKeys: /* @__PURE__ */ new Set(),
			completedKeys: /* @__PURE__ */ new Set()
		};
		state.task = task;
		state.busy = true;
		state.lastResult = null;
		const label = mode === "wrong" ? "重做错题" : mode === "retry" ? "重试未完成" : "开始答题";
		info(`${label} · ${questions.length} 题`);
		const ticker = setInterval(() => ui.refresh(), 500);
		ui.refresh();
		try {
			await callLLM(questions, feedback, task);
		} catch (err) {
			error("任务运行异常", err);
		} finally {
			clearInterval(ticker);
			for (const q of questions) if (!task.completedKeys.has(q.fingerprint)) task.failedKeys.add(q.fingerprint);
			state.lastResult = {
				route: task.route,
				total: questions.length,
				filled: task.filled,
				failedKeys: [...task.failedKeys],
				cancelled: task.cancelled
			};
			state.busy = false;
			state.task = null;
			info(`${label}结束 · 已填 ${task.filled}/${questions.length} · 待处理 ${task.failedKeys.size}`);
			ui.toast(task.cancelled ? `已停止 · ${task.filled}/${questions.length}` : `已回填 ${task.filled}/${questions.length}，请检查后手动提交`);
			ui.refresh();
		}
	}

//#endregion
//#region src/navigation.js
	function createNavigationCoordinator({ resolveAdapter, snapshot, restore, log, onState, timeout = 3e4 }) {
		let active = null;
		return {
			get busy() {
				return !!active;
			},
			cancel() {
				active?.controller.abort();
			},
			routeChanged(hash) {
				if (!active) return;
				const now = snapshot();
				const courseOf = (value) => value.replace(/^#\/?/, "").split("/")[0];
				const leftCourse = courseOf(hash) !== courseOf(active.before.hash);
				const leftPage = now.pathname !== active.before.pathname;
				if (leftCourse || leftPage || active.acceptHash && !active.acceptHash(hash)) active.controller.abort();
			},
			async next() {
				if (active) return false;
				const operation = {
					controller: new AbortController(),
					acceptHash: null,
					before: snapshot(),
					released: false
				};
				active = operation;
				onState(true);
				const timer = setTimeout(() => operation.controller.abort(), timeout);
				const signal = operation.controller.signal;
				try {
					const adapter = resolveAdapter();
					if (!adapter) throw new Error("平台版本或目录特征不匹配，停止导航");
					const before = operation.before;
					if (!await adapter.navigate({
						signal,
						onTarget: (predicate) => {
							operation.acceptHash = predicate;
						}
					})) {
						log("已到课程末尾，没有后续视频");
						return false;
					}
					if (!operation.acceptHash) throw new Error("目录适配器未登记目标资源");
					await waitFor(() => operation.acceptHash(snapshot().hash), {
						signal,
						message: "视频路由切换超时"
					});
					await waitFor(() => {
						const now = snapshot();
						const changed = now.video !== before.video || now.src !== before.src || now.mediaEpoch > before.mediaEpoch || now.source !== before.source;
						return operation.acceptHash(now.hash) && changed && now.video?.isConnected && (now.video.readyState >= 1 || now.src || now.source) && !now.video.ended && !now.video.error;
					}, {
						signal,
						message: "新播放器就绪超时"
					});
					onState(false);
					operation.released = true;
					const restored = await restore(signal);
					signal.throwIfAborted();
					if (restored === false) {
						log("已切换视频，但未能开始播放，请点击播放或查看运行记录");
						return false;
					}
					return true;
				} catch (error) {
					log(error.name === "AbortError" ? "视频切换已取消或超时" : `视频切换失败：${error.message}`);
					return false;
				} finally {
					clearTimeout(timer);
					if (active === operation) {
						active = null;
						if (!operation.released) onState(false);
					}
				}
			}
		};
	}

//#endregion
//#region src/platform/modern.js
	var MODERN_SELECTORS = Object.freeze({
		chapter: "li[ng-repeat*=\"chapterItem in chapterList\"]",
		section: "li[ng-repeat*=\"sectionItem in chapterItem.children\"]",
		sectionTrigger: ".level_2_title[ng-click]",
		resource: ".level_2_resourcelist_item[ng-click]"
	});
	function parseCourseRoute(hash) {
		const parts = hash.replace(/^#\/?/, "").split("/");
		if (parts.length !== 5 || parts[4] !== "section" || parts.slice(0, 4).some((x) => !x)) return null;
		const [courseId, chapterId, sectionId, sourceId] = parts;
		return {
			courseId,
			chapterId,
			sectionId,
			sourceId
		};
	}
	function flattenSections(chapters) {
		return chapters.flatMap((chapter) => (chapter.children || []).map((section) => ({
			chapter,
			section
		})));
	}
	function createModernAdapter({ document, page, location }) {
		const scopeOf = (node) => {
			try {
				return node && page.angular?.element(node).scope();
			} catch {
				return null;
			}
		};
		const find = (selector, key, id) => [...document.querySelectorAll(selector)].find((node) => String(scopeOf(node)?.[key]?.id) === String(id));
		const findSection = (id) => find(MODERN_SELECTORS.section, "sectionItem", id);
		const findChapter = (id) => find(MODERN_SELECTORS.chapter, "chapterItem", id);
		return {
			id: "modern",
			async navigate({ signal, onTarget }) {
				const route = parseCourseRoute(location.hash);
				if (!route) throw new Error("新版课程路由不匹配，停止导航");
				const wait = (probe, message, timeout = 6e3) => waitFor(() => {
					if (location.hash.replace(/^#\/?/, "").split("/")[0] !== route.courseId) throw new Error("目录定位期间已离开当前课程");
					return probe();
				}, {
					signal,
					timeout,
					message
				});
				const sections = flattenSections(await wait(() => {
					const list = scopeOf(findSection(route.sectionId))?.chapterList;
					return Array.isArray(list) && list.length && list;
				}, "无法从当前小节 Scope 读取 chapterList"));
				const start = sections.findIndex((item) => String(item.chapter.id) === route.chapterId && String(item.section.id) === route.sectionId);
				if (start < 0) throw new Error("当前小节不在新版目录中");
				async function openSection(chapter, section) {
					let node = findSection(section.id);
					const chapterNode = findChapter(chapter.id);
					const chapterData = scopeOf(chapterNode)?.chapterItem;
					if (!node || chapterData?.hide) {
						if (!chapterNode) throw new Error(`找不到新版章节 ${chapter.id}`);
						if (chapterData?.hide) {
							const trigger = [...chapterNode.querySelectorAll("[ng-click]")].find((candidate) => candidate.getAttribute("ng-click")?.includes("toggleChapter(chapterItem)"));
							if (!trigger) throw new Error(`未找到章节 ${chapter.id} 的展开按钮`);
							trigger.click();
						}
						node = await wait(() => findSection(section.id), `章节 ${chapter.id} 展开超时`);
					}
					const sectionData = scopeOf(node)?.sectionItem;
					if (!sectionData) throw new Error(`无法读取小节 ${section.id} 的 Scope`);
					if (sectionData.hide) {
						const trigger = node.querySelector(MODERN_SELECTORS.sectionTrigger);
						if (!trigger) throw new Error(`未找到小节 ${section.id} 的展开按钮`);
						trigger.click();
					}
					return wait(() => {
						const liveNode = findSection(section.id);
						const data = scopeOf(liveNode)?.sectionItem;
						return !data?.hide && Array.isArray(data?.unitSource) && { sources: data.unitSource };
					}, `小节 ${section.id} 资源加载超时`, 8e3);
				}
				for (let index = start; index < sections.length; index++) {
					signal?.throwIfAborted();
					const { chapter, section } = sections[index];
					const { sources } = await openSection(chapter, section);
					let from = 0;
					if (index === start) {
						const current = sources.findIndex((source) => String(source.id) === route.sourceId);
						if (current < 0) throw new Error("当前资源不在小节目录中，停止导航");
						from = current + 1;
					}
					const next = sources.slice(from).find((source) => Number(source.type) === 10);
					if (!next) continue;
					const resource = await wait(() => {
						const node = findSection(section.id);
						return node && [...node.querySelectorAll(MODERN_SELECTORS.resource)].find((candidate) => String(scopeOf(candidate)?.source?.id) === String(next.id));
					}, `视频 ${next.id} 的资源节点未渲染`, 5e3);
					onTarget((hash) => {
						const target = parseCourseRoute(hash);
						return target?.courseId === route.courseId && target.chapterId === String(chapter.id) && target.sectionId === String(section.id) && target.sourceId === String(next.id);
					});
					resource.click();
					return true;
				}
				return false;
			}
		};
	}

//#endregion
//#region src/platform/legacy.js
	function createLegacyAdapter({ document, canIgnoreTest, log = () => {} }) {
		return {
			id: "legacy",
			async navigate({ signal, onTarget }) {
				const current = document.querySelector(".basic.active");
				if (!current) throw new Error("旧版当前课程节点不存在");
				let part = current.parentNode;
				const hasVideo = (node) => !!node?.querySelector?.("span.icon-video");
				const nextVideo = (node) => {
					let next = node?.nextElementSibling;
					while (next && !hasVideo(next)) next = next.nextElementSibling;
					return next;
				};
				const firstVideo = (parent) => {
					let node = parent?.firstElementChild;
					while (node && !hasVideo(node)) node = node.nextElementSibling;
					return node;
				};
				const click = (node) => {
					if (!node?.isConnected) throw new Error("旧版资源节点已被替换，请重试");
					onTarget(() => true);
					log("旧版导航：点击视频资源", node.textContent?.trim().slice(0, 80) || "视频");
					node.click();
					return true;
				};
				async function search(mode, depth = 0) {
					signal.throwIfAborted();
					if (depth > 30) throw new Error("旧版目录遍历超过安全深度");
					if (!part) return false;
					if (!part.isConnected) throw new Error("旧版目录已重建，请重试");
					switch (mode) {
						case "next-video": {
							const node = nextVideo(current);
							if (node) return click(node);
							return search(part.nextElementSibling?.childElementCount ? "last-list" : "outer-item", depth + 1);
						}
						case "first-video": {
							const node = firstVideo(part);
							if (node) return click(node);
							if (part.nextElementSibling?.childElementCount) return search("last-list", depth + 1);
							if (canIgnoreTest() && part.lastElementChild) {
								part = part.lastElementChild;
								return search("outer-list", depth + 1);
							}
							return false;
						}
						case "last-list":
							part = part.nextElementSibling?.firstElementChild;
							return search("inner-list", depth + 1);
						case "next-list":
							part = part.nextElementSibling;
							return search("inner-list", depth + 1);
						case "inner-list": {
							if (part.matches?.(".basic[ui-sref]")) part = part.parentElement;
							const title = part?.firstElementChild;
							if (!title) return false;
							const container = part;
							if (!!!title.nextElementSibling && (!title.classList.contains("active") || title.querySelector(".icon-xiangxia"))) {
								log("旧版导航：展开目录", title.textContent?.trim().slice(0, 80));
								title.click();
							}
							const content = await waitFor(() => {
								const live = container.isConnected ? container : container.id && document.getElementById(container.id);
								if (!live) {
									if (!container.id) throw new Error("旧版目录已重建且没有稳定 ID，停止导航");
									return false;
								}
								part = live;
								const candidate = live.firstElementChild?.nextElementSibling;
								if (!candidate) return false;
								const resources = candidate.classList.contains("unfoldInfo") ? candidate.nextElementSibling : candidate;
								if (resources?.classList.contains("resourcelist") && !resources.childElementCount) return false;
								return candidate;
							}, {
								signal,
								message: "旧版目录展开或资源渲染超时"
							});
							const body = content.classList.contains("unfoldInfo") ? content.nextElementSibling : content;
							if (!body?.childElementCount) {
								log("旧版导航：跳过无资源目录", title.textContent?.trim().slice(0, 80));
								return search(part.nextElementSibling ? "next-list" : "outer-list", depth + 1);
							}
							part = body;
							if (part?.tagName === "UL") {
								part = part.firstElementChild;
								return search("inner-list", depth + 1);
							}
							return search("first-video", depth + 1);
						}
						case "outer-list":
							part = part.parentNode?.parentNode;
							if (!part) return false;
							if (part.nextElementSibling) return search("next-list", depth + 1);
							if (part.parentNode?.parentNode?.tagName === "LI") return search("outer-list", depth + 1);
							return false;
						case "outer-item":
							part = part.parentNode;
							if (!part) return false;
							if (part.nextElementSibling) return search("next-list", depth + 1);
							if (part.parentNode?.parentNode?.tagName === "LI") return search("outer-list", depth + 1);
							return false;
						default: return false;
					}
				}
				return search(current.hasAttribute?.("ui-sref") ? "inner-list" : "next-video");
			}
		};
	}

//#endregion
//#region src/platform/index.js
	var PLAYER_SELECTOR = "[source-view] [uooc-video] video, #player_html5_api";
	function resolvePlatform({ document, location, page, canIgnoreTest, log }) {
		if (/^\/home\/learn\/new\//.test(location.pathname)) {
			if (!page.angular?.element) return null;
			return createModernAdapter({
				document,
				page,
				location
			});
		}
		if (/^\/home\/learn\/index\/?$/.test(location.pathname) && document.querySelector(".basic.active")) return createLegacyAdapter({
			document,
			canIgnoreTest,
			log
		});
		return null;
	}

//#endregion
//#region src/video.js
	function activeVideo() {
		return document.querySelector(PLAYER_SELECTOR);
	}
	function hasInlineQuiz() {
		const layer = document.querySelector("#quizLayer");
		return !!(layer?.isConnected && layer.getClientRects?.().length);
	}
	var cancelledPlayback = /* @__PURE__ */ new WeakSet();
	async function safePlay(video, reason = "恢复播放", { signal } = {}) {
		if (!video?.isConnected || video.ended || signal?.aborted) return false;
		cancelledPlayback.delete(video);
		try {
			await new Promise((resolve, reject) => {
				let settled = false;
				let stopped = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
					if (error) reject(error);
					else resolve();
				};
				const cancel = () => {
					stopped = true;
					cancelledPlayback.add(video);
					video.pause();
					finish(new DOMException("播放已取消", "AbortError"));
				};
				const timer = setTimeout(() => {
					stopped = true;
					cancelledPlayback.add(video);
					video.pause();
					finish(/* @__PURE__ */ new Error("播放启动超时，请手动点击播放"));
				}, 1e4);
				signal?.addEventListener("abort", cancel, { once: true });
				try {
					Promise.resolve(video.play()).then(() => {
						if (stopped) {
							cancelledPlayback.add(video);
							video.pause();
						}
						finish();
					}, finish);
				} catch (error) {
					finish(error);
				}
			});
			return true;
		} catch (e) {
			if (e?.name === "NotAllowedError") {
				state.wantsPlayback = false;
				ui.toast("浏览器阻止自动播放，请点击播放");
			}
			if (e?.name !== "AbortError") warn(`${reason}失败`, e?.message || e);
			return false;
		}
	}
	function resetRecovery() {
		clearTimeout(state.resumeTimer);
		state.resumeTimer = null;
		state.recoveryStart = 0;
		state.recoveryAttempts = 0;
	}
	function scheduleResume(video, reason = "播放被中断") {
		if (!video?.isConnected || video !== state.currentVideo || !state.wantsPlayback || state.manuallyPaused || video.ended || state.switching || navigation.busy || cancelledPlayback.has(video) || hasInlineQuiz()) return;
		if (state.resumeTimer || !video.paused) return;
		if (video.readyState < 1 && !video.currentSrc && !video.src) return;
		const now = performance.now();
		if (now - state.recoveryStart > 12e3) {
			state.recoveryStart = now;
			state.recoveryAttempts = 0;
		}
		if (state.recoveryAttempts >= 3) return;
		state.resumeTimer = setTimeout(async () => {
			state.resumeTimer = null;
			if (video !== state.currentVideo || !video.isConnected || !video.paused || video.ended || !state.wantsPlayback || state.manuallyPaused || state.switching || navigation.busy || cancelledPlayback.has(video) || hasInlineQuiz()) return;
			state.recoveryAttempts++;
			if (await safePlay(video, reason)) log("已恢复视频播放", reason);
			ui.refresh();
		}, 280);
	}
	function togglePlayback() {
		const video = state.currentVideo;
		if (!video?.isConnected) return;
		if (video.paused) {
			state.manuallyPaused = false;
			state.wantsPlayback = true;
			resetRecovery();
			safePlay(video, "手动播放");
		} else {
			state.manuallyPaused = true;
			state.wantsPlayback = false;
			resetRecovery();
			clearTimeout(state.switchTimer);
			navigation.cancel();
			video.pause();
		}
		ui.refresh();
	}
	function applyVideoPrefs(video, newMedia = false) {
		if (!video?.isConnected) return;
		if (newMedia) cancelledPlayback.delete(video);
		video.muted = !!state.prefs.mute;
		video.playbackRate = state.prefs.rate ? 2 : 1;
		if (newMedia && state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused) scheduleResume(video, "新视频自动播放");
	}
	function restoreRate(video) {
		const desired = state.prefs.rate ? 2 : 1;
		if (video !== state.currentVideo || Math.abs(video.playbackRate - desired) < .01) return;
		if (state.rateRestoreTimer) return;
		const now = performance.now();
		if (now - state.rateRestoreStart > 12e3) {
			state.rateRestoreStart = now;
			state.rateRestoreAttempts = 0;
		}
		if (state.rateRestoreAttempts >= 3) return;
		state.rateRestoreTimer = setTimeout(() => {
			state.rateRestoreTimer = null;
			if (video !== state.currentVideo || !video.isConnected) return;
			state.rateRestoreAttempts++;
			video.playbackRate = desired;
			ui.refresh();
		}, 100);
	}
	var navigation = createNavigationCoordinator({
		resolveAdapter: () => resolvePlatform({
			document,
			location,
			page: typeof unsafeWindow !== "undefined" ? unsafeWindow : window,
			canIgnoreTest: () => state.canIgnoreTest,
			log: info
		}),
		snapshot: () => {
			const video = activeVideo();
			return {
				hash: location.hash,
				pathname: location.pathname,
				video,
				src: video?.currentSrc || video?.src || "",
				source: video?.src || video?.querySelector("source[src]")?.src || video?.currentSrc || "",
				mediaEpoch: state.mediaEpoch
			};
		},
		restore: async (signal) => {
			scanVideo();
			const video = state.currentVideo;
			if (!video) return;
			applyVideoPrefs(video);
			if (state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused && !hasInlineQuiz()) return safePlay(video, "连播恢复", { signal });
		},
		log: (message) => {
			info(message);
			ui.toast(message);
		},
		onState: (busy) => {
			state.switching = busy;
			ui.refresh();
		}
	});
	function nextVideo() {
		return navigation.next();
	}
	async function checkTestIgnorable() {
		const match = location.href.match(/index#\/(\d+)\//);
		if (!match) {
			state.canIgnoreTest = false;
			state.checkedCourseId = null;
			return;
		}
		if (state.checkedCourseId === match[1]) return;
		state.checkedCourseId = match[1];
		state.canIgnoreTest = false;
		const courseId = match[1];
		try {
			const response = await fetch(`/home/learn/getCourseLearn?cid=${encodeURIComponent(match[1])}`, {
				credentials: "include",
				signal: AbortSignal.timeout(1e4)
			});
			if (!response.ok) return;
			const result = await response.json();
			if (state.checkedCourseId !== courseId) return;
			state.canIgnoreTest = result?.data?.course_learn_mode === "20";
			log("课程允许跨过测验：", state.canIgnoreTest);
		} catch (e) {
			warn("读取课程学习模式失败", e);
		}
	}
	function bindVideo(v) {
		if (!v || state.videoEvents.has(v)) return;
		state.videoEvents.add(v);
		state.videoBinding?.abort();
		const binding = new AbortController();
		state.videoBinding = binding;
		const listen = (type, handler) => v.addEventListener(type, handler, { signal: binding.signal });
		listen("loadedmetadata", () => {
			if (state.currentVideo !== v) return;
			state.mediaEpoch++;
			state.videoSrc = v.currentSrc || v.src;
			applyVideoPrefs(v, true);
			ui.refresh();
		});
		listen("canplay", () => {
			if (state.currentVideo === v && state.prefs.continuous) scheduleResume(v, "视频已就绪");
		});
		listen("timeupdate", () => {
			if (!v.paused && performance.now() - state.lastPlaybackStarted > 4e3 && state.recoveryAttempts) resetRecovery();
			ui.refresh();
		});
		listen("durationchange", () => ui.refresh());
		listen("play", () => {
			if (state.currentVideo !== v) return;
			cancelledPlayback.delete(v);
			state.wantsPlayback = true;
			state.manuallyPaused = false;
			state.lastPlaybackStarted = performance.now();
			clearTimeout(state.resumeTimer);
			state.resumeTimer = null;
			ui.refresh();
		});
		listen("pause", () => {
			if (state.currentVideo !== v || v.ended || cancelledPlayback.has(v)) return;
			if (performance.now() - state.lastPlayerGesture < 1200) {
				state.manuallyPaused = true;
				state.wantsPlayback = false;
				navigation.cancel();
				resetRecovery();
			} else scheduleResume(v);
			ui.refresh();
		});
		listen("ratechange", () => {
			restoreRate(v);
			ui.refresh();
		});
		listen("volumechange", () => ui.refresh());
		listen("ended", () => {
			clearTimeout(state.resumeTimer);
			state.resumeTimer = null;
			ui.refresh();
			if (state.currentVideo === v && state.prefs.continuous && !state.manuallyPaused) {
				state.wantsPlayback = true;
				clearTimeout(state.switchTimer);
				state.switchTimer = setTimeout(nextVideo, 0);
			}
		});
		if (v.readyState >= 1) applyVideoPrefs(v, true);
	}
	function scanVideo() {
		const v = activeVideo();
		if (v && (v !== state.currentVideo || (v.currentSrc || v.src) !== state.videoSrc)) {
			resetRecovery();
			if (state.currentVideo) state.videoEvents.delete(state.currentVideo);
			state.currentVideo = v;
			state.mediaEpoch++;
			state.videoSrc = v.currentSrc || v.src;
			state.rateRestoreStart = 0;
			state.rateRestoreAttempts = 0;
			bindVideo(v);
			applyVideoPrefs(v, true);
			info("播放器就绪", state.videoSrc ? "(已载入媒体)" : "(等待媒体)");
		} else if (v && state.prefs.continuous && state.wantsPlayback && !state.manuallyPaused && v.paused && !v.ended) scheduleResume(v, "持续播放");
		else if (!v && state.currentVideo) {
			resetRecovery();
			state.videoBinding?.abort();
			state.videoEvents.delete(state.currentVideo);
			state.currentVideo = null;
			state.videoSrc = "";
		}
	}
	function bindKeyboard() {
		document.addEventListener("keydown", (e) => {
			if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
			if (state.uiRoot?.querySelector(".overlay")) return;
			if (e.composedPath?.().includes(state.host)) return;
			const el = e.target;
			if (el instanceof Element && (el.closest("input,textarea,select,button,[contenteditable=\"true\"]") || el.isContentEditable)) return;
			const v = state.currentVideo;
			if (!v?.isConnected || state.activeQuiz?.questions.length) return;
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				v.currentTime = Math.max(0, v.currentTime - 10);
			}
			if (e.key === "ArrowRight") {
				if (document.querySelector(".basic.active")?.classList.contains("complete")) {
					e.preventDefault();
					v.currentTime = Math.min(Number.isFinite(v.duration) ? v.duration : v.currentTime + 10, v.currentTime + 10);
				}
			}
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				v.volume = Math.max(0, Math.min(1, v.volume + (e.key === "ArrowUp" ? .1 : -.1)));
			}
			if (e.key === " ") {
				e.preventDefault();
				togglePlayback();
			}
		});
	}
	function checkInlineQuiz() {
		const layer = document.querySelector("#quizLayer");
		const sourceDiv = document.querySelector("div[uooc-video]");
		if (!layer || !sourceDiv || !hasInlineQuiz()) return;
		try {
			const source = JSON.parse(sourceDiv.getAttribute("source") || "{}");
			const title = document.querySelector(".smallTest-view .ti-q-c");
			if (!title || !Array.isArray(source.quiz)) return;
			const quiz = source.quiz.find((q) => q.question === title.innerHTML);
			if (!quiz) return;
			const key = `${location.hash}:${normalize(title.textContent)}:${JSON.stringify(quiz.answer)}`;
			if (state.lastInlineQuiz === key) return;
			const answers = Array.isArray(quiz.answer) ? quiz.answer.map(String) : String(quiz.answer || "").match(/[A-Z]/gi) || [];
			const options = layer.querySelector(".ti-alist");
			if (!options) return;
			state.lastInlineQuiz = key;
			for (const letter of answers) options.children[letter.toUpperCase().charCodeAt(0) - 65]?.click();
			layer.querySelector("button")?.click();
			log("课中小测已处理");
		} catch (e) {
			warn("课中小测解析失败：", e);
		}
	}

//#endregion
//#region src/ui.js
	var ICON_PATHS = {
		grip: "<circle cx=\"9\" cy=\"5\" r=\"1\"/><circle cx=\"15\" cy=\"5\" r=\"1\"/><circle cx=\"9\" cy=\"12\" r=\"1\"/><circle cx=\"15\" cy=\"12\" r=\"1\"/><circle cx=\"9\" cy=\"19\" r=\"1\"/><circle cx=\"15\" cy=\"19\" r=\"1\"/>",
		settings: "<path d=\"M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1.05 1.56V20h-2.9v-.04A1.7 1.7 0 0 0 11 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 7.6 15a1.7 1.7 0 0 0-1.56-1.05H6v-2.9h.04A1.7 1.7 0 0 0 7.6 10a1.7 1.7 0 0 0-.34-1.88L7.2 8.06 9.06 6.2l.06.06A1.7 1.7 0 0 0 11 6.6a1.7 1.7 0 0 0 1.05-1.56V5h2.9v.04A1.7 1.7 0 0 0 16 6.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.05H21v2.9h-.04A1.7 1.7 0 0 0 19.4 15Z\" transform=\"translate(-.5,-.5) scale(.96)\"/>",
		minus: "<path d=\"M5 12h14\"/>",
		play: "<path d=\"m8 5 11 7-11 7V5Z\"/>",
		pause: "<rect x=\"6\" y=\"5\" width=\"4\" height=\"14\" rx=\"1\"/><rect x=\"14\" y=\"5\" width=\"4\" height=\"14\" rx=\"1\"/>",
		gauge: "<path d=\"M5 17a8 8 0 1 1 14 0\"/><path d=\"m12 14 4-4\"/><path d=\"M8 18h8\"/>",
		volume: "<path d=\"M11 5 6 9H3v6h3l5 4V5Z\"/><path d=\"M15 9a5 5 0 0 1 0 6\"/><path d=\"M18 6a9 9 0 0 1 0 12\"/>",
		muted: "<path d=\"M11 5 6 9H3v6h3l5 4V5Z\"/><path d=\"m16 9 5 6m0-6-5 6\"/>",
		repeat: "<path d=\"m17 2 4 4-4 4\"/><path d=\"M3 11V9a3 3 0 0 1 3-3h15\"/><path d=\"m7 22-4-4 4-4\"/><path d=\"M21 13v2a3 3 0 0 1-3 3H3\"/>",
		terminal: "<path d=\"m4 6 5 5-5 5\"/><path d=\"M12 18h8\"/>",
		chevronDown: "<path d=\"m6 9 6 6 6-6\"/>",
		chevronUp: "<path d=\"m6 15 6-6 6 6\"/>"
	};
	var iconSvg = (name) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
	function ensureUI() {
		Object.assign(ui, {
			refresh: refreshButtons,
			records: renderRecords,
			toast,
			settings: showSettings
		});
		if (state.panel?.isConnected) return;
		state.host?.remove();
		const host = document.createElement("div");
		host.id = "uooc-assistant-host";
		host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;contain:layout style";
		document.body.append(host);
		const root = host.attachShadow({ mode: "open" });
		state.host = host;
		state.uiRoot = root;
		const style = document.createElement("style");
		style.textContent = `
        :host { color-scheme: dark; }
        *, *::before, *::after { box-sizing: border-box; }
        button, input { font: inherit; }
        button { cursor: pointer; border: 0; }
        button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        button:disabled { opacity: .43; cursor: not-allowed; }
        .panel, .modal, .toast { --surface:#222326;--raised:#2d2e32;--hover:#36373b;
            --line:#414246;--text:#e9e5df;--dim:#9c9a98;--accent:#c7b6a4;
            --accent-bg:rgba(199,182,164,.16);--success:#a6b8a5;--danger:#d08d90;
            font: 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
            color:var(--text);-webkit-font-smoothing:antialiased; }
        .panel { position:fixed;top:76px;right:20px;width:304px;max-width:calc(100vw - 16px);
            max-height:calc(100dvh - 16px);pointer-events:auto;display:flex;flex-direction:column;
            background:var(--surface);border:1px solid #454548;border-radius:14px;
            box-shadow:0 16px 55px rgba(0,0,0,.34);overflow:hidden;user-select:none; }
        .panel.dragging { box-shadow:0 20px 65px rgba(0,0,0,.47); }
        .hd { height:43px;min-height:43px;padding:0 10px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line); }
        .drag { width:24px;height:28px;display:grid;place-items:center;background:none;color:var(--dim);touch-action:none;
            cursor:grab;padding:0;border-radius:7px; }
        .drag:hover { color:var(--text);background:var(--hover); }
        .drag:active { cursor:grabbing; }
        .brand { font-size:12px;font-weight:750;letter-spacing:.3px; }
        .signal { width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--accent); }
        .status { color:var(--dim);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-align:right; }
        .icon { width:27px;height:27px;display:inline-flex;align-items:center;justify-content:center;
            border-radius:7px;background:none;color:var(--dim);line-height:1;padding:0; }
        .icon svg,.drag svg,.log-toggle svg { width:15px;height:15px;flex-shrink:0; }
        .icon:hover { background:var(--hover);color:var(--text); }
        .body { padding:12px;min-height:108px;overflow-y:auto;scrollbar-width:thin; }
        .panel.collapsed { width:164px; }
        .panel.collapsed .body, .panel.collapsed .log-section { display:none; }
        .panel.collapsed .hd { border-bottom:0; }
        .context-head { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:11px; }
        .context-title { color:var(--text);font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .context-meta { color:var(--dim);font-size:10px;white-space:nowrap; }
        .track { width:100%;height:3px;background:#454347;border-radius:99px;overflow:hidden; }
        .track > i { height:100%;display:block;width:0%;background:var(--accent);border-radius:99px;transition:width .18s linear; }
        .timeline { display:flex;justify-content:space-between;align-items:center;color:var(--dim);
            font-size:10px;font-variant-numeric:tabular-nums;margin:7px 0 11px; }
        .controls { display:grid;grid-template-columns:1.18fr .78fr 1fr 1fr;gap:6px; }
        .control { display:flex;align-items:center;justify-content:center;gap:5px;height:36px;
            min-width:0;background:var(--raised);color:var(--text);border-radius:9px;
            font-size:11px;font-weight:600;white-space:nowrap;padding:0 5px;transition:background .14s ease; }
        .control svg { width:14px;height:14px;flex-shrink:0; }
        .control:hover { background:var(--hover); }
        .control.on { color:var(--accent);background:var(--accent-bg); }
        .control.play { background:var(--accent);color:#252527; }
        .control.play:hover { background:#d9cabb; }
        .control[aria-pressed="true"] { border:1px solid rgba(199,182,164,.24); }
        .actions { display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:7px;margin-top:12px; }
        .btn { height:34px;border-radius:8px;padding:0 9px;color:var(--text);background:var(--raised);
            white-space:nowrap;font-size:11px;font-weight:650; }
        .btn:hover:not(:disabled) { background:var(--hover); }
        .btn.main { color:#252527;background:var(--accent); }
        .btn.main:hover:not(:disabled) { background:#d9cabb; }
        .btn.stop { color:var(--danger);background:rgba(208,141,144,.14); }
        .btn[hidden], .context[hidden], .task-stat[hidden], .log-section[hidden] { display:none !important; }
        .task-stat { display:grid;gap:7px;margin-top:12px; }
        .task-head { display:flex;justify-content:space-between;font-size:10px;color:var(--dim); }
        .log-section { border-top:1px solid var(--line); }
        .log-toggle { width:100%;display:flex;gap:8px;align-items:center;height:35px;padding:0 13px;
            color:#b4b0ac;background:none;text-align:left;font-size:11px; }
        .log-toggle .log-icon { display:inline-flex;align-items:center;justify-content:center;color:var(--dim); }
        .log-toggle .chevron { display:inline-flex;align-items:center;justify-content:center; }
        .log-toggle:hover { color:var(--text); }
        .log-toggle .count { color:var(--dim);margin-left:auto;font-variant-numeric:tabular-nums;font-size:10px; }
        .log-content { border-top:1px solid var(--line);padding:9px 10px 10px;max-height:min(42dvh,380px);overflow:auto;scrollbar-width:thin; }
        .tabs { display:flex;align-items:center;gap:4px;margin-bottom:8px; }
        .tab { padding:5px 10px;color:var(--dim);border-radius:6px;background:transparent;font-size:11px; }
        .tab.active { color:var(--text);background:var(--raised); }
        .tab-spacer { flex:1; }
        .text-action { font-size:10px;color:var(--dim);padding:4px 6px;border-radius:6px;background:none; }
        .text-action:hover { background:var(--hover);color:var(--text); }
        .request-row { display:flex;width:100%;align-items:center;gap:8px;text-align:left;padding:8px 5px;
            color:var(--text);background:transparent;border-radius:7px; }
        .request-row:hover { background:var(--raised); }
        .request-row .number { min-width:31px;color:var(--dim);font-size:10px; }
        .request-row .details { flex:1;min-width:0;display:grid;gap:1px; }
        .request-row .details strong { font-size:11px;font-weight:550; }
        .request-row .details small { font-size:10px;color:var(--dim); }
        .request-row .elapsed { color:var(--dim);font-variant-numeric:tabular-nums;font-size:10px; }
        .dot { width:6px;height:6px;border-radius:50%;background:#8a8786;flex:0 0 6px; }
        .dot.running { background:var(--accent); }
        .dot.success { background:var(--success); }
        .dot.error, .dot.timeout { background:var(--danger); }
        .dot.cancelled { background:#8a8786; }
        .request-extra { padding:7px 10px 10px;margin:0 5px 5px 13px;border-left:1px solid var(--line);
            font:10px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dim);white-space:pre-wrap;word-break:break-word; }
        .log-row { padding:5px 4px;border-bottom:1px solid #37383b;font:10px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
            white-space:pre-wrap;word-break:break-word;color:#bdbab5; }
        .log-row .log-time { color:#898786;padding-right:9px; }
        .log-row.warn { color:var(--accent); }.log-row.error { color:var(--danger); }
        .empty { padding:18px 6px;text-align:center;color:var(--dim);font-size:11px; }
        .toast { position:fixed;bottom:18px;right:18px;max-width:min(370px,calc(100vw - 36px));
            background:#292a2d;color:var(--text);padding:10px 12px;border-radius:9px;border:1px solid #48484a;
            box-shadow:0 15px 45px #0006;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s; }
        .toast.show { opacity:1;transform:translateY(0); }
        .overlay { position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;
            background:rgba(10,10,12,.63);pointer-events:auto;backdrop-filter:blur(4px); }
        .modal { width:min(410px,100%);max-height:calc(100dvh - 32px);overflow:auto;scrollbar-width:thin;
            background:#252629;border:1px solid #49494d;border-radius:13px;padding:17px 18px;
            box-shadow:0 22px 70px #0009; }
        .modal h3 { font-size:14px;margin:0 0 13px;font-weight:700; }
        .modal label { display:block;width:100%;min-width:0;margin:0 0 10px;color:#c5c0b9;font-size:11px; }
        .modal input[type="text"],.modal input[type="password"],.modal input[type="number"] {
            display:block;width:100%;height:35px;margin-top:5px;min-width:0;border:1px solid #515157;
            border-radius:7px;background:#303136;padding:0 10px;color:var(--text);font-size:12px;outline:none; }
        .modal input:focus { border-color:var(--accent); }
        .modal .grid2 { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px; }
        .modal #uc-test-status { align-self:end;min-width:0;margin:0;color:var(--dim);font-size:11px; }
        .modal .row { display:flex;align-items:center;gap:8px;margin:7px 0 13px;font-size:11px;color:var(--dim); }
        .modal .row input { accent-color:var(--accent); }
        .modal .buttons { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:15px; }
        .modal .buttons .btn { min-width:66px; }
        .modal .button-group { display:flex;gap:8px; }
        @media(max-width:370px) { .modal .grid2 { grid-template-columns:1fr;gap:0; } }
    `;
		root.append(style);
		const panel = document.createElement("section");
		panel.className = "panel";
		panel.innerHTML = `
        <div class="hd">
            <button class="drag" title="拖动" aria-label="拖动">${iconSvg("grip")}</button>
            <span class="signal"></span><span class="brand">UOOC</span>
            <span class="status" id="uooc-status">就绪</span>
            <button class="icon" id="uooc-settings" title="设置" aria-label="设置">${iconSvg("settings")}</button>
            <button class="icon" id="uooc-collapse" title="收起" aria-label="收起">${iconSvg("minus")}</button>
        </div>
        <div class="body">
            <div class="context" id="uooc-video-view" hidden>
                <div class="context-head"><span class="context-title">视频播放</span><span class="context-meta" id="uooc-video-rate">1×</span></div>
                <div class="track"><i id="uooc-video-fill"></i></div>
                <div class="timeline"><span id="uooc-video-time">00:00</span><span id="uooc-video-duration">00:00</span></div>
                <div class="controls">
                    <button class="control play" id="uooc-play">${iconSvg("play")}<span>播放</span></button>
                    <button class="control" id="uooc-rate" title="倍速">${iconSvg("gauge")}<span>2×</span></button>
                    <button class="control" id="uooc-mute">${iconSvg("muted")}<span>静音</span></button>
                    <button class="control" id="uooc-continuous" title="自动播放并切换下一节">${iconSvg("repeat")}<span>连播</span></button>
                </div>
            </div>
            <div class="context" id="uooc-quiz-view" hidden>
                <div class="context-head"><span class="context-title">章节测验</span><span class="context-meta" id="uooc-quiz-state">0 题</span></div>
                <div class="actions">
                    <button class="btn main" id="uooc-primary">开始答题</button>
                    <button class="btn" id="uooc-secondary">全部答题</button>
                </div>
                <div class="task-stat" id="uooc-task-stat" hidden>
                    <div class="task-head"><span id="uooc-task-description"></span><span id="uooc-task-elapsed"></span></div>
                    <div class="track"><i id="uooc-task-fill"></i></div>
                </div>
            </div>
            <div class="context" id="uooc-empty-view"><div class="context-head" style="margin:0"><span class="context-title">等待课程内容</span></div></div>
        </div>
        <div class="log-section">
            <button class="log-toggle" id="uooc-log-toggle" aria-expanded="false">
                <span class="log-icon">${iconSvg("terminal")}</span><span>运行记录</span><span class="count" id="uooc-log-count">0</span><span class="chevron" id="uooc-log-chevron">${iconSvg("chevronDown")}</span>
            </button>
            <div class="log-content" id="uooc-log-content" hidden>
                <div class="tabs">
                    <button class="tab active" data-log-tab="requests">请求</button>
                    <button class="tab" data-log-tab="logs">日志</button>
                    <span class="tab-spacer"></span>
                    <button class="text-action" id="uooc-log-copy">复制</button>
                    <button class="text-action" id="uooc-log-clear">清空</button>
                </div>
                <div id="uooc-log-items"></div>
            </div>
        </div>`;
		root.append(panel);
		const toastElement = document.createElement("div");
		toastElement.className = "toast";
		root.append(toastElement);
		state.toastElement = toastElement;
		state.panel = panel;
		const $ = (sel) => panel.querySelector(sel);
		$("#uooc-collapse").addEventListener("click", () => {
			state.prefs.collapsed = !state.prefs.collapsed;
			savePrefs();
			refreshButtons();
			clampPanel();
		});
		$("#uooc-settings").addEventListener("click", showSettings);
		$("#uooc-play").addEventListener("click", () => togglePlayback());
		for (const key of [
			"rate",
			"mute",
			"continuous"
		]) $(`#uooc-${key}`).addEventListener("click", () => {
			state.prefs[key] = !state.prefs[key];
			savePrefs();
			const v = state.currentVideo;
			if (v && key === "rate") v.playbackRate = state.prefs.rate ? 2 : 1;
			if (v && key === "mute") v.muted = state.prefs.mute;
			if (key === "continuous" && !state.prefs.continuous) {
				navigation.cancel();
				resetRecovery();
			}
			if (key === "continuous" && state.prefs.continuous && v && !state.manuallyPaused && v.paused && !v.ended) {
				state.wantsPlayback = true;
				scheduleResume(v, "开启连播");
			}
			refreshButtons();
		});
		$("#uooc-primary").addEventListener("click", () => {
			if (state.task) cancelTask();
			else runQuiz(state.primaryMode || "all");
		});
		$("#uooc-secondary").addEventListener("click", () => runQuiz(state.secondaryMode || "all"));
		$("#uooc-log-toggle").addEventListener("click", () => {
			state.recordOpen = !state.recordOpen;
			$("#uooc-log-content").hidden = !state.recordOpen;
			$("#uooc-log-toggle").setAttribute("aria-expanded", String(state.recordOpen));
			$("#uooc-log-chevron").innerHTML = iconSvg(state.recordOpen ? "chevronUp" : "chevronDown");
			renderRecords();
		});
		panel.querySelectorAll("[data-log-tab]").forEach((btn) => btn.addEventListener("click", () => {
			state.recordTab = btn.dataset.logTab;
			renderRecords();
		}));
		$("#uooc-log-clear").addEventListener("click", () => {
			state.logs = [];
			state.requests = state.requests.filter((r) => r.status === "running");
			state.recordSelected = null;
			renderRecords();
		});
		$("#uooc-log-copy").addEventListener("click", async () => {
			const content = state.recordTab === "requests" ? state.requests.map((r) => `${r.id}\t${r.method}\t${r.batch}\t${r.status}\t${r.httpStatus || "-"}\t${r.duration || "-"}ms\t${r.error || ""}`).join("\n") : state.logs.map((r) => `${r.time}\t${r.level}\t${r.message}`).join("\n");
			try {
				await navigator.clipboard.writeText(content);
				toast("已复制");
			} catch (err) {
				warn("复制失败", err?.message || err);
				toast("复制失败");
			}
		});
		$("#uooc-log-items").addEventListener("click", (e) => {
			const row = e.target.closest("[data-request-id]");
			if (!row) return;
			state.recordSelected = state.recordSelected === Number(row.dataset.requestId) ? null : Number(row.dataset.requestId);
			renderRecords();
		});
		installDrag(panel, $(".drag"));
		refreshButtons();
		log("面板就绪");
	}
	var $panel = (selector) => state.panel?.querySelector(selector);
	function toast(message, ms = 3e3) {
		const el = state.toastElement;
		if (!el) return;
		el.textContent = message;
		el.classList.add("show");
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => el.classList.remove("show"), ms);
	}
	function renderRecords() {
		if (!state.panel) return;
		const count = state.requests.filter((r) => r.status === "running").length;
		$panel("#uooc-log-count").textContent = count ? `${count} 活动` : String(state.requests.length);
		if (!state.recordOpen) return;
		state.panel.querySelectorAll("[data-log-tab]").forEach((x) => x.classList.toggle("active", x.dataset.logTab === state.recordTab));
		const root = $panel("#uooc-log-items");
		root.replaceChildren();
		if (state.recordTab === "logs") {
			if (!state.logs.length) {
				root.innerHTML = "<div class=\"empty\">暂无日志</div>";
				return;
			}
			for (const entry of state.logs.slice(-80).reverse()) {
				const div = document.createElement("div");
				div.className = `log-row ${entry.level}`;
				const time = document.createElement("span");
				time.className = "log-time";
				time.textContent = entry.time;
				div.append(time, document.createTextNode(entry.message));
				root.append(div);
			}
			return;
		}
		if (!state.requests.length) {
			root.innerHTML = "<div class=\"empty\">暂无请求</div>";
			return;
		}
		for (const entry of state.requests.slice(-45).reverse()) {
			const row = document.createElement("button");
			row.className = "request-row";
			row.dataset.requestId = String(entry.id);
			row.innerHTML = `<span class="dot ${[
				"running",
				"success",
				"error",
				"timeout",
				"cancelled"
			].includes(entry.status) ? entry.status : "running"}"></span><span class="number">#${entry.id}</span><span class="details"></span><span class="elapsed"></span>`;
			row.querySelector(".details").replaceChildren();
			const strong = document.createElement("strong");
			strong.textContent = `批次 ${entry.batch}${entry.correction ? " · 修正" : ""}`;
			const sub = document.createElement("small");
			sub.textContent = `${entry.questionIds} · ${{
				running: "请求中",
				success: "已完成",
				error: "失败",
				timeout: "超时",
				cancelled: "已取消"
			}[entry.status] || entry.status}`;
			row.querySelector(".details").append(strong, sub);
			row.querySelector(".elapsed").textContent = entry.status === "running" ? `${((performance.now() - entry.started) / 1e3).toFixed(1)}s` : `${entry.duration ?? 0}ms`;
			root.append(row);
			if (state.recordSelected === entry.id) {
				const extra = document.createElement("div");
				extra.className = "request-extra";
				extra.textContent = `状态 ${entry.status}\nHTTP ${entry.httpStatus ?? "-"}\n尝试 ${entry.attempt}\n耗时 ${entry.duration ?? "-"}ms\nTokens ${entry.tokens ?? "-"}${entry.error ? `\n错误 ${entry.error}` : ""}`;
				root.append(extra);
			}
		}
	}
	function refreshButtons() {
		const panel = state.panel;
		if (!panel) return;
		panel.classList.toggle("collapsed", !!state.prefs.collapsed);
		$panel("#uooc-collapse").innerHTML = state.prefs.collapsed ? iconSvg("chevronDown") : iconSvg("minus");
		const context = state.activeQuiz;
		const questions = context?.questions || [];
		const scores = questions.filter((q) => q.score?.graded);
		const cache = getWrongCache(context);
		const wrong = scores.length ? questions.filter((q) => q.score?.wrong) : questions.filter((q) => cache?.keys.includes(q.fingerprint));
		const showQuiz = questions.length > 0;
		const showVideo = !showQuiz && !!state.currentVideo?.isConnected;
		$panel("#uooc-quiz-view").hidden = !showQuiz;
		$panel("#uooc-video-view").hidden = !showVideo;
		$panel("#uooc-empty-view").hidden = showQuiz || showVideo;
		const task = state.task;
		let status = task ? "运行中" : showQuiz ? scores.length ? "已批改" : "测验" : showVideo ? "视频" : "就绪";
		$panel("#uooc-status").textContent = status;
		if (showQuiz) {
			$panel("#uooc-quiz-state").textContent = scores.length ? `${wrong.length} 错 / ${questions.length} 题` : `${questions.length} 题`;
			const primary = $panel("#uooc-primary");
			const secondary = $panel("#uooc-secondary");
			const failed = state.lastResult?.route === `${location.pathname}${location.hash}` ? state.lastResult.failedKeys.filter((key) => questions.some((q) => q.fingerprint === key)) : [];
			state.primaryMode = failed.length ? "retry" : wrong.length ? "wrong" : "all";
			state.secondaryMode = "all";
			primary.textContent = task ? "停止" : state.primaryMode === "wrong" ? "重做错题" : state.primaryMode === "retry" ? "重试未完成" : "开始答题";
			primary.classList.toggle("stop", !!task);
			primary.classList.toggle("main", !task);
			primary.disabled = !task && !!scores.length && !wrong.length && !failed.length;
			secondary.textContent = "全部答题";
			secondary.hidden = !!task || !scores.length && !wrong.length && !failed.length;
			secondary.disabled = !!task;
			const stat = $panel("#uooc-task-stat");
			const last = state.lastResult;
			const relevantLast = last?.route === `${location.pathname}${location.hash}`;
			stat.hidden = !(task || relevantLast);
			if (task) {
				const total = task.questions.length;
				$panel("#uooc-task-description").textContent = `${task.filled}/${total} 已填 · ${task.finished}/${total} 已处理`;
				$panel("#uooc-task-fill").style.width = `${total ? task.finished / total * 100 : 0}%`;
				$panel("#uooc-task-elapsed").textContent = `${Math.round((performance.now() - task.started) / 1e3)}s`;
			} else if (relevantLast) {
				$panel("#uooc-task-description").textContent = `${last.filled}/${last.total} 已填${last.failedKeys.length ? ` · ${last.failedKeys.length} 未完成` : ""}`;
				$panel("#uooc-task-fill").style.width = `${last.total ? (last.total - last.failedKeys.length) / last.total * 100 : 0}%`;
				$panel("#uooc-task-elapsed").textContent = last.cancelled ? "已停止" : "已完成";
			}
		}
		if (showVideo) {
			const video = state.currentVideo;
			$panel("#uooc-play").innerHTML = video.paused ? `${iconSvg("play")}<span>播放</span>` : `${iconSvg("pause")}<span>暂停</span>`;
			$panel("#uooc-play").setAttribute("aria-label", video.paused ? "播放" : "暂停");
			$panel("#uooc-rate").querySelector("span").textContent = `${video.playbackRate || 1}×`;
			$panel("#uooc-rate").classList.toggle("on", video.playbackRate > 1);
			$panel("#uooc-rate").setAttribute("aria-pressed", String(video.playbackRate > 1));
			$panel("#uooc-mute").innerHTML = `${iconSvg(video.muted ? "muted" : "volume")}<span>${video.muted ? "静音" : "声音"}</span>`;
			$panel("#uooc-mute").classList.toggle("on", video.muted);
			$panel("#uooc-mute").setAttribute("aria-pressed", String(video.muted));
			$panel("#uooc-continuous").classList.toggle("on", state.prefs.continuous);
			$panel("#uooc-continuous").setAttribute("aria-pressed", String(state.prefs.continuous));
			$panel("#uooc-video-rate").textContent = `${video.playbackRate || 1}×`;
			const duration = Number.isFinite(video.duration) ? video.duration : 0;
			$panel("#uooc-video-time").textContent = formatTime(video.currentTime);
			$panel("#uooc-video-duration").textContent = formatTime(duration);
			$panel("#uooc-video-fill").style.width = `${duration ? Math.max(0, Math.min(100, video.currentTime / duration * 100)) : 0}%`;
		}
		renderRecords();
	}
	function formatTime(seconds) {
		const s = Math.floor(Number(seconds) || 0);
		return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
	}
	function clampPanel() {
		const panel = state.panel;
		if (!panel || !Number.isFinite(state.prefs.panelX)) return;
		const x = Math.max(8, Math.min(state.prefs.panelX, Math.max(8, innerWidth - panel.offsetWidth - 8)));
		const y = Math.max(8, Math.min(state.prefs.panelY ?? 76, Math.max(8, innerHeight - panel.offsetHeight - 8)));
		panel.style.left = `${x}px`;
		panel.style.right = "auto";
		panel.style.top = `${y}px`;
		state.prefs.panelX = x;
		state.prefs.panelY = y;
	}
	function installDrag(panel, handle) {
		let drag;
		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const rect = panel.getBoundingClientRect();
			drag = {
				id: e.pointerId,
				offsetX: e.clientX - rect.left,
				offsetY: e.clientY - rect.top
			};
			handle.setPointerCapture?.(e.pointerId);
			panel.classList.add("dragging");
			e.preventDefault();
		});
		handle.addEventListener("pointermove", (e) => {
			if (!drag || drag.id !== e.pointerId) return;
			state.prefs.panelX = Math.round(Math.max(8, Math.min(e.clientX - drag.offsetX, innerWidth - panel.offsetWidth - 8)));
			state.prefs.panelY = Math.round(Math.max(8, Math.min(e.clientY - drag.offsetY, innerHeight - panel.offsetHeight - 8)));
			clampPanel();
		});
		const stop = (e) => {
			if (!drag || drag.id !== e.pointerId) return;
			try {
				if (handle.hasPointerCapture?.(drag.id)) handle.releasePointerCapture(drag.id);
			} catch (_) {}
			drag = null;
			panel.classList.remove("dragging");
			savePrefs();
		};
		handle.addEventListener("pointerup", stop);
		handle.addEventListener("pointercancel", stop);
		addEventListener("resize", clampPanel);
		clampPanel();
	}
	function showSettings() {
		state.uiRoot.querySelector(".overlay")?.remove();
		const config = Storage.get("llm_config", {}) || {};
		const overlay = document.createElement("div");
		overlay.className = "overlay";
		overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="UOOC 设置">
        <h3>设置</h3>
        <label>API Base URL<input id="uc-url" type="text" placeholder="https://api.openai.com/v1"></label>
        <label>API Key<input id="uc-key" type="password" autocomplete="off" placeholder="sk-..."></label>
        <label>模型<input id="uc-model" type="text" placeholder="模型 ID"></label>
        <div class="grid2">
            <label>并发<input id="uc-concurrency" type="number" min="1" max="8"></label>
            <label>每批题数<input id="uc-batch" type="number" min="1" max="10"></label>
            <label>超时（秒）<input id="uc-timeout" type="number" min="5" max="180"></label>
            <label>重试<input id="uc-retries" type="number" min="0" max="3"></label>
            <label>temperature<input id="uc-temperature" type="number" min="0" max="2" step="0.1" placeholder="留空使用服务商默认值"></label>
            <p id="uc-test-status" role="status"></p>
        </div>
        <div class="buttons"><button class="btn" id="uc-test">测试连接</button><span class="button-group"><button class="btn" id="uc-cancel">取消</button><button class="btn main" id="uc-save">保存</button></span></div>
    </div>`;
		state.uiRoot.append(overlay);
		const $ = (id) => overlay.querySelector(`#${id}`);
		$("uc-url").value = config.baseUrl || "";
		$("uc-key").value = config.apiKey || "";
		$("uc-model").value = config.model || "";
		$("uc-temperature").value = config.temperature ?? "";
		$("uc-concurrency").value = state.prefs.concurrency;
		$("uc-batch").value = state.prefs.batchSize;
		$("uc-timeout").value = Math.round(state.prefs.timeout / 1e3);
		$("uc-retries").value = state.prefs.retries;
		const testTask = {
			activeRequests: /* @__PURE__ */ new Set(),
			cancelled: false
		};
		const close = () => {
			testTask.cancelled = true;
			for (const cancel of [...testTask.activeRequests]) cancel();
		};
		const watchClose = new MutationObserver(() => {
			if (!overlay.isConnected) {
				close();
				watchClose.disconnect();
			}
		});
		watchClose.observe(state.uiRoot, { childList: true });
		$("uc-test").addEventListener("click", async () => {
			const status = $("uc-test-status");
			$("uc-test").disabled = true;
			try {
				const config = validateConfig({
					baseUrl: $("uc-url").value.trim(),
					apiKey: $("uc-key").value.trim(),
					model: $("uc-model").value.trim(),
					temperature: $("uc-temperature").value
				});
				status.textContent = "连接中…";
				await gmRequest(`${config.baseUrl}/chat/completions`, config, [], Math.min(state.prefs.timeout, 15e3), /* @__PURE__ */ new Map(), /* @__PURE__ */ new Map(), {
					task: testTask,
					test: true
				});
				status.textContent = "连接成功，模型已响应";
			} catch (err) {
				status.textContent = `连接失败：${redact(err.message, $("uc-key").value.trim())}`;
			} finally {
				$("uc-test").disabled = false;
			}
		});
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) overlay.remove();
		});
		$("uc-cancel").addEventListener("click", () => overlay.remove());
		$("uc-save").addEventListener("click", () => {
			const baseUrl = $("uc-url").value.trim().replace(/\/+$/, "");
			const apiKey = $("uc-key").value.trim();
			const model = $("uc-model").value.trim();
			try {
				Storage.set("llm_config", validateConfig({
					baseUrl,
					apiKey,
					model,
					temperature: $("uc-temperature").value
				}));
			} catch (err) {
				toast(err.message);
				return;
			}
			const clamp = (id, min, max) => Math.min(max, Math.max(min, Math.floor(Number($(id).value)) || min));
			state.prefs.concurrency = clamp("uc-concurrency", 1, 8);
			state.prefs.batchSize = clamp("uc-batch", 1, 10);
			state.prefs.timeout = clamp("uc-timeout", 5, 180) * 1e3;
			state.prefs.retries = clamp("uc-retries", 0, 3);
			savePrefs();
			overlay.remove();
			toast("已保存");
			log("配置已更新", {
				concurrency: state.prefs.concurrency,
				batchSize: state.prefs.batchSize,
				timeout: state.prefs.timeout,
				retries: state.prefs.retries
			});
		});
	}

//#endregion
//#region src/lifecycle.js
	function scanAll() {
		state.scanTimer = null;
		if (!document.body) return;
		if (!state.panel?.isConnected) ensureUI();
		if (state.task && state.task.route !== `${location.pathname}${location.hash}`) cancelTask("已切换试卷");
		scanVideo();
		updateQuizContext();
		checkInlineQuiz();
		for (const observer of [...state.observers]) if (observer.doc !== document && !observer.doc.defaultView?.frameElement?.isConnected) {
			observer.instance.disconnect();
			state.observedDocs.delete(observer.doc);
			state.observers.splice(state.observers.indexOf(observer), 1);
		}
		for (const doc of quizDocs()) attachObserver(doc);
	}
	function scheduleScan() {
		if (state.scanTimer) return;
		state.scanTimer = setTimeout(scanAll, 180);
	}
	function attachObserver(doc) {
		if (state.observedDocs.has(doc) || !doc.documentElement) return;
		state.observedDocs.add(doc);
		const observer = new MutationObserver((records) => {
			if (records.every((r) => {
				return (r.target instanceof Element ? r.target : r.target?.parentElement)?.closest?.("#uooc-assistant-host");
			})) return;
			scheduleScan();
		});
		observer.observe(doc.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"class",
				"src",
				"disabled",
				"ng-if"
			]
		});
		state.observers.push({
			doc,
			instance: observer
		});
		for (const iframe of doc.querySelectorAll("iframe")) iframe.addEventListener("load", scheduleScan, { once: true });
	}
	function init() {
		if (state.started || !document.body) return;
		state.started = true;
		ensureUI();
		bindKeyboard();
		const markPlayerGesture = (target) => {
			const video = state.currentVideo;
			if (!video?.isConnected) return;
			const player = video.closest(".video-js, [uooc-video], .vjs-tech");
			if (target === video || player?.contains(target)) state.lastPlayerGesture = performance.now();
		};
		const interruptNavigation = (event) => {
			const player = state.currentVideo?.closest(".video-js, [uooc-video], .vjs-tech");
			if (event.isTrusted && navigation.busy && !event.composedPath().includes(state.host) && event.target !== state.currentVideo && !player?.contains(event.target)) navigation.cancel();
		};
		document.addEventListener("pointerdown", (e) => {
			interruptNavigation(e);
			markPlayerGesture(e.target);
		}, true);
		document.addEventListener("keydown", (e) => {
			interruptNavigation(e);
			if ([
				" ",
				"Enter",
				"k",
				"K"
			].includes(e.key)) markPlayerGesture(e.target);
		}, true);
		attachObserver(document);
		scanAll();
		checkTestIgnorable();
		setInterval(scheduleScan, 3e3);
		const routeChanged = () => {
			navigation.routeChanged(location.hash);
			resetRecovery();
			clearTimeout(state.rateRestoreTimer);
			state.rateRestoreTimer = null;
			if (state.task && state.task.route !== `${location.pathname}${location.hash}`) cancelTask("已切换试卷");
			scheduleScan();
			checkTestIgnorable();
		};
		addEventListener("hashchange", routeChanged);
		addEventListener("popstate", routeChanged);
		addEventListener("pagehide", () => {
			cancelTask("离开页面");
			navigation.cancel();
			resetRecovery();
		});
		log(`UOOC Assistant v0.1.0-dev 已启动`);
	}
	function start() {
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
		else init();
	}

//#endregion
//#region src/main.js
	if (window === window.top && !globalThis.__uoocStudyPluginStarted) {
		globalThis.__uoocStudyPluginStarted = true;
		start();
	}

//#endregion
})();