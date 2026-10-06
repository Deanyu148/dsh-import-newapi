/**
 * dsh-import-newapi 离线自测。
 *
 * 浏览器半边是一个 `window.__ModuleLoader__.load(...)` bundle，要验证它必须
 * 提供一个最小的 React 运行时与一个假的客户端 cordis 上下文。本脚本正是这么
 * 做的：它加载真实 bundle、渲染真实设置页、模拟用户输入，最后断言提交给宿主
 * 的 `settings.mutate` / `credentials.set` 载荷。真正的写盘不在本脚本范围内。
 *
 * 用法：node test/run.mjs（在包根目录执行；默认只依赖 Node 本身，若当前
 * DSH profile 里装了 `yaml`，还会用它复现凭据提供者的真实写入写法）
 *
 * @module dsh-import-newapi/test/run
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const clientFile = path.join(pluginDir, "lib", "client.js");
const hostFile = path.join(pluginDir, "lib", "index.js");

let passed = 0;
/** 跑一个测试用例。 */
async function test(title, body) {
	await body();
	passed += 1;
	process.stdout.write(`  ✓ ${title}\n`);
}

/* ------------------------------------------------------------------ */
/* 迷你 React：够跑一个带 hooks 的函数组件即可                          */
/* ------------------------------------------------------------------ */

function createMiniReact() {
	/** 按 hook 序号持久化的槽位。 */
	let store = [];
	/** 当前渲染消费到的 hook 序号。 */
	let cursor = 0;
	/** 本轮待执行的 effect。 */
	let effects = [];
	/** 有状态更新时置位。 */
	let dirty = false;
	/** effect 序号 → 清理函数。 */
	const cleanups = new Map();

	const sameDeps = (left, right) =>
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((value, at) => Object.is(value, right[at]));

	function createElement(type, props, ...children) {
		const flat = children.flat(Infinity);
		const element = { type, props: props === null || props === undefined ? {} : props, kids: flat };
		if (flat.length > 0) element.props = { ...element.props, children: flat.length === 1 ? flat[0] : flat };
		return element;
	}

	function useState(initial) {
		const slot = cursor++;
		if (!(slot in store)) {
			store[slot] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
		}
		const cell = store[slot];
		return [
			cell.value,
			(next) => {
				const value = typeof next === "function" ? next(cell.value) : next;
				if (Object.is(value, cell.value)) return;
				cell.value = value;
				dirty = true;
			},
		];
	}

	function useMemo(factory, deps) {
		const slot = cursor++;
		const cell = store[slot];
		if (cell === undefined || cell.kind !== "memo" || !sameDeps(cell.deps, deps)) {
			store[slot] = { kind: "memo", deps, value: factory() };
		}
		return store[slot].value;
	}

	function useRef(initial) {
		const slot = cursor++;
		const cell = store[slot];
		if (cell === undefined || cell.kind !== "ref") store[slot] = { kind: "ref", current: initial };
		return store[slot];
	}

	function useCallback(fn, deps) {
		return useMemo(() => fn, deps);
	}

	function useEffect(fn, deps) {
		const slot = cursor++;
		const cell = store[slot];
		if (cell === undefined || cell.kind !== "effect" || !sameDeps(cell.deps, deps)) {
			store[slot] = { kind: "effect", deps };
			effects.push({ slot, fn });
		}
	}

	/** 让已 resolve 的 promise 链跑完。 */
	async function settle() {
		for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	}

	/** 渲染到稳定（不再有新的状态更新）。 */
	async function render(Component, props) {
		for (let round = 0; round < 60; round += 1) {
			cursor = 0;
			effects = [];
			dirty = false;
			const tree = Component(props);
			for (const effect of effects) {
				const previous = cleanups.get(effect.slot);
				if (previous !== undefined) {
					cleanups.delete(effect.slot);
					previous();
				}
				const result = effect.fn();
				if (typeof result === "function") cleanups.set(effect.slot, result);
			}
			await settle();
			if (!dirty) return tree;
		}
		throw new Error("组件 60 轮内没有稳定下来");
	}

	return {
		module: { createElement, Fragment: Symbol("Fragment"), useState, useEffect, useMemo, useRef, useCallback },
		render,
	};
}

/* ------------------------------------------------------------------ */
/* 元素树工具                                                          */
/* ------------------------------------------------------------------ */

function* walk(node) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) yield* walk(child);
		return;
	}
	if (typeof node !== "object") {
		yield node;
		return;
	}
	yield node;
	for (const child of node.kids ?? []) yield* walk(child);
}

function textOf(node) {
	return [...walk(node)]
		.filter((value) => typeof value !== "object")
		.map((value) => String(value))
		.join("");
}

function findAll(tree, predicate) {
	return [...walk(tree)].filter((node) => typeof node === "object" && node !== null && predicate(node));
}

/** 断言页面文本里有这段文字。 */
function includes(tree, needle) {
	const text = textOf(tree);
	assert.ok(text.includes(needle), `页面文本里没有「${needle}」\n实际文本：${text}`);
}

/** 按 `{name}` 占位符填一段文案。 */
function fill(template, params) {
	return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function findButton(tree, label) {
	const button = findAll(tree, (node) => node.type === "button" && textOf(node) === label)[0];
	assert.ok(button !== undefined, `找不到按钮「${label}」`);
	return button;
}

function findInput(tree, placeholder) {
	const input = findAll(tree, (node) => node.props.placeholder === placeholder)[0];
	assert.ok(input !== undefined, `找不到占位符为「${placeholder}」的输入框`);
	return input;
}

function modelLabel(tree, id) {
	const label = findAll(
		tree,
		(node) =>
			node.props.className === "dsh-import-newapi-item" &&
			textOf(findAll(node, (child) => child.props.className === "dsh-import-newapi-itemId")[0]) === id,
	)[0];
	assert.ok(label !== undefined, `模型列表里找不到「${id}」`);
	return label;
}

function modelCheckbox(tree, id) {
	const checkbox = findAll(modelLabel(tree, id), (node) => node.type === "input" && node.props.type === "checkbox")[0];
	assert.ok(checkbox !== undefined, `「${id}」没有多选框`);
	return checkbox;
}

function visibleModelIds(tree) {
	return findAll(tree, (node) => node.props.className === "dsh-import-newapi-itemId").map((node) => textOf(node));
}

function capacityRow(tree, id) {
	const row = findAll(tree, (node) => node.props.className === "dsh-import-newapi-capRow").find((candidate) =>
		textOf(findAll(candidate, (child) => child.props.className === "dsh-import-newapi-capId")[0]).startsWith(id),
	);
	assert.ok(row !== undefined, `名称/容量表格里找不到「${id}」`);
	return row;
}

/** 一个模型那一行的三格输入：名称、上下文窗口、最大输出。 */
function rowFields(tree, id) {
	const inputs = findAll(capacityRow(tree, id), (node) => node.type === "input");
	assert.equal(inputs.length, 3, `「${id}」应该正好三格输入（名称 / 上下文窗口 / 最大输出）`);
	return { name: inputs[0], contextWindow: inputs[1], maxTokens: inputs[2] };
}

/** 第 5 步里某个模型的能力卡片。 */
function capabilityCard(tree, id) {
	const card = findAll(tree, (node) => node.props.className === "dsh-import-newapi-capability").find(
		(candidate) => findAll(candidate, (child) => child.type === "code" && textOf(child) === id).length > 0,
	);
	assert.ok(card !== undefined, `第 5 步里找不到模型「${id}」`);
	return card;
}

/** 卡片里某个输入模态的多选框。 */
function modalityCheckbox(tree, id, label) {
	const found = findAll(capabilityCard(tree, id), (node) => node.props.className === "dsh-import-newapi-modality").find(
		(node) => textOf(node) === label,
	);
	assert.ok(found !== undefined, `「${id}」没有「${label}」这个输入模态`);
	return findAll(found, (node) => node.type === "input" && node.props.type === "checkbox")[0];
}

/** 卡片里某个思考档位那一行的三个控件：勾选、配置键、发送值。 */
function effortRow(tree, id, preset) {
	const row = findAll(
		capabilityCard(tree, id),
		(node) =>
			typeof node.props.className === "string" &&
			node.props.className.split(" ").includes(`dsh-import-newapi-effortRow-${preset}`),
	)[0];
	assert.ok(row !== undefined, `「${id}」没有 ${preset} 档位行`);
	const inputs = findAll(row, (node) => node.type === "input");
	assert.equal(inputs.length, 3, `「${id}」的 ${preset} 档位应该正好三个控件（勾选 / 键 / 值）`);
	return { toggle: inputs[0], key: inputs[1], value: inputs[2] };
}

function change(input, value) {
	assert.equal(typeof input.props.onChange, "function", "输入框没有 onChange");
	input.props.onChange({ target: { value } });
}

function click(button) {
	assert.equal(typeof button.props.onClick, "function", "按钮没有 onClick");
	button.props.onClick();
}

function toggleCheckbox(checkbox) {
	assert.equal(typeof checkbox.props.onChange, "function", "多选框没有 onChange");
	checkbox.props.onChange();
}

/* ------------------------------------------------------------------ */
/* 加载真实 bundle                                                     */
/* ------------------------------------------------------------------ */

function loadClient() {
	const source = readFileSync(clientFile, "utf8");
	let definition;
	const win = {
		__ModuleLoader__: {
			load(candidate) {
				definition = candidate;
			},
		},
	};
	new Function("window", source)(win);
	assert.ok(definition !== undefined, "bundle 没有调用 window.__ModuleLoader__.load");
	assert.equal(definition.id, "dsh-import-newapi");

	const mini = createMiniReact();
	const exports = definition.factory((specifier) => {
		assert.equal(specifier, "react", `bundle 只应该 require("react")，实际是 ${specifier}`);
		return mini.module;
	});
	return { exports, mini };
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

async function main() {
	process.stdout.write("dsh-import-newapi 自测\n");

	const { exports, mini: react } = loadClient();
	const internals = exports.__internals;
	const zh = internals.dictionaries.zh;
	const en = internals.dictionaries.en;

	/** 按中文文案做翻译函数，键缺失就直接失败。 */
	const t = (key, params) => {
		const template = zh[key];
		assert.ok(template !== undefined, `设置页要求了不存在的文案键：${key}`);
		return params === undefined ? String(template) : fill(template, params);
	};

	/* ---------------- 模块表面 ---------------- */
	await test("bundle 导出插件入口与内部引用", () => {
		assert.equal(exports.name, "dsh-import-newapi");
		assert.deepEqual(exports.inject, ["slots", "locale", "remote", "remote.settings", "remote.credentials", "remote.llm"]);
		assert.equal(typeof exports.apply, "function");
		assert.equal(typeof internals.createSettingsPage, "function");
	});

	await test("中英文文案键完全一致且非空", () => {
		assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
		for (const [key, value] of Object.entries(zh)) assert.ok(String(value).length > 0, `${key} 是空的`);
	});

	/* ---------------- baseURL 推导 ---------------- */
	await test("openai 协议补 /v1，anthropic 协议去 /v1", () => {
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test", "openai-completions"), "https://api.example-provider.test/v1");
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test/", "openai-responses"), "https://api.example-provider.test/v1");
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test/v1", "openai-completions"), "https://api.example-provider.test/v1");
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test/v1/", "openai-responses"), "https://api.example-provider.test/v1");
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test", "anthropic-messages"), "https://api.example-provider.test");
		assert.equal(internals.deriveBaseURL("https://api.example-provider.test/v1", "anthropic-messages"), "https://api.example-provider.test");
		assert.equal(internals.deriveBaseURL("  https://api.example-provider.test/v1  ", "anthropic-messages"), "https://api.example-provider.test");
		assert.equal(internals.deriveBaseURL("", "openai-completions"), "");
	});

	/* ---------------- 密钥引用名 ---------------- */
	await test("供应商 id → 密钥引用名", () => {
		assert.equal(internals.keyRefOf("example-api"), "EXAMPLE_API_API_KEY");
		assert.equal(internals.keyRefOf("example-api-2"), "EXAMPLE_API_2_API_KEY");
		assert.equal(internals.keyRefOf("a"), "A_API_KEY");
		assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(internals.keyRefOf("x1-y2")));
	});

	/* ---------------- 连接信息解析 ---------------- */
	await test("解析 New API 连接信息", () => {
		const key = "sk-test-0000000000000000000000000000000000000000";
		const connection = { _type: "newapi_channel_conn", key, url: "https://api.example-provider.test" };
		assert.deepEqual(internals.parseConnection(JSON.stringify(connection)), {
			kind: "ok",
			url: "https://api.example-provider.test",
			key,
		});
		assert.equal(internals.parseConnection(`  ${JSON.stringify(connection)}  `).kind, "ok");
		assert.deepEqual(internals.parseConnection(""), { kind: "empty" });
		assert.deepEqual(internals.parseConnection("   "), { kind: "empty" });
		assert.deepEqual(internals.parseConnection("not json"), { kind: "invalid", reason: "connectionNotJson" });
		assert.deepEqual(internals.parseConnection("[1,2]"), { kind: "invalid", reason: "connectionNotObject" });
		assert.deepEqual(internals.parseConnection('{"_type":"other","url":"u","key":"k"}'), {
			kind: "invalid",
			reason: "connectionWrongType",
		});
		assert.deepEqual(internals.parseConnection('{"url":"","key":"k"}'), { kind: "invalid", reason: "connectionNoUrl" });
		assert.deepEqual(internals.parseConnection('{"url":"u"}'), { kind: "invalid", reason: "connectionNoKey" });
		assert.equal(internals.parseConnection('{"_type":"newapi_channel_conn","url":"u","key":"k"}').kind, "ok");
	});

	await test("由站点地址猜供应商 id", () => {
		assert.equal(internals.suggestProviderId("https://api.example-provider.test"), "example-provider-test");
		assert.equal(internals.suggestProviderId("https://www.example.com/"), "example-com");
		assert.equal(internals.suggestProviderId("https://9.example.com"), "");
		assert.equal(internals.suggestProviderId(""), "");
		assert.ok(internals.PROVIDER_ID_PATTERN.test(internals.suggestProviderId("https://api.example-provider.test")));
	});

	await test("供应商 id 规则", () => {
		for (const good of ["a", "example-api", "example-api-2", "a1-b2"]) assert.ok(internals.PROVIDER_ID_PATTERN.test(good), good);
		for (const bad of ["", "1a", "Example", "example_api", "example.api", "-example", "example-", "example--api"]) {
			assert.ok(!internals.PROVIDER_ID_PATTERN.test(bad), bad);
		}
	});

	/* ---------------- 容量 ---------------- */
	await test("容量输入解析与回显", () => {
		assert.equal(internals.parseCapacity("1000000"), 1000000);
		assert.equal(internals.parseCapacity("1M"), 1000000);
		assert.equal(internals.parseCapacity("1m"), 1000000);
		assert.equal(internals.parseCapacity("384K"), 384000);
		assert.equal(internals.parseCapacity("272K"), 272000);
		assert.equal(internals.parseCapacity("1.05M"), 1050000);
		assert.equal(internals.parseCapacity("1.05m"), 1050000);
		assert.equal(internals.parseCapacity("272k"), 272000);
		assert.equal(internals.parseCapacity("1,000"), NaN);
		assert.equal(internals.parseCapacity(" 64 k "), 64000);
		assert.equal(internals.parseCapacity("1.5M"), 1500000);
		assert.equal(internals.parseCapacity(""), undefined);
		assert.equal(internals.parseCapacity(undefined), undefined);
		assert.ok(Number.isNaN(internals.parseCapacity("abc")));
		assert.ok(Number.isNaN(internals.parseCapacity("1G")));
		assert.equal(internals.formatCapacity(1000000), "1M");
		assert.equal(internals.formatCapacity(384000), "384K");
		assert.equal(internals.formatCapacity(1050000), "1050K");
		assert.equal(internals.formatCapacity(1000001), "1000001");
		assert.equal(internals.formatCapacity(0), "");
		assert.equal(internals.formatCapacity(undefined), "");
	});

	await test("容量校验只针对勾选的模型", () => {
		assert.equal(internals.firstCapacityFailure([], { "a:contextWindow": "xyz" }), undefined);
		assert.equal(internals.firstCapacityFailure(["a"], {}), undefined);
		assert.equal(internals.firstCapacityFailure(["a"], { "a:contextWindow": "1M" }), undefined);
		assert.deepEqual(internals.firstCapacityFailure(["a"], { "a:maxTokens": "?" }), { id: "a", field: "maxTokens" });
		assert.deepEqual(internals.firstCapacityFailure(["a", "b"], { "b:contextWindow": "-1" }), {
			id: "b",
			field: "contextWindow",
		});
	});

	/* ---------------- 写盘对象 ---------------- */
	const discovered = [
		{ id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", contextWindow: 1000000, maxTokens: 384000 },
		{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1000000, maxTokens: 64000, inputModalities: ["text", "image"] },
		{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", contextWindow: 1050000, maxTokens: 128000, inputModalities: ["text", "image"] },
	];

	await test("模型条目只写有信息的键", () => {
		assert.deepEqual(internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}), [
			{ id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash" },
		]);
		assert.deepEqual(internals.buildModelEntries(["gemini-3.8-flash"], discovered, { "gemini-3.8-flash:contextWindow": "1M" }), [
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1000000, input: ["text", "image"] },
		]);
		/* name 与 id 相同不写；留空不写。 */
		assert.deepEqual(internals.buildModelEntries(["gpt-5.6-sol"], discovered, { "gpt-5.6-sol:maxTokens": "128K" }), [
			{ id: "gpt-5.6-sol", maxTokens: 128000, input: ["text", "image"] },
		]);
		/* 目录里没有的 id 也照样写进去。 */
		assert.deepEqual(internals.buildModelEntries(["hand-written"], [], {}), [{ id: "hand-written" }]);
		/* 用户改过的名称优先；清空或只留空白就不写 name。 */
		assert.deepEqual(internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}, { "deepseek-v4.1-flash": "DS 4.1" }), [
			{ id: "deepseek-v4.1-flash", name: "DS 4.1" },
		]);
		assert.deepEqual(internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}, { "deepseek-v4.1-flash": "   " }), [
			{ id: "deepseek-v4.1-flash" },
		]);
		assert.deepEqual(internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}, { "deepseek-v4.1-flash": "" }), [
			{ id: "deepseek-v4.1-flash" },
		]);
		/* 手写的名称会给目录里没有的 id 补上显示名。 */
		assert.deepEqual(internals.buildModelEntries(["hand-written"], [], {}, { "hand-written": "手写模型" }), [
			{ id: "hand-written", name: "手写模型" },
		]);
		/* 名称与 id 相同就不写。 */
		assert.deepEqual(internals.buildModelEntries(["m1"], [{ id: "m1" }], {}, { m1: "m1" }), [{ id: "m1" }]);
	});

	/* ---------------- 输入模态 ---------------- */
	await test("输入模态只在偏离默认值时写 input", () => {
		assert.deepEqual(internals.MODALITIES, ["text", "image"]);
		assert.deepEqual(internals.DEFAULT_INPUT, ["text"]);
		/* 只勾文本 = 适配器默认值，不写这个键。 */
		assert.equal(internals.buildInput(["text"]), undefined);
		assert.equal(internals.buildInput([]), undefined);
		assert.equal(internals.buildInput(undefined), undefined);
		/* 勾了图像就按适配器的顺序写出来。 */
		assert.deepEqual(internals.buildInput(["text", "image"]), ["text", "image"]);
		assert.deepEqual(internals.buildInput(["image", "text"]), ["text", "image"]);
		assert.deepEqual(internals.buildInput(["image"]), ["image"]);
		/* 默认值：文本一定有，目录报告支持图像时再补上图像。 */
		assert.deepEqual(internals.defaultInputsFor(discovered[1]), ["text", "image"]);
		assert.deepEqual(internals.defaultInputsFor(discovered[0]), ["text"]);
		assert.deepEqual(internals.defaultInputsFor(undefined), ["text"]);
		/* 用户改动优先于目录：取消图像就不写 input。 */
		assert.deepEqual(
			internals.buildModelEntries(["gemini-3.8-flash"], discovered, {}, undefined, { "gemini-3.8-flash": ["text"] }),
			[{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
		);
		assert.deepEqual(
			internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}, undefined, {
				"deepseek-v4.1-flash": ["text", "image"],
			}),
			[{ id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", input: ["text", "image"] }],
		);
	});

	/* ---------------- 思考强度 ---------------- */
	await test("思考档位按适配器的规则组装", () => {
		assert.deepEqual(internals.THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(
			internals.EFFORT_PRESETS.map((preset) => preset.key),
			["off", "low", "medium", "high", "xhigh", "max"],
		);
		const row = (preset, on, key, value) => ({ preset, on, key, value });

		/* 一个档位都没勾：不写这个键。 */
		assert.deepEqual(internals.buildReasoningEfforts([]), { kind: "none" });
		assert.deepEqual(internals.buildReasoningEfforts(undefined), { kind: "none" });
		assert.deepEqual(internals.buildReasoningEfforts([row("low", false, "low", "low")]), { kind: "none" });

		/* off 只有键没有值 → null（适配器读作“支持，但不发送参数”）。 */
		assert.deepEqual(internals.buildReasoningEfforts([row("off", true, "off", ""), row("low", true, "low", "low")]), {
			kind: "ok",
			value: { off: null, low: "low" },
		});
		/* off 给了值就发送那个值。 */
		assert.deepEqual(internals.buildReasoningEfforts([row("off", true, "off", "none"), row("max", true, "max", "max")]), {
			kind: "ok",
			value: { off: "none", max: "max" },
		});
		/* 键的顺序按适配器的档位顺序，与勾选顺序无关。 */
		const ordered = internals.buildReasoningEfforts([row("max", true, "max", "max"), row("low", true, "low", "low"), row("high", true, "high", "high")]);
		assert.deepEqual(ordered, { kind: "ok", value: { low: "low", high: "high", max: "max" } });
		assert.deepEqual(Object.keys(ordered.value), ["low", "high", "max"]);
		/* 自定义键与值：minimal 不在预设里，但适配器认它。 */
		assert.deepEqual(internals.buildReasoningEfforts([row("low", true, "minimal", "  tiny  ")]), {
			kind: "ok",
			value: { minimal: "tiny" },
		});

		/* 只勾 off 是适配器明令拒绝的。 */
		assert.deepEqual(internals.buildReasoningEfforts([row("off", true, "off", "")]), {
			kind: "invalid",
			preset: "off",
			detail: "onlyOff",
		});
		assert.deepEqual(internals.buildReasoningEfforts([row("off", true, "off", "none")]), {
			kind: "invalid",
			preset: "off",
			detail: "onlyOff",
		});
		/* 键名空、键名不认识、键名重复、非 off 没给值。 */
		assert.deepEqual(internals.buildReasoningEfforts([row("low", true, "   ", "low")]), {
			kind: "invalid",
			preset: "low",
			detail: "emptyKey",
		});
		assert.deepEqual(internals.buildReasoningEfforts([row("low", true, "lowest", "low")]), {
			kind: "invalid",
			preset: "low",
			detail: "unknownKey",
			key: "lowest",
		});
		assert.deepEqual(internals.buildReasoningEfforts([row("low", true, "low", "low"), row("medium", true, "low", "low")]), {
			kind: "invalid",
			preset: "medium",
			detail: "duplicateKey",
			key: "low",
		});
		assert.deepEqual(internals.buildReasoningEfforts([row("xhigh", true, "xhigh", "   ")]), {
			kind: "invalid",
			preset: "xhigh",
			detail: "emptyValue",
			key: "xhigh",
		});
	});

	await test("档位校验只针对勾选的模型", () => {
		const bad = [{ preset: "off", on: true, key: "off", value: "" }];
		assert.equal(internals.firstReasoningFailure([], { a: bad }), undefined);
		assert.equal(internals.firstReasoningFailure(["a"], {}), undefined);
		assert.deepEqual(internals.firstReasoningFailure(["a", "b"], { a: [], b: bad }), {
			id: "b",
			kind: "invalid",
			preset: "off",
			detail: "onlyOff",
		});
	});

	await test("模型条目里的 input 与 reasoningEfforts", () => {
		const entries = internals.buildModelEntries(["gemini-3.8-flash"], discovered, {}, undefined, undefined, {
			"gemini-3.8-flash": [
				{ preset: "off", on: true, key: "off", value: "" },
				{ preset: "low", on: true, key: "low", value: "low" },
				{ preset: "max", on: true, key: "max", value: "max" },
			],
		});
		assert.deepEqual(entries, [
			{
				id: "gemini-3.8-flash",
				name: "Gemini 3.8 Flash",
				input: ["text", "image"],
				reasoningEfforts: { off: null, low: "low", max: "max" },
			},
		]);
		/* 键的书写顺序照模板：id、name、容量、input、reasoningEfforts。 */
		assert.deepEqual(Object.keys(entries[0]), ["id", "name", "input", "reasoningEfforts"]);
		assert.deepEqual(Object.keys(entries[0].reasoningEfforts), ["off", "low", "max"]);
		/* 别人都不受影响。 */
		assert.deepEqual(internals.buildModelEntries(["deepseek-v4.1-flash"], discovered, {}, undefined, undefined, {
			"deepseek-v4.1-flash": [{ preset: "low", on: false, key: "low", value: "low" }],
		}), [{ id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash" }]);
	});

	await test("供应商对象的键与顺序固定", () => {
		const profile = internals.buildProfile({
			providerId: "example-api-2",
			displayName: "Example API 2",
			api: "openai-responses",
			baseURL: "https://api.example-provider.test/v1",
			ids: ["deepseek-v4.1-flash"],
			discovered,
			capacities: {},
		});
		assert.deepEqual(Object.keys(profile), ["displayName", "apiKeyEnv", "api", "baseURL", "models"]);
		assert.deepEqual(profile, {
			displayName: "Example API 2",
			apiKeyEnv: "EXAMPLE_API_2_API_KEY",
			api: "openai-responses",
			baseURL: "https://api.example-provider.test/v1",
			models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash" }],
		});
		/* 名称覆盖也走同一条路。 */
		const renamed = internals.buildProfile({
			providerId: "example-api-2",
			displayName: "Example API 2",
			api: "openai-responses",
			baseURL: "https://api.example-provider.test/v1",
			ids: ["gpt-5.6-sol"],
			discovered,
			capacities: { "gpt-5.6-sol:contextWindow": "1.05M", "gpt-5.6-sol:maxTokens": "128K" },
			names: { "gpt-5.6-sol": "Sol" },
		});
		assert.deepEqual(renamed.models, [{ id: "gpt-5.6-sol", name: "Sol", contextWindow: 1050000, maxTokens: 128000, input: ["text", "image"] }]);
		const nameless = internals.buildProfile({
			providerId: "example",
			displayName: "",
			api: "anthropic-messages",
			baseURL: "https://api.example-provider.test",
			ids: [],
			discovered: [],
			capacities: {},
		});
		assert.deepEqual(Object.keys(nameless), ["apiKeyEnv", "api", "baseURL", "models"]);
		/* input 与 reasoningEfforts 也一路传到 models 里。 */
		const capable = internals.buildProfile({
			providerId: "example-api-2",
			displayName: "",
			api: "openai-responses",
			baseURL: "https://api.example-provider.test/v1",
			ids: ["deepseek-v4.1-flash"],
			discovered,
			capacities: {},
			inputs: { "deepseek-v4.1-flash": ["text", "image"] },
			efforts: { "deepseek-v4.1-flash": [{ preset: "medium", on: true, key: "medium", value: "medium" }] },
		});
		assert.deepEqual(Object.keys(capable), ["apiKeyEnv", "api", "baseURL", "models"]);
		assert.deepEqual(capable.models, [
			{
				id: "deepseek-v4.1-flash",
				name: "DeepSeek v4.1 Flash",
				input: ["text", "image"],
				reasoningEfforts: { medium: "medium" },
			},
		]);
	});

	/* ---------------- 宿主半边 ---------------- */
	const scratch = mkdtempSync(path.join(tmpdir(), "dsh-import-newapi-"));
	/** 在临时 DSH_HOME 下跑一段代码，别碰真实的凭据文档。 */
	const withHome = (home, body) => {
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			return body();
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previous;
		}
	};
	/** 一份凭据文档：records 段随便写一条，用来确认别的行一个字节都没动。 */
	const credentialsFixture = (refsLine) =>
		["version: 1", "records:", "  client-connection/browser-session:", "    kind: grant", refsLine, ""].join(
			"\n",
		);
	/** 在临时目录里写一份文件。 */
	const writeScratch = (name, text) => {
		const file = path.join(scratch, name);
		writeFileSync(file, text, { mode: 0o600 });
		return file;
	};
	/** profile 里那份真实的 yaml 实现，用来复现凭据提供者的写法。 */
	const profilePackage = path.join(
		process.env.DSH_PROFILE_DIR ?? path.join(process.env.DSH_HOME ?? "", "profiles", "desktop"),
		"package.json",
	);
	const loadProfileYaml = () => {
		try {
			return createRequire(profilePackage)("yaml");
		} catch {
			return undefined;
		}
	};

	await test("宿主半边声明与自检", async () => {
		const host = await import(pathToFileURL(hostFile).href);
		assert.equal(host.name, "dsh-import-newapi");
		assert.deepEqual(host.inject, ["configEditor"]);
		const warnings = [];
		const effects = [];
		const logger = { warn: (...args) => warnings.push(args), info: () => {} };
		const context = (entries) => ({
			configEditor: { entries },
			logger,
			// 假装凭据服务报的就是 scratch 里的文件，免得自测去动真机器的家目录。
			get: (service) =>
				service === "credentials" ? { spec: { filename: path.join(scratch, ".credentials.yaml") } } : undefined,
			effect: (callback, label) => {
				effects.push({ label, dispose: callback() });
			},
		});
		withHome(scratch, () => {
			host.apply(context(() => [{ options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" } }]));
			assert.deepEqual(warnings, []);
			host.apply(context(() => []));
			assert.equal(warnings.length, 1);
			assert.ok(String(warnings[0][0]).includes("没有 %s 条目"));
			assert.equal(warnings[0][1], "@deepseek-ai/dsh-llm-pi-ai");
			host.apply(
				context(() => {
					throw new Error("boom");
				}),
			);
			assert.equal(warnings.length, 2);
			assert.ok(String(warnings[1][0]).includes("挂载自检失败"));
		});
		assert.equal(effects.length, 3);
		assert.ok(String(effects[0].label).includes("refs"));
		effects.forEach((entry) => entry.dispose());
	});

	await test("空 refs: {} 会被改写成块状 refs 段", async () => {
		const host = await import(pathToFileURL(hostFile).href);
		const { normalizeEmptyRefs } = host.__internals;
		const file = writeScratch("empty.yaml", credentialsFixture("refs: {}"));
		assert.equal(normalizeEmptyRefs(file), true);
		const text = readFileSync(file, "utf8");
		assert.equal(
			text,
			"version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n",
		);
		assert.equal(text.includes("refs"), false);
		const mode = statSync(file).mode & 0o777;
		// 幂等：没有空的 refs 了就不再动这个文件。
		assert.equal(normalizeEmptyRefs(file), false);
		assert.equal(readFileSync(file, "utf8"), text);
		if (process.platform !== "win32" && mode !== 0) assert.equal(statSync(file).mode & 0o777, mode);
		const yaml = loadProfileYaml();
		if (yaml === undefined) {
			process.stdout.write("    · profile 里没有 yaml，跳过提供者写法断言\n");
			return;
		}
		// 提供者的写入路径：在文档上 setIn 一个引用再渲染回去。
		const document = yaml.parseDocument(text);
		document.setIn(["version"], 1);
		document.setIn(["refs", "EXAMPLE_API_API_KEY"], "sk-1");
		assert.ok(String(document).endsWith("refs:\n  EXAMPLE_API_API_KEY: sk-1\n"), String(document));
		// 对照：不归一化时，同样的写入只能挤成一行流式映射。
		const raw = writeScratch("flow.yaml", credentialsFixture("refs: {}"));
		const flow = yaml.parseDocument(readFileSync(raw, "utf8"));
		flow.setIn(["refs", "EXAMPLE_API_API_KEY"], "sk-1");
		assert.ok(String(flow).includes("refs: { EXAMPLE_API_API_KEY: sk-1 }"), String(flow));
	});

	await test("归一化只认凭据文档里的空 refs", async () => {
		const host = await import(pathToFileURL(hostFile).href);
		const { normalizeEmptyRefs } = host.__internals;
		assert.equal(normalizeEmptyRefs(path.join(scratch, "missing.yaml")), false);
		const foreign = "hello: world\nrefs: {}\n";
		const foreignFile = writeScratch("foreign.yaml", foreign);
		assert.equal(normalizeEmptyRefs(foreignFile), false);
		assert.equal(readFileSync(foreignFile, "utf8"), foreign);
		const commented = writeScratch("commented.yaml", credentialsFixture("refs: {} # 手工备注"));
		assert.equal(normalizeEmptyRefs(commented), true);
		assert.equal(readFileSync(commented, "utf8").includes("refs"), false);
		const crlf = writeScratch("crlf.yaml", credentialsFixture("refs: {}").replace(/\n/g, "\r\n"));
		assert.equal(normalizeEmptyRefs(crlf), true);
		assert.equal(readFileSync(crlf, "utf8").includes("refs"), false);
		const block = 'version: 1\nrefs:\n  AMAZON_BEDROCK_API_KEY: "11"\n';
		const blockFile = writeScratch("block.yaml", block);
		assert.equal(normalizeEmptyRefs(blockFile), false);
		assert.equal(readFileSync(blockFile, "utf8"), block);
		const sequenceFile = writeScratch("sequence.yaml", "version: 1\nrefs: []\n");
		assert.equal(normalizeEmptyRefs(sequenceFile), false);
	});

	await test("凭据文档的路径优先问凭据服务", async () => {
		const host = await import(pathToFileURL(hostFile).href);
		const { credentialsFileCandidates, liveCredentialsFile, pickCredentialsFile } = host.__internals;
		const servedHome = path.join(scratch, "served");
		mkdirSync(servedHome, { recursive: true });
		const live = path.join(servedHome, ".credentials.yaml");
		const served = { get: (name) => (name === "credentials" ? { spec: { filename: live } } : undefined) };
		assert.equal(liveCredentialsFile(served), live);
		assert.equal(liveCredentialsFile({ get: () => undefined }), undefined);
		assert.equal(liveCredentialsFile({ get: () => ({ spec: {} }) }), undefined);
		assert.equal(liveCredentialsFile({ get: () => ({ spec: { filename: "" } }) }), undefined);
		assert.equal(liveCredentialsFile({ get: () => { throw new Error("boom"); } }), undefined);
		withHome(path.join(scratch, "elsewhere"), () => {
			// 服务报了路径就排在第一位，环境里的 DSH_HOME 只是备选。
			assert.equal(credentialsFileCandidates(served)[0], live);
			assert.equal(
				credentialsFileCandidates(served)[1],
				path.join(scratch, "elsewhere", ".credentials.yaml"),
			);
			// 只有真实存在的文件才算数，不猜。
			assert.notEqual(pickCredentialsFile(served), live);
			writeFileSync(live, credentialsFixture("refs: {}"), { mode: 0o600 });
			assert.equal(pickCredentialsFile(served), live);
			rmSync(live, { force: true });
		});
		// 没有活的凭据服务时退回环境候选。
		const envHome = path.join(scratch, "env-home");
		mkdirSync(envHome, { recursive: true });
		withHome(envHome, () => {
			const file = path.join(envHome, ".credentials.yaml");
			assert.equal(credentialsFileCandidates()[0], file);
			// 文件还没出现就不能猜（此时可能落到别的真实存在的候选上）。
			assert.notEqual(pickCredentialsFile(), file);
			writeFileSync(file, credentialsFixture("refs: {}"), { mode: 0o600 });
			assert.equal(pickCredentialsFile(), file);
		});
		// 连 DSH_HOME 都没有时，从加载基点 <home>/profiles/<profile> 反推 home。
		withHome(envHome, () => {
			const previous = process.env.DSH_HOME;
			delete process.env.DSH_HOME;
			try {
				const derived = path.join(scratch, "harness", ".credentials.yaml");
				const ctx = { baseDir: path.join(scratch, "harness", "profiles", "desktop") };
				assert.equal(credentialsFileCandidates(ctx)[0], derived);
			} finally {
				process.env.DSH_HOME = previous;
			}
		});
		// 哪儿都没有落脚点时就别猜了：返回的要么是真实存在的文件，要么什么都没有。
		// （Windows 上 os.homedir() 走的是 Win32 API，改 HOME/USERPROFILE 拦不住它。）
		withHome(path.join(scratch, "nowhere", "deeper"), () => {
			const file = pickCredentialsFile();
			assert.equal(file === undefined || existsSync(file), true);
			assert.notEqual(file, path.join(scratch, "nowhere", "deeper", ".credentials.yaml"));
			assert.notEqual(file, path.join(scratch, "nowhere", ".credentials.yaml"));
		});
	});

	await test("挂载时归一化，并盯住文件不放", async () => {
		const host = await import(pathToFileURL(hostFile).href);
		const home = path.join(scratch, "mount-home");
		mkdirSync(home, { recursive: true });
		const file = path.join(home, ".credentials.yaml");
		writeFileSync(file, credentialsFixture("refs: {}"), { mode: 0o600 });
		const infos = [];
		const warnings = [];
		const effects = [];
		withHome(home, () => {
			host.apply({
				configEditor: {
					entries: () => [{ options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" } }],
				},
				logger: { info: (...args) => infos.push(args), warn: (...args) => warnings.push(args) },
				effect: (callback, label) => {
					effects.push({ label, dispose: callback() });
				},
			});
		});
		assert.deepEqual(warnings, []);
		assert.equal(readFileSync(file, "utf8").includes("refs"), false);
		assert.ok(infos.some((row) => String(row[0]).includes("块状 `refs:` 段")));
		assert.equal(effects.length, 1);
		// 提供者把最后一个引用删掉之后，空的 `{}` 会被监视器自动抹掉。
		writeFileSync(file, credentialsFixture("refs: {}"), { mode: 0o600 });
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.equal(readFileSync(file, "utf8").includes("refs"), false);
		effects[0].dispose();
	});

	/* ---------------- 设置页渲染与导入流程 ---------------- */
	const key = "sk-test-0000000000000000000000000000000000000000";
	const connectionJSON = JSON.stringify({ _type: "newapi_channel_conn", key, url: "https://api.example-provider.test" });

	/**
	 * 造一个假的客户端上下文。
	 * @param options - `{ providers, revision, conflictOnce, credential }`。
	 */
	function createFakeContext(options = {}) {
		const calls = { mutate: [], describeCredentials: [], set: [], discover: [], describe: 0 };
		let revision = options.revision ?? 3;
		let providers = { ...(options.providers ?? {}) };
		const ctx = {
			remote: {
				settings: {
					async describe() {
						calls.describe += 1;
						return {
							ok: true,
							value: {
								writable: true,
								hasDocument: true,
								namespaces: [{ ns: "llm-pi-ai", revision, applies: "live", schema: {}, secrets: [], value: { providers } }],
							},
						};
					},
					async mutate(ns, ops, expectedRevision) {
						calls.mutate.push({ ns, ops, expectedRevision });
						if (options.conflictOnce === true && calls.mutate.length === 1) {
							revision += 1;
							return { ok: false, error: { code: "settings/conflict", message: "settings namespace changed" } };
						}
						if (expectedRevision !== revision) {
							return { ok: false, error: { code: "settings/conflict", message: "settings namespace changed" } };
						}
						for (const op of ops) if (op.op === "set") providers = { ...providers, [op.path[1]]: op.value };
						revision += 1;
						return { ok: true, value: { providers } };
					},
				},
				credentials: {
					async describe(refs) {
						calls.describeCredentials.push(refs);
						const info = options.credential ?? { configured: false, writable: true };
						return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, info])) };
					},
					async set(ref, value) {
						calls.set.push({ ref, value });
						return { ok: true, value: undefined };
					},
				},
				llm: {
					async listConfigurableProviders() {
						return {
							ok: true,
							value: options.configurable ?? [
								{ provider: "example", displayName: "Example", settingsNs: "llm-pi-ai", settingsPath: ["providers", "example-api"] },
							],
						};
					},
					async discoverModels(ns, request) {
						calls.discover.push({ ns, request });
						return options.discovery ?? { ok: true, value: [...discovered].reverse() };
					},
				},
			},
		};
		return { ctx, calls, providers: () => providers, revision: () => revision };
	}

	await test("设置页完整导入流程", async () => {
		const fake = createFakeContext({ providers: { "example-api": { api: "openai-completions" } } });
		const Page = internals.createSettingsPage(fake.ctx, t);
		let tree = await react.render(Page, {});

		/* 初次渲染：标题、已有供应商、按钮都在，缺字段时不能拉取/导入。 */
		includes(tree, zh.title);
		includes(tree, fill(zh.existingLabel, {}));
		includes(tree, "example-api");
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		assert.equal(findButton(tree, zh.fetchModels).props.disabled, true);
		includes(tree, zh.connectionEmpty);
		assert.deepEqual(fake.calls.describeCredentials, []);

		/* 1. 粘贴连接信息 → 自动填 url 与密钥，并给出候选 id。 */
		change(findAll(tree, (node) => node.type === "textarea")[0], connectionJSON);
		tree = await react.render(Page, {});
		assert.equal(findInput(tree, "https://gateway.example").props.value, "https://api.example-provider.test");
		assert.equal(findInput(tree, zh.keyPlaceholder).props.value, key);
		assert.equal(findInput(tree, zh.providerIdPlaceholder).props.value, "example-provider-test");
		includes(tree, zh.connectionOk);
		assert.equal(findButton(tree, zh.fetchModels).props.disabled, false);

		/* 2. 改成自己的 id 与显示名，选 openai-responses。 */
		change(findInput(tree, zh.providerIdPlaceholder), "example-api-2");
		change(findInput(tree, zh.displayNamePlaceholder), "Example API 2");
		change(findAll(tree, (node) => node.type === "select")[0], "openai-responses");
		tree = await react.render(Page, {});
		const baseURLInput = findAll(tree, (node) => node.type === "input" && node.props.className === "dsh-import-newapi-input")[4];
		assert.equal(baseURLInput.props.value, "https://api.example-provider.test/v1");
		includes(tree, "EXAMPLE_API_2_API_KEY");

		/* 已存在的 id 不许覆盖。 */
		change(findInput(tree, zh.providerIdPlaceholder), "example-api");
		tree = await react.render(Page, {});
		includes(tree, zh.providerIdTaken);
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		change(findInput(tree, zh.providerIdPlaceholder), "example-api-2");
		tree = await react.render(Page, {});

		/* 3. 拉取模型列表。 */
		click(findButton(tree, zh.fetchModels));
		tree = await react.render(Page, {});
		assert.equal(fake.calls.discover.length, 1);
		assert.deepEqual(fake.calls.discover[0], {
			ns: "llm-pi-ai",
			request: { baseURL: "https://api.example-provider.test/v1", api: "openai-responses", apiKey: key },
		});
		assert.deepEqual(visibleModelIds(tree), ["deepseek-v4.1-flash", "gemini-3.8-flash", "gpt-5.6-sol"]);
		includes(tree, fill(zh.modelsFound, { count: 3 }));

		/* 搜索栏过滤；全选只作用于过滤结果。 */
		change(findInput(tree, zh.searchPlaceholder), "gemini");
		tree = await react.render(Page, {});
		assert.deepEqual(visibleModelIds(tree), ["gemini-3.8-flash"]);
		click(findButton(tree, zh.selectAll));
		tree = await react.render(Page, {});
		includes(tree, fill(zh.selectedCount, { count: 1, total: 3 }));
		change(findInput(tree, zh.searchPlaceholder), "");
		tree = await react.render(Page, {});
		assert.equal(modelCheckbox(tree, "gemini-3.8-flash").props.checked, true);
		assert.equal(modelCheckbox(tree, "deepseek-v4.1-flash").props.checked, false);

		/* 反选：只剩 deepseek。 */
		click(findButton(tree, zh.invertSelection));
		tree = await react.render(Page, {});
		assert.equal(modelCheckbox(tree, "gemini-3.8-flash").props.checked, false);
		assert.equal(modelCheckbox(tree, "deepseek-v4.1-flash").props.checked, true);

		/* 全不选，再手动勾两个。 */
		click(findButton(tree, zh.selectNone));
		tree = await react.render(Page, {});
		assert.equal(findAll(tree, (node) => node.props.type === "checkbox" && node.props.checked === true).length, 0);
		toggleCheckbox(modelCheckbox(tree, "deepseek-v4.1-flash"));
		tree = await react.render(Page, {});
		toggleCheckbox(modelCheckbox(tree, "gemini-3.8-flash"));
		tree = await react.render(Page, {});

		/* 4. 名称与容量：名称默认是目录里的显示名，可以逐个改；容量只填 gemini。 */
		assert.equal(rowFields(tree, "deepseek-v4.1-flash").name.props.value, "DeepSeek v4.1 Flash");
		assert.equal(rowFields(tree, "gemini-3.8-flash").name.props.value, "Gemini 3.8 Flash");
		change(rowFields(tree, "gemini-3.8-flash").name, "Google Gemini 3.8");
		tree = await react.render(Page, {});
		/* 名称清空 = 不写这个键。 */
		change(rowFields(tree, "deepseek-v4.1-flash").name, "");
		tree = await react.render(Page, {});
		change(rowFields(tree, "gemini-3.8-flash").contextWindow, "1M");
		tree = await react.render(Page, {});
		change(rowFields(tree, "gemini-3.8-flash").maxTokens, "64K");
		tree = await react.render(Page, {});

		/* 5. 输入格式与思考强度。 */
		includes(tree, zh.stepCapability);
		/* 默认：文本一定勾上；目录报告图像的模型连图像一起勾上。 */
		assert.equal(modalityCheckbox(tree, "deepseek-v4.1-flash", zh.modalityText).props.checked, true);
		assert.equal(modalityCheckbox(tree, "deepseek-v4.1-flash", zh.modalityImage).props.checked, false);
		assert.equal(modalityCheckbox(tree, "gemini-3.8-flash", zh.modalityImage).props.checked, true);
		/* 给 deepseek 补上图像，再取消 gemini 的图像（只勾文本 → 不写 input 键）。 */
		toggleCheckbox(modalityCheckbox(tree, "deepseek-v4.1-flash", zh.modalityImage));
		tree = await react.render(Page, {});
		toggleCheckbox(modalityCheckbox(tree, "gemini-3.8-flash", zh.modalityImage));
		tree = await react.render(Page, {});

		/* 档位默认都没勾，键与值先置灰。 */
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").toggle.props.checked, false);
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").key.props.disabled, true);
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").value.props.disabled, true);
		/* 勾 low：键与值默认都填 low，之后可以改。 */
		toggleCheckbox(effortRow(tree, "deepseek-v4.1-flash", "low").toggle);
		tree = await react.render(Page, {});
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").key.props.value, "low");
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").value.props.value, "low");
		assert.equal(effortRow(tree, "deepseek-v4.1-flash", "low").value.props.disabled, false);
		change(effortRow(tree, "deepseek-v4.1-flash", "low").value, "low-v2");
		tree = await react.render(Page, {});
		toggleCheckbox(effortRow(tree, "deepseek-v4.1-flash", "high").toggle);
		tree = await react.render(Page, {});
		/* gemini：off 只有键没有值，再加上 max。 */
		toggleCheckbox(effortRow(tree, "gemini-3.8-flash", "off").toggle);
		tree = await react.render(Page, {});
		assert.equal(effortRow(tree, "gemini-3.8-flash", "off").key.props.value, "off");
		assert.equal(effortRow(tree, "gemini-3.8-flash", "off").value.props.value, "");
		toggleCheckbox(effortRow(tree, "gemini-3.8-flash", "max").toggle);
		tree = await react.render(Page, {});

		/* 预览与可导入状态。 */
		const expectedProfile = {
			displayName: "Example API 2",
			apiKeyEnv: "EXAMPLE_API_2_API_KEY",
			api: "openai-responses",
			baseURL: "https://api.example-provider.test/v1",
			models: [
				{ id: "deepseek-v4.1-flash", input: ["text", "image"], reasoningEfforts: { low: "low-v2", high: "high" } },
				{
					id: "gemini-3.8-flash",
					name: "Google Gemini 3.8",
					contextWindow: 1000000,
					maxTokens: 64000,
					reasoningEfforts: { off: null, max: "max" },
				},
			],
		};
		const preview = findAll(tree, (node) => node.type === "pre")[0];
		assert.deepEqual(JSON.parse(textOf(preview)), { providers: { "example-api-2": expectedProfile } });
		includes(tree, fill(zh.previewTitle, { id: "example-api-2" }));
		assert.equal(findButton(tree, zh.importButton).props.disabled, false);

		/* 容量填错时不允许导入。 */
		change(rowFields(tree, "deepseek-v4.1-flash").contextWindow, "abc");
		tree = await react.render(Page, {});
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		includes(tree, fill(zh.capacityInvalid, { id: "deepseek-v4.1-flash", field: zh.capacityFieldContext }));
		change(rowFields(tree, "deepseek-v4.1-flash").contextWindow, "");
		tree = await react.render(Page, {});

		/* 挡位填得不对也不允许导入。 */
		toggleCheckbox(effortRow(tree, "gemini-3.8-flash", "max").toggle);
		tree = await react.render(Page, {});
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		includes(tree, fill(zh.reasoningOnlyOff, { id: "gemini-3.8-flash" }));
		toggleCheckbox(effortRow(tree, "gemini-3.8-flash", "max").toggle);
		tree = await react.render(Page, {});
		change(effortRow(tree, "gemini-3.8-flash", "max").value, "   ");
		tree = await react.render(Page, {});
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		includes(tree, fill(zh.reasoningEmptyValue, { id: "gemini-3.8-flash", level: zh.effortMax }));
		change(effortRow(tree, "gemini-3.8-flash", "max").value, "max");
		tree = await react.render(Page, {});
		change(effortRow(tree, "gemini-3.8-flash", "max").key, "maximum");
		tree = await react.render(Page, {});
		assert.equal(findButton(tree, zh.importButton).props.disabled, true);
		includes(
			tree,
			fill(zh.reasoningUnknownKey, {
				id: "gemini-3.8-flash",
				level: zh.effortMax,
				key: "maximum",
				allowed: zh.reasoningAllowed,
			}),
		);
		change(effortRow(tree, "gemini-3.8-flash", "max").key, "max");
		tree = await react.render(Page, {});
		assert.equal(findButton(tree, zh.importButton).props.disabled, false);

		/* 6. 导入。 */
		click(findButton(tree, zh.importButton));
		tree = await react.render(Page, {});
		assert.equal(fake.calls.mutate.length, 1);
		assert.equal(fake.calls.mutate[0].ns, "llm-pi-ai");
		assert.equal(fake.calls.mutate[0].expectedRevision, 3);
		assert.deepEqual(fake.calls.mutate[0].ops, [{ op: "set", path: ["providers", "example-api-2"], value: expectedProfile }]);
		assert.deepEqual(fake.calls.set, [{ ref: "EXAMPLE_API_2_API_KEY", value: key }]);
		assert.ok(fake.calls.describeCredentials.length >= 1);
		includes(tree, fill(zh.done, { id: "example-api-2", count: 2, ref: "EXAMPLE_API_2_API_KEY" }));
		/* 表单清空（能力卡片也一起清），已有供应商列表刷新。 */
		assert.equal(findInput(tree, "https://gateway.example").props.value, "");
		includes(tree, zh.capabilityNone);
		includes(tree, "example-api-2");
		assert.deepEqual(fake.providers()["example-api-2"], expectedProfile);
	});

	await test("revision 冲突时重读后重试一次", async () => {
		const fake = createFakeContext({ revision: 5, conflictOnce: true });
		const Page = internals.createSettingsPage(fake.ctx, t);
		let tree = await react.render(Page, {});
		change(findAll(tree, (node) => node.type === "textarea")[0], connectionJSON);
		tree = await react.render(Page, {});
		change(findInput(tree, zh.providerIdPlaceholder), "second-api");
		tree = await react.render(Page, {});
		click(findButton(tree, zh.fetchModels));
		tree = await react.render(Page, {});
		toggleCheckbox(modelCheckbox(tree, "gpt-5.6-sol"));
		tree = await react.render(Page, {});
		click(findButton(tree, zh.importButton));
		tree = await react.render(Page, {});
		assert.deepEqual(
			fake.calls.mutate.map((call) => call.expectedRevision),
			[5, 6],
		);
		includes(tree, fill(zh.done, { id: "second-api", count: 1, ref: "SECOND_API_API_KEY" }));
		/* 命名空间反查失败时退回 llm-pi-ai。 */
		assert.equal(fake.calls.mutate[1].ns, "llm-pi-ai");
	});

	await test("上游拒绝时把原因显示出来", async () => {
		const fake = createFakeContext({
			discovery: { ok: false, error: { code: "MISSING_CREDENTIAL", message: "no credential for this route" } },
		});
		const Page = internals.createSettingsPage(fake.ctx, t);
		let tree = await react.render(Page, {});
		change(findAll(tree, (node) => node.type === "textarea")[0], connectionJSON);
		tree = await react.render(Page, {});
		click(findButton(tree, zh.fetchModels));
		tree = await react.render(Page, {});
		includes(tree, "no credential for this route");
		assert.deepEqual(visibleModelIds(tree), []);
	});

	await test("密钥由环境变量提供时跳过写文件并提示", async () => {
		const fake = createFakeContext({ credential: { configured: true, source: "env", writable: false } });
		const Page = internals.createSettingsPage(fake.ctx, t);
		let tree = await react.render(Page, {});
		change(findAll(tree, (node) => node.type === "textarea")[0], connectionJSON);
		tree = await react.render(Page, {});
		includes(tree, zh.keyRefReadonly);
		click(findButton(tree, zh.fetchModels));
		tree = await react.render(Page, {});
		toggleCheckbox(modelCheckbox(tree, "gpt-5.6-sol"));
		tree = await react.render(Page, {});
		click(findButton(tree, zh.importButton));
		tree = await react.render(Page, {});
		assert.equal(fake.calls.mutate.length, 1);
		assert.deepEqual(fake.calls.set, []);
		includes(tree, fill(zh.keyFromEnvironment, { ref: "EXAMPLE_PROVIDER_TEST_API_KEY" }));
	});

	await test("密钥写盘被拒时报错但不影响供应商已写入", async () => {
		const fake = createFakeContext();
		fake.ctx.remote.credentials.set = async () => ({ ok: false, error: { code: "EACCES", message: "read-only home" } });
		const Page = internals.createSettingsPage(fake.ctx, t);
		let tree = await react.render(Page, {});
		change(findAll(tree, (node) => node.type === "textarea")[0], connectionJSON);
		tree = await react.render(Page, {});
		click(findButton(tree, zh.fetchModels));
		tree = await react.render(Page, {});
		toggleCheckbox(modelCheckbox(tree, "gpt-5.6-sol"));
		tree = await react.render(Page, {});
		click(findButton(tree, zh.importButton));
		tree = await react.render(Page, {});
		assert.equal(fake.calls.mutate.length, 1);
		includes(tree, fill(zh.keyWriteFailed, { ref: "EXAMPLE_PROVIDER_TEST_API_KEY", message: "read-only home" }));
		includes(tree, fill(zh.done, { id: "example-provider-test", count: 1, ref: "EXAMPLE_PROVIDER_TEST_API_KEY" }));
	});

	await test("挂载注册设置页插槽", () => {
		const registered = [];
		const dictionaries = [];
		const previous = globalThis.document;
		globalThis.document = {
			head: { append() {} },
			getElementById: () => null,
			createElement: () => ({ id: "", textContent: "" }),
		};
		try {
			exports.apply({
				effect: (fn) => fn(),
				locale: {
					register: (ns, dicts) => dictionaries.push({ ns, dicts }),
					bind: (ns) => (key) => `${ns}:${key}`,
				},
				slots: {
					inject: (key, callback) => {
						assert.equal(key, "settings.section");
						callback();
					},
					register: (descriptor, component) => {
						registered.push({ descriptor, component });
						return () => {};
					},
				},
			});
		} finally {
			if (previous === undefined) delete globalThis.document;
			else globalThis.document = previous;
		}
		assert.equal(registered.length, 1);
		const descriptor = registered[0].descriptor;
		assert.equal(descriptor.name, "settings.section");
		assert.equal(descriptor.id, "import-newapi");
		assert.equal(descriptor.order, 50);
		assert.equal(descriptor.locale, "dsh-import-newapi");
		assert.equal(descriptor.label(), "dsh-import-newapi:nav");
		assert.equal(typeof registered[0].component, "function");
		assert.equal(dictionaries.length, 1);
		assert.equal(dictionaries[0].ns, "dsh-import-newapi");
		assert.deepEqual(dictionaries[0].dicts, { zh, en });
	});

	rmSync(scratch, { recursive: true, force: true });
	process.stdout.write(`\n全部 ${passed} 组用例通过。\n`);
}

await main();
