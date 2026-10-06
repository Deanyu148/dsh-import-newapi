/**
 * dsh-import-newapi —— 浏览器半边（DSH 客户端 bundle）。
 *
 * 它在设置面板里加一个「New API 导入」页，流程是：
 *   1. 粘贴从 New API 复制出来的连接信息（`{"_type":"newapi_channel_conn",…}`），
 *      也可以直接手填 url / 密钥；
 *   2. 填供应商 id、显示名，选协议；baseURL 按协议自动推导，也能手改；
 *   3. 拉取模型列表，带搜索栏、单模型多选框和「全选 / 反选 / 全不选」；
 *   4. 给勾选的模型逐个填名称、上下文窗口与最大输出（留空 = 不写这些键）；
 *   5. 声明每个模型支持的输入模态（text / image）与思考档位
 *      （`reasoningEfforts` 的键与值都能改，`off` 可以只有键没有值）；
 *   6. 导入：供应商写进 profile 的 `cordis.patch.yml`（`llm-pi-ai` 的
 *      `config.providers` 下新建一个键），密钥写进 `.credentials.yaml` 的 `refs:`。
 *
 * 写盘全部走 DSH 自己的 Remote（`settings.mutate` / `credentials.set`），所以
 * 校验、加锁、原子写入、热重载都由宿主负责；本插件不直接改文件。
 */
window.__ModuleLoader__.load({
	id: "dsh-import-newapi",
	factory: (require) => {
		var module = { exports: {} };

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		/** 插件名，同时也是 locale 命名空间。 */
		const NAME = "dsh-import-newapi";
		/** 设置页在侧边栏里的位置：排在「模型」之后、社区页之前。 */
		const SECTION_ORDER = 50;
		/** 内联样式的 style 元素 id，避免重复注入。 */
		const CSS_TAG_ID = "dsh-import-newapi/styles";
		/** New API 复制信息的类型标记。 */
		const CONNECTION_TYPE = "newapi_channel_conn";
		/** 供应商 id：小写英文字母开头，其后只能是小写英文字母、数字、连字符。 */
		const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
		/** pi-ai 适配器条目的包名，用作兜底命名空间。 */
		const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";
		/** 找不到适配器时的兜底设置命名空间（= profile 里该条目的 id）。 */
		const PI_AI_FALLBACK_NS = "llm-pi-ai";

		/* ------------------------------------------------------------------ */
		/* 协议与 URL 推导                                                      */
		/* ------------------------------------------------------------------ */

		/** 可选的三种协议：`api` 是写入配置的协议名。 */
		const PROTOCOLS = [
			{ api: "openai-completions", label: "protocolOpenaiCompletions" },
			{ api: "openai-responses", label: "protocolOpenaiResponses" },
			{ api: "anthropic-messages", label: "protocolAnthropicMessages" },
		];

		/** 去掉首尾空白与末尾斜杠。 */
		function stripTrailingSlashes(value) {
			return String(value).trim().replace(/\/+$/, "");
		}

		/**
		 * 由连接信息里的 url 推导某个协议的 baseURL。
		 *
		 * New API 给出的 url 是站点地址，不一定是某个协议的 baseURL：
		 * OpenAI 系列（chat completions / responses）的 baseURL 需要以 `/v1`
		 * 结尾，而 Anthropic Messages 的 baseURL 是站点根，SDK 自己会拼
		 * `/v1/messages`。所以这里按协议补齐或去掉末尾的 `/v1`，两种方向的
		 * 输入都能得到正确结果。
		 * @param url - 连接信息里的 url。
		 * @param api - 协议名。
		 * @returns 该协议应写入 `baseURL` 的值。
		 */
		function deriveBaseURL(url, api) {
			const root = stripTrailingSlashes(url);
			if (root.length === 0) return "";
			const withV1 = /\/v1$/i.test(root) ? root : `${root}/v1`;
			return api === "anthropic-messages" ? withV1.replace(/\/v1$/i, "") : withV1;
		}

		/**
		 * 供应商 id → 凭据引用名：全大写，连字符换成下划线，末尾加 `_API_KEY`。
		 * @param providerId - 供应商 id。
		 * @returns 写入 `refs:` 的名字。
		 */
		function keyRefOf(providerId) {
			return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
		}

		/**
		 * 解析 New API 复制出来的连接信息。
		 * @param text - 粘贴框里的原始文本。
		 * @returns `{kind:"empty"}`、`{kind:"invalid", reason}` 或 `{kind:"ok", url, key}`。
		 */
		function parseConnection(text) {
			const trimmed = String(text).trim();
			if (trimmed.length === 0) return { kind: "empty" };
			let data;
			try {
				data = JSON.parse(trimmed);
			} catch (error) {
				return { kind: "invalid", reason: "connectionNotJson" };
			}
			if (data === null || typeof data !== "object" || Array.isArray(data)) {
				return { kind: "invalid", reason: "connectionNotObject" };
			}
			if (typeof data._type === "string" && data._type !== CONNECTION_TYPE) {
				return { kind: "invalid", reason: "connectionWrongType" };
			}
			const url = typeof data.url === "string" ? data.url.trim() : "";
			const key = typeof data.key === "string" ? data.key.trim() : "";
			if (url.length === 0) return { kind: "invalid", reason: "connectionNoUrl" };
			if (key.length === 0) return { kind: "invalid", reason: "connectionNoKey" };
			return { kind: "ok", url, key };
		}

		/**
		 * 由站点地址猜一个供应商 id 作为默认值，用户随时可以改。
		 * @param url - 站点地址。
		 * @returns 合法的候选 id，猜不出来时是空串。
		 */
		function suggestProviderId(url) {
			let host = "";
			try {
				host = new URL(stripTrailingSlashes(url)).host;
			} catch (error) {
				return "";
			}
			const cleaned = host
				.toLowerCase()
				.replace(/^www\./, "")
				.replace(/^api\./, "")
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.replace(/-{2,}/g, "-");
			return PROVIDER_ID_PATTERN.test(cleaned) ? cleaned : "";
		}

		/* ------------------------------------------------------------------ */
		/* 容量输入                                                            */
		/* ------------------------------------------------------------------ */

		/** `256K` / `1M` 里的后缀倍率。 */
		const CAPACITY_SCALE = { k: 1000, m: 1000000 };
		/** 容量写法：纯数字，或数字加 K/M 后缀。 */
		const CAPACITY_PATTERN = /^([0-9]+(?:\.[0-9]+)?)\s*([kKmM])?$/;

		/**
		 * 读一个容量输入框。
		 * @param text - 输入框文本。
		 * @returns 留空返回 `undefined`（不写这个键）；读不出来返回 `NaN`。
		 */
		function parseCapacity(text) {
			const trimmed = String(text ?? "").trim();
			if (trimmed.length === 0) return undefined;
			const match = CAPACITY_PATTERN.exec(trimmed);
			if (match === null) return NaN;
			const suffix = match[2] === undefined ? undefined : match[2].toLowerCase();
			const scale = suffix === undefined ? 1 : CAPACITY_SCALE[suffix];
			const scaled = Number(match[1]) * scale;
			return Number.isFinite(scaled) ? Math.round(scaled) : NaN;
		}

		/**
		 * 把已存储的容量写回输入框的占位提示。
		 * @param value - 目录里报告的容量。
		 * @returns 提示文本，没有时是空串。
		 */
		function formatCapacity(value) {
			if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return "";
			if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`;
			if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`;
			return String(value);
		}

		/* ------------------------------------------------------------------ */
		/* 输入模态与思考档位                                                  */
		/* ------------------------------------------------------------------ */

		/** 一个模型可以声明的输入模态，顺序与适配器的 MODALITIES 一致。 */
		const MODALITIES = ["text", "image"];
		/** 适配器的默认输入模态：只声明文本等于默认值，不写 `input` 键。 */
		const DEFAULT_INPUT = ["text"];
		/**
		 * 适配器允许的思考档位，升序。
		 * `reasoningEfforts` 的键必须落在其中；`minimal` 不在页面的预设里，
		 * 但用户把它填进键名也能通过（校验认的是这个集合，不是预设）。
		 */
		const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		/** 页面提供的档位预设：`key` 是配置键，`value` 是要发送的值。 */
		const EFFORT_PRESETS = [
			{ key: "off", value: "", label: "effortOff" },
			{ key: "low", value: "low", label: "effortLow" },
			{ key: "medium", value: "medium", label: "effortMedium" },
			{ key: "high", value: "high", label: "effortHigh" },
			{ key: "xhigh", value: "xhigh", label: "effortXhigh" },
			{ key: "max", value: "max", label: "effortMax" },
		];

		/**
		 * 一个模型的输入模态默认勾选什么：文本一定有；目录报告支持图像时连图像
		 * 一起勾上（等于沿用适配器内置目录的说法）。
		 * @param model - 目录里这个模型。
		 * @returns 勾选的模态列表。
		 */
		function defaultInputsFor(model) {
			const list = [...DEFAULT_INPUT];
			const reported = model === undefined ? undefined : model.inputModalities;
			if (Array.isArray(reported) && reported.includes("image")) list.push("image");
			return list;
		}

		/**
		 * 把勾选的模态整理成 `input` 的值。
		 *
		 * 只勾文本就是适配器的默认值，写出来是多余的键，所以返回 `undefined`；
		 * 一个都没勾同样不写（空数组等于没声明）。
		 * @param selection - 勾选的模态。
		 * @returns 要写入的 `input`，不需要时是 `undefined`。
		 */
		function buildInput(selection) {
			const checked = Array.isArray(selection) ? selection : DEFAULT_INPUT;
			const ordered = MODALITIES.filter((modality) => checked.includes(modality));
			if (ordered.length === 0) return undefined;
			if (ordered.length === DEFAULT_INPUT.length && ordered.every((modality, index) => modality === DEFAULT_INPUT[index])) {
				return undefined;
			}
			return ordered;
		}

		/**
		 * 把勾选的档位整理成 `reasoningEfforts` 的值。
		 *
		 * 规则照抄适配器的校验：键必须落在 {@link THINKING_LEVELS} 里、不能重复；
		 * 除了 `off` 之外都必须给出要发送的值；如果声明了就必须至少有一个非 off
		 * 的档位；`off` 留空写 `null`（适配器读作“支持，但不发送参数”）。
		 * 一个档位都没勾就返回 `{kind:"none"}`，不写这个键。
		 * @param rows - 该模型的档位行 `{preset, on, key, value}`。
		 * @returns `{kind:"none"}`、`{kind:"ok", value}` 或 `{kind:"invalid", preset, detail, key?}`。
		 */
		function buildReasoningEfforts(rows) {
			const active = (rows === undefined ? [] : rows).filter((row) => row.on === true);
			if (active.length === 0) return { kind: "none" };
			const declared = new Map();
			for (const row of active) {
				const preset = row.preset;
				const key = String(row.key ?? "").trim();
				if (key.length === 0) return { kind: "invalid", preset, detail: "emptyKey" };
				if (!THINKING_LEVELS.includes(key)) return { kind: "invalid", preset, detail: "unknownKey", key };
				if (declared.has(key)) return { kind: "invalid", preset, detail: "duplicateKey", key };
				const value = String(row.value ?? "").trim();
				if (key !== "off" && value.length === 0) return { kind: "invalid", preset, detail: "emptyValue", key };
				declared.set(key, key === "off" && value.length === 0 ? null : value);
			}
			if (![...declared.keys()].some((key) => key !== "off")) return { kind: "invalid", preset: "off", detail: "onlyOff" };
			const value = {};
			for (const level of THINKING_LEVELS) {
				if (declared.has(level)) value[level] = declared.get(level);
			}
			return { kind: "ok", value };
		}

		/**
		 * 找出第一个档位填得不对的模型。
		 * @param ids - 勾选的模型 id。
		 * @param rowsById - 模型 id → 档位行。
		 * @returns 出错信息，全部合法时是 `undefined`。
		 */
		function firstReasoningFailure(ids, rowsById) {
			for (const id of ids) {
				const state = rowsById === undefined ? undefined : rowsById[id];
				const built = buildReasoningEfforts(state);
				if (built.kind === "invalid") return Object.assign({ id }, built);
			}
			return undefined;
		}

		/* ------------------------------------------------------------------ */
		/* 宿主 Remote 封装                                                    */
		/* ------------------------------------------------------------------ */

		/**
		 * 找到 pi-ai 适配器在设置文档里的命名空间。
		 *
		 * `llm-pi-ai` 会把它配置的每一个供应商登记成「可配置供应商」，路径是
		 * `providers.<供应商>`，所以任何一条这样的登记都能告诉我们该适配器用的是
		 * 哪个设置命名空间；找不到就退回默认值。
		 * @param ctx - 客户端插件上下文。
		 * @returns 设置命名空间（= profile 里该条目的 id）。
		 */
		async function resolveSettingsNs(ctx) {
			try {
				const response = await ctx.remote.llm.listConfigurableProviders();
				if (response.ok) {
					const row = response.value.find(
						(entry) =>
							Array.isArray(entry.settingsPath) &&
							entry.settingsPath.length === 2 &&
							entry.settingsPath[0] === "providers",
					);
					if (row !== undefined && typeof row.settingsNs === "string" && row.settingsNs.length > 0) {
						return row.settingsNs;
					}
				}
			} catch (error) {
				/* 退回默认命名空间 */
			}
			return PI_AI_FALLBACK_NS;
		}

		/**
		 * 读一个设置命名空间的当前文档行（含 revision 与当前值）。
		 * @param ctx - 客户端插件上下文。
		 * @param ns - 设置命名空间。
		 * @returns 文档行，没有时是 `undefined`。
		 */
		async function readNamespace(ctx, ns) {
			const response = await ctx.remote.settings.describe();
			if (!response.ok) throw new Error(response.error.message);
			return response.value.namespaces.find((row) => row.ns === ns);
		}

		/**
		 * 当前文档里已经存在的供应商 id（包括本插件建的，也包括手写的）。
		 * @param row - 设置文档行。
		 * @returns 供应商 id 列表。
		 */
		function providerIdsOf(row) {
			const providers = row === undefined || row.value === null || typeof row.value !== "object" ? undefined : row.value.providers;
			if (providers === undefined || providers === null || typeof providers !== "object") return [];
			return Object.keys(providers);
		}

		/* ------------------------------------------------------------------ */
		/* 写盘对象构造                                                        */
		/* ------------------------------------------------------------------ */

		/**
		 * 组装 `providers.<id>` 的值。只写有意义的键：显示名留空不写，容量留空不写。
		 * @param input - 表单状态。
		 * @returns 准备写进 `cordis.patch.yml` 的供应商对象。
		 */
		function buildProfile(input) {
			const profile = {};
			if (input.displayName.length > 0) profile.displayName = input.displayName;
			profile.apiKeyEnv = keyRefOf(input.providerId);
			profile.api = input.api;
			profile.baseURL = input.baseURL;
			profile.models = buildModelEntries(input.ids, input.discovered, input.capacities, input.names, input.inputs, input.efforts);
			return profile;
		}

		/**
		 * 把勾选结果、用户填的名称、容量、输入模态与思考档位整理成 `models` 数组。
		 *
		 * 只保留有信息的键：`name` 留空或与 id 相同就不写（此时由适配器或内置
		 * 目录决定显示名）；容量留空就不写；`input` 只勾文本时等于默认值，不写；
		 * `reasoningEfforts` 一个档位都没勾时不写。
		 * @param ids - 按列表顺序排好的模型 id。
		 * @param discovered - 拉取到的模型列表。
		 * @param capacities - `"<id>:contextWindow"` / `"<id>:maxTokens"` → 输入文本。
		 * @param names - 模型 id → 用户改过的显示名；没改过的用目录里的名字。
		 * @param inputs - 模型 id → 勾选的输入模态；没碰过的用目录的默认值。
		 * @param efforts - 模型 id → 档位行；没勾的不写这个键。
		 * @returns 模型条目数组。
		 */
		function buildModelEntries(ids, discovered, capacities, names, inputs, efforts) {
			const byId = new Map(discovered.map((model) => [model.id, model]));
			const overrides = names === undefined ? {} : names;
			const inputState = inputs === undefined ? {} : inputs;
			const effortState = efforts === undefined ? {} : efforts;
			return ids.map((id) => {
				const candidate = byId.get(id);
				const entry = { id };
				const fallback = candidate === undefined ? undefined : candidate.name;
				const typed = overrides[id];
				const name = typed === undefined ? fallback : String(typed).trim();
				const trimmed = typeof name === "string" ? name.trim() : "";
				if (trimmed.length > 0 && trimmed !== id) entry.name = trimmed;
				const contextWindow = parseCapacity(capacities[`${id}:contextWindow`]);
				if (Number.isFinite(contextWindow)) entry.contextWindow = contextWindow;
				const maxTokens = parseCapacity(capacities[`${id}:maxTokens`]);
				if (Number.isFinite(maxTokens)) entry.maxTokens = maxTokens;
				const selection = inputState[id] === undefined ? defaultInputsFor(candidate) : inputState[id];
				const modalities = buildInput(selection);
				if (modalities !== undefined) entry.input = modalities;
				const reasoning = buildReasoningEfforts(effortState[id]);
				if (reasoning.kind === "ok") entry.reasoningEfforts = reasoning.value;
				return entry;
			});
		}

		/**
		 * 找出第一个填得不对的容量输入。
		 * @param ids - 勾选的模型 id。
		 * @param capacities - 容量输入文本。
		 * @returns 出错信息，全部合法时是 `undefined`。
		 */
		function firstCapacityFailure(ids, capacities) {
			for (const id of ids) {
				for (const field of ["contextWindow", "maxTokens"]) {
					const value = parseCapacity(capacities[`${id}:${field}`]);
					if (Number.isNaN(value)) return { id, field };
				}
			}
			return undefined;
		}

		/* ------------------------------------------------------------------ */
		/* 样式                                                                */
		/* ------------------------------------------------------------------ */

		/** 本页用到的 CSS（主题变量与 DSH 设置面板保持一致）。 */
		const CSS = `
.dsh-import-newapi-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.dsh-import-newapi-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-import-newapi-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.dsh-import-newapi-step{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);display:flex;flex-direction:column;gap:10px;padding:12px 14px}
.dsh-import-newapi-stepHead{align-items:center;gap:8px;display:flex}
.dsh-import-newapi-stepIndex{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-secondary);border-radius:50%;flex:none;justify-content:center;align-items:center;width:20px;height:20px;font-size:12px;display:inline-flex}
.dsh-import-newapi-stepTitle{font-size:14px;font-weight:500;line-height:22px}
.dsh-import-newapi-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsh-import-newapi-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-import-newapi-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-import-newapi-input,.dsh-import-newapi-select,.dsh-import-newapi-textarea{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;padding:7px 10px}
.dsh-import-newapi-input,.dsh-import-newapi-select{height:36px}
.dsh-import-newapi-textarea{resize:vertical;font-size:13px;line-height:20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-import-newapi-input:focus-visible,.dsh-import-newapi-select:focus-visible,.dsh-import-newapi-textarea:focus-visible{outline:none;border-color:var(--dsw-focus-ring-color)}
.dsh-import-newapi-button{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);height:32px;font:inherit;font-size:13px;cursor:pointer;justify-content:center;align-items:center;gap:4px;padding:0 12px;display:inline-flex}
.dsh-import-newapi-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-import-newapi-button:disabled{opacity:.5;cursor:not-allowed}
.dsh-import-newapi-buttonPrimary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-import-newapi-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-import-newapi-toolbar{align-items:center;gap:6px;flex-wrap:wrap;display:flex}
.dsh-import-newapi-count{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:auto}
.dsh-import-newapi-list{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:6px}
.dsh-import-newapi-item{align-items:center;gap:8px;border-radius:var(--dsw-radius-sm);cursor:pointer;display:flex;padding:3px 6px;font-size:13px;line-height:20px}
.dsh-import-newapi-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-import-newapi-itemId{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-import-newapi-itemName{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-import-newapi-capHead,.dsh-import-newapi-capRow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:center}
.dsh-import-newapi-capRow .dsh-import-newapi-input{font-size:13px;padding:6px 8px}
.dsh-import-newapi-capHead{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-import-newapi-capId{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.dsh-import-newapi-capability{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);display:flex;flex-direction:column;gap:6px;padding:8px 10px}
.dsh-import-newapi-capabilityHead{align-items:center;gap:8px;flex-wrap:wrap;display:flex}
.dsh-import-newapi-modalities{align-items:center;gap:12px;flex-wrap:wrap;display:flex}
.dsh-import-newapi-modality{align-items:center;gap:6px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;display:flex}
.dsh-import-newapi-effortRow{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) 6px minmax(0,1fr);gap:6px;align-items:center}
.dsh-import-newapi-effortToggle{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;display:flex}
.dsh-import-newapi-effortColon{color:var(--dsw-alias-label-tertiary);text-align:center}
.dsh-import-newapi-effortRow .dsh-import-newapi-input{font-size:13px;height:30px;padding:4px 8px}
.dsh-import-newapi-scroll{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:8px}
.dsh-import-newapi-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.dsh-import-newapi-warn{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;margin:0}
.dsh-import-newapi-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;margin:0}
.dsh-import-newapi-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.dsh-import-newapi-code{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-xs);padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dsh-import-newapi-actions{align-items:center;gap:10px;display:flex}
.dsh-import-newapi-preview summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}
.dsh-import-newapi-preview pre{background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-md);margin:8px 0 0;padding:10px;max-height:220px;overflow:auto;font-size:12px;line-height:18px}
`;

		/** 注入一次样式表。 */
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_TAG_ID) !== null) return;
			const style = document.createElement("style");
			style.id = CSS_TAG_ID;
			style.textContent = CSS;
			document.head.append(style);
		}

		/* ------------------------------------------------------------------ */
		/* 文案                                                                */
		/* ------------------------------------------------------------------ */

		const zh = {
			nav: "New API 导入",
			title: "导入 New API 供应商",
			intro: "粘贴从 New API 复制出来的连接信息，选好模型，供应商会写进本 profile 的 cordis.patch.yml，密钥会写进 .credentials.yaml。做第二次导入就会再新建一个供应商。",
			stepConnection: "连接信息",
			connectionLabel: "粘贴连接信息（newapi_channel_conn）",
			connectionPlaceholder: '{"_type":"newapi_channel_conn","key":"sk-…","url":"https://…"}',
			connectionEmpty: "尚未粘贴，也可以直接在下面手填 url 与密钥。",
			connectionNotJson: "这段文本不是合法 JSON。",
			connectionNotObject: "JSON 顶层必须是对象。",
			connectionWrongType: "这条信息的 _type 不是 newapi_channel_conn。",
			connectionNoUrl: "缺少 url 字段。",
			connectionNoKey: "缺少 key 字段。",
			connectionOk: "已识别，url 与密钥已填入下面。",
			urlLabel: "站点地址 url",
			keyLabel: "密钥 key",
			keyPlaceholder: "sk-…",
			stepProvider: "供应商",
			providerIdLabel: "供应商 id",
			providerIdPlaceholder: "例如 my-gateway",
			providerIdRequired: "请填写供应商 id。",
			providerIdInvalid: "id 必须以小写英文字母开头，只能用小写英文字母、数字、连字符（-），且连字符不能放在开头、结尾或连续出现。",
			providerIdTaken: "这个 id 已经存在，请换一个（已有的供应商不会被覆盖）。",
			displayNameLabel: "显示名（可留空）",
			displayNamePlaceholder: "留空则显示 id",
			protocolLabel: "协议",
			protocolOpenaiCompletions: "OpenAI Chat Completions",
			protocolOpenaiResponses: "OpenAI Responses",
			protocolAnthropicMessages: "Anthropic Messages",
			baseUrlLabel: "baseURL（按协议自动推导，可手改）",
			baseUrlInvalid: "baseURL 必须是 http(s) 地址。",
			keyRefLabel: "密钥引用名（自动推导）",
			keyRefWritable: "导入时会把密钥写进 .credentials.yaml 的这个引用。",
			keyRefReadonly: "这个引用已经由启动环境提供了，导入时会跳过写 .credentials.yaml。",
			existingLabel: "该 profile 已有的供应商：",
			existingEmpty: "（无）",
			stepModels: "模型",
			fetchModels: "获取模型列表",
			fetching: "拉取中…",
			modelsNeedTarget: "先填好 baseURL 与密钥，再拉取模型列表。",
			modelsFound: "拉到 {count} 个模型。",
			modelsNone: "这个网关没有返回任何模型。",
			searchPlaceholder: "搜索模型 id / 名称",
			selectAll: "全选",
			invertSelection: "反选",
			selectNone: "全不选",
			selectedCount: "已选 {count} / {total}",
			modelsEmpty: "还没拉取模型列表。",
			stepCapacity: "名称与容量（留空即不写该键）",
			capacityHeaderModel: "模型 id",
			capacityHeaderName: "名称（可改）",
			capacityHeaderContext: "上下文窗口",
			capacityHeaderOutput: "最大输出",
			capacityPlaceholder: "默认",
			namePlaceholder: "默认用 id",
			capacityHint: "名称就是显示名，可以在列表里逐个改，留空则用目录里的名字；容量支持 256K / 1M 这种写法，留空则由适配器或内置目录决定。",
			capacityInvalid: "模型 {id} 的{field}填得无法识别。",
			capacityFieldContext: "上下文窗口",
			capacityFieldOutput: "最大输出",
			capacityNone: "先在上面勾选模型。",
			stepCapability: "输入格式与思考强度（可留空）",
			capabilityHint:
				"输入格式默认勾选文本；连图像一起勾就会写 input: [text, image]（只勾文本等于默认值，不写这个键）。思考强度就是模板里的 reasoningEfforts：勾上档位后，中间是配置键（off / low / medium / high / xhigh / max，可以改），右边是该档位要发给网关的值。off 留空表示不发送这个参数（写出来就是 off: null），非 off 的档位必须给值；一个档位都不勾就不写 reasoningEfforts。",
			capabilityNone: "先在上面勾选模型。",
			inputFormatLabel: "输入格式",
			modalityText: "文本",
			modalityImage: "图像",
			inputFormatHint: "只勾文本等于默认值，不写 input 键。",
			effortOff: "关闭",
			effortLow: "低",
			effortMedium: "中",
			effortHigh: "高",
			effortXhigh: "极高",
			effortMax: "最高",
			effortOffPlaceholder: "（不传值）",
			effortValuePlaceholder: "要发送的值",
			reasoningAllowed: "off / minimal / low / medium / high / xhigh / max",
			reasoningEmptyKey: "模型 {id} 勾选的{level}档位没有填配置键。",
			reasoningUnknownKey: "模型 {id} 的{level}档位键名 {key} 不在允许的档位里（{allowed}）。",
			reasoningDuplicateKey: "模型 {id} 有两个档位都用了键名 {key}。",
			reasoningEmptyValue: "模型 {id} 的{level}档位需要一个要发送的值，只有 off 可以留空。",
			reasoningOnlyOff: "模型 {id} 只勾了 off：至少要再勾一个思考档位，或者所有档位都不勾。",
			importButton: "导入",
			importing: "写入中…",
			previewTitle: "将要写入的 provider（llm-pi-ai › config › providers › {id}）",
			done: "已导入供应商 {id}（{count} 个模型），密钥引用 {ref}。",
			keyStored: "密钥已写入 .credentials.yaml。",
			keyFromEnvironment: "密钥引用 {ref} 由启动环境提供，已跳过写 .credentials.yaml；需要在别处修改请改环境变量。",
			keyWriteFailed: "供应商已写入，但密钥写入失败（{ref}）：{message}",
			errorNoNamespace: "这个 profile 里找不到 llm-pi-ai 的设置命名空间。",
		};

		const en = {
			nav: "Import New API",
			title: "Import a New API provider",
			intro: "Paste the connection info copied from New API, pick the models, and the provider is written into this profile's cordis.patch.yml while the key goes into .credentials.yaml. Import again to add another provider.",
			stepConnection: "Connection",
			connectionLabel: "Paste the connection info (newapi_channel_conn)",
			connectionPlaceholder: '{"_type":"newapi_channel_conn","key":"sk-…","url":"https://…"}',
			connectionEmpty: "Nothing pasted yet — you can also fill url and key below by hand.",
			connectionNotJson: "That text is not valid JSON.",
			connectionNotObject: "The JSON root must be an object.",
			connectionWrongType: "This payload's _type is not newapi_channel_conn.",
			connectionNoUrl: "The url field is missing.",
			connectionNoKey: "The key field is missing.",
			connectionOk: "Recognized — url and key were filled in below.",
			urlLabel: "Site url",
			keyLabel: "Key",
			keyPlaceholder: "sk-…",
			stepProvider: "Provider",
			providerIdLabel: "Provider id",
			providerIdPlaceholder: "e.g. my-gateway",
			providerIdRequired: "Enter a provider id.",
			providerIdInvalid: "An id must start with a lowercase letter, use only lowercase letters, digits, and hyphens (-), and may not start, end, or repeat with a hyphen.",
			providerIdTaken: "That id already exists; pick another one (an existing provider is never overwritten).",
			displayNameLabel: "Display name (optional)",
			displayNamePlaceholder: "Falls back to the id",
			protocolLabel: "Protocol",
			protocolOpenaiCompletions: "OpenAI Chat Completions",
			protocolOpenaiResponses: "OpenAI Responses",
			protocolAnthropicMessages: "Anthropic Messages",
			baseUrlLabel: "baseURL (derived from the protocol, editable)",
			baseUrlInvalid: "baseURL must be an http(s) address.",
			keyRefLabel: "Credential reference (derived)",
			keyRefWritable: "The import stores the key under this reference in .credentials.yaml.",
			keyRefReadonly: "This reference is supplied by the launching environment; the import will skip .credentials.yaml.",
			existingLabel: "Providers already in this profile: ",
			existingEmpty: "(none)",
			stepModels: "Models",
			fetchModels: "Fetch model list",
			fetching: "Fetching…",
			modelsNeedTarget: "Fill in baseURL and the key before fetching models.",
			modelsFound: "Fetched {count} models.",
			modelsNone: "The gateway returned no models.",
			searchPlaceholder: "Search model id / name",
			selectAll: "Select all",
			invertSelection: "Invert",
			selectNone: "Select none",
			selectedCount: "{count} of {total} selected",
			modelsEmpty: "No model list fetched yet.",
			stepCapacity: "Name and capacity (blank omits the key)",
			capacityHeaderModel: "Model id",
			capacityHeaderName: "Name (editable)",
			capacityHeaderContext: "Context window",
			capacityHeaderOutput: "Max output",
			capacityPlaceholder: "default",
			namePlaceholder: "id by default",
			capacityHint: "The name is the display name and can be edited per model; blank keeps the catalog name. Capacities accept 256K / 1M; blank lets the adapter or the built-in catalog decide.",
			capacityInvalid: "The {field} of model {id} is not a number.",
			capacityFieldContext: "context window",
			capacityFieldOutput: "max output",
			capacityNone: "Select models above first.",
			stepCapability: "Input formats and reasoning effort (optional)",
			capabilityHint:
				"Text is checked by default; adding image writes input: [text, image] (text alone is the default, so that key is omitted). The reasoning rows are the template's reasoningEfforts: the middle input is the config key (off / low / medium / high / xhigh / max, editable) and the right one is the value sent to the gateway. A blank off sends nothing (written as off: null) and every other level needs a value; leaving every row unticked omits reasoningEfforts.",
			capabilityNone: "Select models above first.",
			inputFormatLabel: "Input formats",
			modalityText: "Text",
			modalityImage: "Image",
			inputFormatHint: "Text alone is the default, so no input key is written.",
			effortOff: "Off",
			effortLow: "Low",
			effortMedium: "Medium",
			effortHigh: "High",
			effortXhigh: "xHigh",
			effortMax: "Max",
			effortOffPlaceholder: "(no value)",
			effortValuePlaceholder: "wire value",
			reasoningAllowed: "off / minimal / low / medium / high / xhigh / max",
			reasoningEmptyKey: "The {level} row of model {id} has no config key.",
			reasoningUnknownKey: "The {level} row of model {id} uses the key {key}, which is not an allowed level ({allowed}).",
			reasoningDuplicateKey: "Model {id} uses the key {key} on two rows.",
			reasoningEmptyValue: "The {level} row of model {id} needs the value to send; only off may be blank.",
			reasoningOnlyOff: "Model {id} declares off only: tick one more thinking level, or leave every row unticked.",
			importButton: "Import",
			importing: "Writing…",
			previewTitle: "Provider to write (llm-pi-ai › config › providers › {id})",
			done: "Imported provider {id} ({count} models) with credential reference {ref}.",
			keyStored: "The key was written to .credentials.yaml.",
			keyFromEnvironment: "Credential reference {ref} comes from the launching environment, so .credentials.yaml was left alone; change the environment variable instead.",
			keyWriteFailed: "The provider was written, but storing the key failed ({ref}): {message}",
			errorNoNamespace: "No llm-pi-ai settings namespace was found in this profile.",
		};

		/* ------------------------------------------------------------------ */
		/* 设置页                                                              */
		/* ------------------------------------------------------------------ */

		/**
		 * 造出设置页组件（闭包持有 ctx 与 t）。
		 * @param ctx - 客户端插件上下文。
		 * @param t - 本插件的翻译函数。
		 * @returns 组件函数。
		 */
		function createSettingsPage(ctx, t) {
			return function SettingsPage() {
				const [raw, setRaw] = useState("");
				const [url, setUrl] = useState("");
				const [key, setKey] = useState("");
				const [providerId, setProviderId] = useState("");
				const [displayName, setDisplayName] = useState("");
				const [protocol, setProtocol] = useState(PROTOCOLS[0].api);
				const [baseURLDraft, setBaseURLDraft] = useState(undefined);
				const [discovered, setDiscovered] = useState([]);
				const [selected, setSelected] = useState(() => new Set());
				const [query, setQuery] = useState("");
				const [capacities, setCapacities] = useState({});
				const [names, setNames] = useState({});
				const [inputs, setInputs] = useState({});
				const [efforts, setEfforts] = useState({});
				const [target, setTarget] = useState(undefined);
				const [credential, setCredential] = useState(undefined);
				const [fetching, setFetching] = useState(false);
				const [importing, setImporting] = useState(false);
				const [failure, setFailure] = useState(undefined);
				const [notice, setNotice] = useState(undefined);
				const [done, setDone] = useState(undefined);
				const suggestion = useRef("");

				const parsed = useMemo(() => parseConnection(raw), [raw]);
				const baseURL = baseURLDraft === undefined ? deriveBaseURL(url, protocol) : baseURLDraft;
				const keyRef = PROVIDER_ID_PATTERN.test(providerId) ? keyRefOf(providerId) : "";
				const baseURLInvalid = baseURL.length === 0 || !/^https?:\/\//i.test(baseURL);
				const idInvalid = providerId.length > 0 && !PROVIDER_ID_PATTERN.test(providerId);
				const existingIds = target === undefined ? [] : target.ids;
				const idTaken = providerId.length > 0 && existingIds.includes(providerId);
				const orderedSelection = useMemo(
					() => discovered.filter((model) => selected.has(model.id)).map((model) => model.id),
					[discovered, selected],
				);
				const visible = useMemo(() => {
					const needle = query.trim().toLowerCase();
					if (needle.length === 0) return discovered;
					return discovered.filter(
						(model) =>
							model.id.toLowerCase().includes(needle) ||
							(typeof model.name === "string" && model.name.toLowerCase().includes(needle)),
					);
				}, [discovered, query]);
				const capacityFailure = useMemo(
					() => firstCapacityFailure(orderedSelection, capacities),
					[orderedSelection, capacities],
				);
				/* 每个勾选模型的档位行，供校验、预览与导入共用。 */
				const effortRowsById = useMemo(() => {
					const map = {};
					for (const id of orderedSelection) map[id] = effortRows(id);
					return map;
				}, [orderedSelection, efforts]);
				const reasoningFailure = useMemo(
					() => firstReasoningFailure(orderedSelection, effortRowsById),
					[orderedSelection, effortRowsById],
				);

				/* 粘贴后自动填入 url 与密钥。 */
				useEffect(() => {
					if (parsed.kind === "ok") {
						setUrl(parsed.url);
						setKey(parsed.key);
					}
				}, [parsed]);

				/* url 变化时同步候选 id（用户一旦改过就不再自动覆盖）。 */
				useEffect(() => {
					if (providerId !== "" && providerId !== suggestion.current) return;
					const next = suggestProviderId(url);
					suggestion.current = next;
					setProviderId(next);
				}, [url]);

				/* url 或协议变了就重新推导 baseURL，丢掉手改的值。 */
				useEffect(() => {
					setBaseURLDraft(undefined);
				}, [url, protocol]);

				/* 读一次已有的供应商，用来判断 id 是否重复。 */
				const refreshTarget = useCallback(async () => {
					try {
						const ns = await resolveSettingsNs(ctx);
						setTarget({ ns, ids: providerIdsOf(await readNamespace(ctx, ns)) });
					} catch (error) {
						setTarget(undefined);
					}
				}, [ctx]);

				useEffect(() => {
					void refreshTarget();
				}, [refreshTarget]);

				/* 看这个密钥引用是不是已经由环境变量提供。 */
				useEffect(() => {
					if (keyRef.length === 0) {
						setCredential(undefined);
						return undefined;
					}
					let current = true;
					let described;
					try {
						described = ctx.remote.credentials.describe([keyRef]);
					} catch (error) {
						/* Remote 不可用时不要连页面一起挂掉，按“未知”处理。 */
						setCredential(undefined);
						return undefined;
					}
					if (described === undefined || typeof described.then !== "function") {
						setCredential(undefined);
						return undefined;
					}
					described
						.then((response) => {
							if (current) setCredential(response.ok ? response.value[keyRef] : undefined);
						})
						.catch(() => {
							if (current) setCredential(undefined);
						});
					return () => {
						current = false;
					};
				}, [ctx, keyRef]);

				/** 拉取模型列表。 */
				const fetchModels = async () => {
					setFetching(true);
					setFailure(undefined);
					setNotice(undefined);
					setDone(undefined);
					try {
						const ns = await resolveSettingsNs(ctx);
						const response = await ctx.remote.llm.discoverModels(ns, {
							baseURL,
							api: protocol,
							apiKey: key,
						});
						if (!response.ok) {
							setFailure(response.error.message);
							return;
						}
						const list = response.value.slice().sort((left, right) => left.id.localeCompare(right.id));
						setDiscovered(list);
						setSelected(new Set());
						setCapacities({});
						setNames({});
						setInputs({});
						setEfforts({});
						setQuery("");
						setNotice(list.length === 0 ? t("modelsNone") : t("modelsFound", { count: list.length }));
					} catch (error) {
						setFailure(error instanceof Error ? error.message : String(error));
					} finally {
						setFetching(false);
					}
				};

				/** 勾选 / 取消一个模型。 */
				const toggle = (id) => {
					setSelected((current) => {
						const next = new Set(current);
						if (!next.delete(id)) next.add(id);
						return next;
					});
				};

				/** 勾选当前搜索结果里的全部模型。 */
				const selectAll = () => {
					setSelected((current) => new Set([...current, ...visible.map((model) => model.id)]));
				};

				/** 在搜索结果范围内反选。 */
				const invertSelection = () => {
					setSelected((current) => {
						const next = new Set(current);
						for (const model of visible) {
							if (!next.delete(model.id)) next.add(model.id);
						}
						return next;
					});
				};

				/** 清空全部勾选。 */
				const selectNone = () => {
					setSelected(new Set());
				};

				/** 改一格容量输入。 */
				const editCapacity = (id, field, value) => {
					setCapacities((current) => ({ ...current, [`${id}:${field}`]: value }));
				};

				/** 改一个模型的显示名（不是 id）。 */
				const editName = (id, value) => {
					setNames((current) => ({ ...current, [id]: value }));
				};

				/* 下面几个用函数声明而不是箭头常量：上面的 useMemo 在渲染中途就
				   会调用它们，函数声明有提升，不会踩到暂时性死区。 */

				/** 一个模型当前勾选的输入模态（没碰过就用目录给的默认值）。 */
				function selectedInputs(id) {
					const stored = inputs[id];
					if (stored !== undefined) return stored;
					return defaultInputsFor(discovered.find((candidate) => candidate.id === id));
				}

				/** 勾选 / 取消一个输入模态。 */
				function toggleInput(id, modality) {
					setInputs((current) => {
						const before = current[id] === undefined ? selectedInputs(id) : current[id];
						const next = before.includes(modality)
							? before.filter((item) => item !== modality)
							: [...before, modality];
						return { ...current, [id]: MODALITIES.filter((item) => next.includes(item)) };
					});
				}

				/** 一个模型的档位行：没碰过的行是未勾选、键与值与预设一致。 */
				function effortRows(id) {
					const stored = efforts[id] === undefined ? {} : efforts[id];
					return EFFORT_PRESETS.map((preset) => {
						const row = stored[preset.key];
						return {
							preset: preset.key,
							label: preset.label,
							on: row === undefined ? false : row.on,
							key: row === undefined ? preset.key : row.key,
							value: row === undefined ? preset.value : row.value,
						};
					});
				}

				/** 改一行档位（勾选、键名或要发送的值）。 */
				function editEffort(id, preset, patch) {
					setEfforts((current) => {
						const forId = current[id] === undefined ? {} : current[id];
						const base = EFFORT_PRESETS.find((item) => item.key === preset);
						const before = forId[preset] === undefined ? { on: false, key: base.key, value: base.value } : forId[preset];
						return { ...current, [id]: { ...forId, [preset]: { ...before, ...patch } } };
					});
				}

				/** 档位预设的界面名字。 */
				function presetLabel(preset) {
					const found = EFFORT_PRESETS.find((item) => item.key === preset);
					return found === undefined ? preset : t(found.label);
				}

				/** 把档位校验结果翻成一句提示。 */
				function reasoningMessage(failure) {
					const level = presetLabel(failure.preset);
					if (failure.detail === "emptyKey") return t("reasoningEmptyKey", { id: failure.id, level });
					if (failure.detail === "unknownKey") {
						return t("reasoningUnknownKey", { id: failure.id, level, key: failure.key, allowed: t("reasoningAllowed") });
					}
					if (failure.detail === "duplicateKey") return t("reasoningDuplicateKey", { id: failure.id, key: failure.key });
					if (failure.detail === "emptyValue") return t("reasoningEmptyValue", { id: failure.id, level });
					return t("reasoningOnlyOff", { id: failure.id });
				}

				const canFetch = !baseURLInvalid && key.length > 0 && !fetching && !importing;
				const blocker =
					providerId.length === 0
						? t("providerIdRequired")
						: idInvalid
							? t("providerIdInvalid")
							: idTaken
								? t("providerIdTaken")
								: baseURLInvalid
									? t("baseUrlInvalid")
									: key.length === 0
										? t("modelsNeedTarget")
										: orderedSelection.length === 0
											? t("capacityNone")
											: capacityFailure !== undefined
												? t("capacityInvalid", {
														id: capacityFailure.id,
														field: capacityFailure.field === "contextWindow" ? t("capacityFieldContext") : t("capacityFieldOutput"),
													})
												: reasoningFailure !== undefined
													? reasoningMessage(reasoningFailure)
													: undefined;
				const canImport = blocker === undefined && !importing;

				/* 只有字段都合法时才构造预览，避免把半成品对象展示给用户。 */
				const preview =
					blocker === undefined
						? buildProfile({
								providerId,
								displayName: displayName.trim(),
								api: protocol,
								baseURL,
								ids: orderedSelection,
								discovered,
								capacities,
								names,
								inputs,
								efforts: effortRowsById,
							})
						: undefined;

				/** 写入供应商 + 密钥。 */
				const runImport = async () => {
					setImporting(true);
					setFailure(undefined);
					setNotice(undefined);
					setDone(undefined);
					const id = providerId;
					const ref = keyRefOf(id);
					try {
						const ns = await resolveSettingsNs(ctx);
						const before = await readNamespace(ctx, ns);
						if (before === undefined) {
							setFailure(t("errorNoNamespace"));
							return;
						}
						const profile = buildProfile({
							providerId: id,
							displayName: displayName.trim(),
							api: protocol,
							baseURL,
							ids: orderedSelection,
							discovered,
							capacities,
							names,
							inputs,
							efforts: effortRowsById,
						});
						const ops = [{ op: "set", path: ["providers", id], value: profile }];
						let written = await ctx.remote.settings.mutate(ns, ops, before.revision);
						if (!written.ok && written.error.code === "settings/conflict") {
							const fresh = await readNamespace(ctx, ns);
							written = await ctx.remote.settings.mutate(ns, ops, fresh === undefined ? undefined : fresh.revision);
						}
						if (!written.ok) {
							setFailure(written.error.message);
							return;
						}
						const described = await ctx.remote.credentials.describe([ref]);
						const info = described.ok ? described.value[ref] : undefined;
						if (info !== undefined && info.writable === false) {
							setNotice(t("keyFromEnvironment", { ref }));
						} else {
							const stored = await ctx.remote.credentials.set(ref, key);
							if (!stored.ok) setNotice(t("keyWriteFailed", { ref, message: stored.error.message }));
						}
						setDone(t("done", { id, count: orderedSelection.length, ref }));
						setRaw("");
						setUrl("");
						setKey("");
						setProviderId("");
						setDisplayName("");
						setDiscovered([]);
						setSelected(new Set());
						setCapacities({});
						setNames({});
						setInputs({});
						setEfforts({});
						setQuery("");
						await refreshTarget();
					} catch (error) {
						setFailure(error instanceof Error ? error.message : String(error));
					} finally {
						setImporting(false);
					}
				};

				const statusOf = () => {
					if (parsed.kind === "empty") return { className: "dsh-import-newapi-hint", text: t("connectionEmpty") };
					if (parsed.kind === "ok") return { className: "dsh-import-newapi-ok", text: t("connectionOk") };
					return { className: "dsh-import-newapi-error", text: t(parsed.reason) };
				};
				const status = statusOf();

				return h(
					"section",
					{ className: "dsh-import-newapi-section" },
					h("h2", { className: "dsh-import-newapi-title" }, t("title")),
					h("p", { className: "dsh-import-newapi-intro" }, t("intro")),

					/* 1 连接信息 */
					h(
						"div",
						{ className: "dsh-import-newapi-step" },
						h(
							"div",
							{ className: "dsh-import-newapi-stepHead" },
							h("span", { className: "dsh-import-newapi-stepIndex" }, "1"),
							h("span", { className: "dsh-import-newapi-stepTitle" }, t("stepConnection")),
						),
						h(
							"label",
							{ className: "dsh-import-newapi-field" },
							h("span", { className: "dsh-import-newapi-label" }, t("connectionLabel")),
							h("textarea", {
								className: "dsh-import-newapi-textarea",
								rows: 3,
								spellCheck: false,
								placeholder: t("connectionPlaceholder"),
								value: raw,
								onChange: (event) => setRaw(event.target.value),
							}),
							h("span", { className: status.className }, status.text),
						),
						h(
							"div",
							{ className: "dsh-import-newapi-grid" },
							h(
								"label",
								{ className: "dsh-import-newapi-field" },
								h("span", { className: "dsh-import-newapi-label" }, t("urlLabel")),
								h("input", {
									className: "dsh-import-newapi-input",
									type: "text",
									spellCheck: false,
									placeholder: "https://gateway.example",
									value: url,
									onChange: (event) => setUrl(event.target.value),
								}),
							),
							h(
								"label",
								{ className: "dsh-import-newapi-field" },
								h("span", { className: "dsh-import-newapi-label" }, t("keyLabel")),
								h("input", {
									className: "dsh-import-newapi-input",
									type: "password",
									autoComplete: "off",
									placeholder: t("keyPlaceholder"),
									value: key,
									onChange: (event) => setKey(event.target.value),
								}),
							),
						),
					),

					/* 2 供应商 */
					h(
						"div",
						{ className: "dsh-import-newapi-step" },
						h(
							"div",
							{ className: "dsh-import-newapi-stepHead" },
							h("span", { className: "dsh-import-newapi-stepIndex" }, "2"),
							h("span", { className: "dsh-import-newapi-stepTitle" }, t("stepProvider")),
						),
						h(
							"div",
							{ className: "dsh-import-newapi-grid" },
							h(
								"label",
								{ className: "dsh-import-newapi-field" },
								h("span", { className: "dsh-import-newapi-label" }, t("providerIdLabel")),
								h("input", {
									className: "dsh-import-newapi-input",
									type: "text",
									spellCheck: false,
									placeholder: t("providerIdPlaceholder"),
									value: providerId,
									onChange: (event) => setProviderId(event.target.value),
								}),
								idInvalid
									? h("span", { className: "dsh-import-newapi-error" }, t("providerIdInvalid"))
									: idTaken
										? h("span", { className: "dsh-import-newapi-error" }, t("providerIdTaken"))
										: null,
							),
							h(
								"label",
								{ className: "dsh-import-newapi-field" },
								h("span", { className: "dsh-import-newapi-label" }, t("displayNameLabel")),
								h("input", {
									className: "dsh-import-newapi-input",
									type: "text",
									spellCheck: false,
									placeholder: t("displayNamePlaceholder"),
									value: displayName,
									onChange: (event) => setDisplayName(event.target.value),
								}),
							),
						),
						h(
							"label",
							{ className: "dsh-import-newapi-field" },
							h("span", { className: "dsh-import-newapi-label" }, t("protocolLabel")),
							h(
								"select",
								{
									className: "dsh-import-newapi-select",
									value: protocol,
									onChange: (event) => setProtocol(event.target.value),
								},
								PROTOCOLS.map((option) => h("option", { key: option.api, value: option.api }, t(option.label))),
							),
						),
						h(
							"label",
							{ className: "dsh-import-newapi-field" },
							h("span", { className: "dsh-import-newapi-label" }, t("baseUrlLabel")),
							h("input", {
								className: "dsh-import-newapi-input",
								type: "text",
								spellCheck: false,
								value: baseURL,
								onChange: (event) => setBaseURLDraft(event.target.value),
							}),
							baseURLInvalid ? h("span", { className: "dsh-import-newapi-error" }, t("baseUrlInvalid")) : null,
						),
						h(
							"div",
							{ className: "dsh-import-newapi-field" },
							h("span", { className: "dsh-import-newapi-label" }, t("keyRefLabel")),
							h(
								"div",
								{ className: "dsh-import-newapi-toolbar" },
								h("code", { className: "dsh-import-newapi-code" }, keyRef.length === 0 ? "—" : keyRef),
								h(
									"span",
									{ className: "dsh-import-newapi-hint" },
									credential !== undefined && credential.writable === false ? t("keyRefReadonly") : t("keyRefWritable"),
								),
							),
						),
						h(
							"p",
							{ className: "dsh-import-newapi-hint" },
							t("existingLabel"),
							existingIds.length === 0 ? t("existingEmpty") : existingIds.join(", "),
						),
					),

					/* 3 模型 */
					h(
						"div",
						{ className: "dsh-import-newapi-step" },
						h(
							"div",
							{ className: "dsh-import-newapi-stepHead" },
							h("span", { className: "dsh-import-newapi-stepIndex" }, "3"),
							h("span", { className: "dsh-import-newapi-stepTitle" }, t("stepModels")),
						),
						h(
							"div",
							{ className: "dsh-import-newapi-toolbar" },
							h(
								"button",
								{
									type: "button",
									className: "dsh-import-newapi-button",
									disabled: !canFetch,
									onClick: () => void fetchModels(),
								},
								fetching ? t("fetching") : t("fetchModels"),
							),
							!canFetch && !fetching
								? h("span", { className: "dsh-import-newapi-hint" }, t("modelsNeedTarget"))
								: null,
						),
						discovered.length === 0
							? h("p", { className: "dsh-import-newapi-hint" }, t("modelsEmpty"))
							: h(
									React.Fragment,
									null,
									h(
										"div",
										{ className: "dsh-import-newapi-toolbar" },
										h("input", {
											className: "dsh-import-newapi-input",
											type: "search",
											style: { flex: "1 1 200px" },
											placeholder: t("searchPlaceholder"),
											value: query,
											onChange: (event) => setQuery(event.target.value),
										}),
										h(
											"button",
											{ type: "button", className: "dsh-import-newapi-button", onClick: selectAll },
											t("selectAll"),
										),
										h(
											"button",
											{ type: "button", className: "dsh-import-newapi-button", onClick: invertSelection },
											t("invertSelection"),
										),
										h(
											"button",
											{ type: "button", className: "dsh-import-newapi-button", onClick: selectNone },
											t("selectNone"),
										),
										h(
											"span",
											{ className: "dsh-import-newapi-count" },
											t("selectedCount", { count: selected.size, total: discovered.length }),
										),
									),
									h(
										"div",
										{ className: "dsh-import-newapi-list" },
										visible.map((model) =>
											h(
												"label",
												{ key: model.id, className: "dsh-import-newapi-item" },
												h("input", {
													type: "checkbox",
													checked: selected.has(model.id),
													onChange: () => toggle(model.id),
												}),
												h("span", { className: "dsh-import-newapi-itemId" }, model.id),
												typeof model.name === "string" && model.name.length > 0 && model.name !== model.id
													? h("span", { className: "dsh-import-newapi-itemName" }, model.name)
													: null,
											),
										),
									),
								),
					),

					/* 4 容量 */
					h(
						"div",
						{ className: "dsh-import-newapi-step" },
						h(
							"div",
							{ className: "dsh-import-newapi-stepHead" },
							h("span", { className: "dsh-import-newapi-stepIndex" }, "4"),
							h("span", { className: "dsh-import-newapi-stepTitle" }, t("stepCapacity")),
						),
						h("p", { className: "dsh-import-newapi-hint" }, t("capacityHint")),
						orderedSelection.length === 0
							? h("p", { className: "dsh-import-newapi-hint" }, t("capacityNone"))
							: h(
									"div",
									{ className: "dsh-import-newapi-scroll" },
									h(
										"div",
										{ className: "dsh-import-newapi-capHead" },
										h("span", null, t("capacityHeaderModel")),
										h("span", null, t("capacityHeaderName")),
										h("span", null, t("capacityHeaderContext")),
										h("span", null, t("capacityHeaderOutput")),
									),
									orderedSelection.map((id) => {
										const model = discovered.find((candidate) => candidate.id === id);
										return h(
											"div",
											{ key: id, className: "dsh-import-newapi-capRow" },
											h("span", { className: "dsh-import-newapi-capId" }, id),
											h("input", {
												className: "dsh-import-newapi-input",
												type: "text",
												spellCheck: false,
												placeholder:
													model === undefined || typeof model.name !== "string" || model.name.length === 0
														? t("namePlaceholder")
														: model.name,
												value: names[id] ?? (model === undefined || typeof model.name !== "string" ? "" : model.name),
												onChange: (event) => editName(id, event.target.value),
											}),
											h("input", {
												className: "dsh-import-newapi-input",
												type: "text",
												inputMode: "numeric",
												spellCheck: false,
												placeholder:
													model === undefined ? t("capacityPlaceholder") : formatCapacity(model.contextWindow) || t("capacityPlaceholder"),
												value: capacities[`${id}:contextWindow`] ?? "",
												onChange: (event) => editCapacity(id, "contextWindow", event.target.value),
											}),
											h("input", {
												className: "dsh-import-newapi-input",
												type: "text",
												inputMode: "numeric",
												spellCheck: false,
												placeholder:
													model === undefined ? t("capacityPlaceholder") : formatCapacity(model.maxTokens) || t("capacityPlaceholder"),
												value: capacities[`${id}:maxTokens`] ?? "",
												onChange: (event) => editCapacity(id, "maxTokens", event.target.value),
											}),
										);
									}),
								),
					),

					/* 5 输入格式与思考强度 */
					h(
						"div",
						{ className: "dsh-import-newapi-step" },
						h(
							"div",
							{ className: "dsh-import-newapi-stepHead" },
							h("span", { className: "dsh-import-newapi-stepIndex" }, "5"),
							h("span", { className: "dsh-import-newapi-stepTitle" }, t("stepCapability")),
						),
						h("p", { className: "dsh-import-newapi-hint" }, t("capabilityHint")),
						orderedSelection.length === 0
							? h("p", { className: "dsh-import-newapi-hint" }, t("capabilityNone"))
							: h(
									"div",
									{ className: "dsh-import-newapi-scroll" },
									orderedSelection.map((id) => {
										const model = discovered.find((candidate) => candidate.id === id);
										const rows = effortRowsById[id] === undefined ? [] : effortRowsById[id];
										const failure = reasoningFailure !== undefined && reasoningFailure.id === id ? reasoningFailure : undefined;
										return h(
											"div",
											{ key: id, className: "dsh-import-newapi-capability" },
											h(
												"div",
												{ className: "dsh-import-newapi-capabilityHead" },
												h("code", { className: "dsh-import-newapi-code" }, id),
												model !== undefined && typeof model.name === "string" && model.name.length > 0 && model.name !== id
													? h("span", { className: "dsh-import-newapi-itemName" }, model.name)
													: null,
											),
											h(
												"div",
												{ className: "dsh-import-newapi-modalities" },
												h("span", { className: "dsh-import-newapi-label" }, t("inputFormatLabel")),
												MODALITIES.map((modality) =>
													h(
														"label",
														{ key: modality, className: "dsh-import-newapi-modality" },
														h("input", {
															type: "checkbox",
															checked: selectedInputs(id).includes(modality),
															onChange: () => toggleInput(id, modality),
														}),
														h("span", null, t(modality === "text" ? "modalityText" : "modalityImage")),
													),
												),
												h("span", { className: "dsh-import-newapi-hint" }, t("inputFormatHint")),
											),
											rows.map((row) =>
												h(
													"div",
													{
														key: row.preset,
														className: `dsh-import-newapi-effortRow dsh-import-newapi-effortRow-${row.preset}`,
													},
													h(
														"label",
														{ className: "dsh-import-newapi-effortToggle" },
														h("input", {
															type: "checkbox",
															checked: row.on,
															onChange: () => editEffort(id, row.preset, { on: !row.on }),
														}),
														h("span", null, t(row.label)),
													),
													h("input", {
														className: "dsh-import-newapi-input",
														type: "text",
														spellCheck: false,
														disabled: !row.on,
														placeholder: row.preset,
														value: row.key,
														onChange: (event) => editEffort(id, row.preset, { key: event.target.value }),
													}),
													h("span", { className: "dsh-import-newapi-effortColon" }, ":"),
													h("input", {
														className: "dsh-import-newapi-input",
														type: "text",
														spellCheck: false,
														disabled: !row.on,
														placeholder: row.preset === "off" ? t("effortOffPlaceholder") : t("effortValuePlaceholder"),
														value: row.value,
														onChange: (event) => editEffort(id, row.preset, { value: event.target.value }),
													}),
												),
											),
											failure === undefined
												? null
												: h("p", { className: "dsh-import-newapi-error" }, reasoningMessage(failure)),
										);
									}),
								),
					),

					/* 写入 */
					h(
						"div",
						{ className: "dsh-import-newapi-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsh-import-newapi-button dsh-import-newapi-buttonPrimary",
								disabled: !canImport,
								onClick: () => void runImport(),
							},
							importing ? t("importing") : t("importButton"),
						),
						blocker === undefined ? null : h("span", { className: "dsh-import-newapi-hint" }, blocker),
					),
					failure === null || failure === undefined ? null : h("p", { className: "dsh-import-newapi-error" }, failure),
					notice === null || notice === undefined ? null : h("p", { className: "dsh-import-newapi-warn" }, notice),
					done === null || done === undefined ? null : h("p", { className: "dsh-import-newapi-ok" }, done),
					preview === undefined
						? null
						: h(
								"details",
								{ className: "dsh-import-newapi-preview" },
								h("summary", null, t("previewTitle", { id: providerId })),
								h("pre", null, JSON.stringify({ providers: { [providerId]: preview } }, null, 2)),
							),
				);
			};
		}

		/* ------------------------------------------------------------------ */
		/* 插件入口                                                            */
		/* ------------------------------------------------------------------ */

		/** 需要的客户端服务：插槽、文案，以及三个 Remote 命名空间。 */
		const inject = ["slots", "locale", "remote", "remote.settings", "remote.credentials", "remote.llm"];

		/**
		 * 注册设置页。
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			installStyles();
			ctx.effect(() => ctx.locale.register(NAME, { zh, en }), "dsh-import-newapi: dictionaries");
			const t = ctx.locale.bind(NAME);
			const SettingsPage = createSettingsPage(ctx, t);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "import-newapi",
						order: SECTION_ORDER,
						label: () => t("nav"),
						locale: NAME,
					},
					() => h(SettingsPage, null),
				),
			);
		}

		/**
		 * 供离线测试与排查使用的内部引用。
		 * 插件运行时不需要它，改动这些函数不会影响 DSH 本体。
		 */
		const __internals = {
			NAME: NAME,
			SECTION_ORDER: SECTION_ORDER,
			CONNECTION_TYPE: CONNECTION_TYPE,
			PROVIDER_ID_PATTERN: PROVIDER_ID_PATTERN,
			PI_AI_PACKAGE: PI_AI_PACKAGE,
			PI_AI_FALLBACK_NS: PI_AI_FALLBACK_NS,
			PROTOCOLS: PROTOCOLS,
			CSS_TAG_ID: CSS_TAG_ID,
			MODALITIES: MODALITIES,
			DEFAULT_INPUT: DEFAULT_INPUT,
			THINKING_LEVELS: THINKING_LEVELS,
			EFFORT_PRESETS: EFFORT_PRESETS,
			stripTrailingSlashes: stripTrailingSlashes,
			deriveBaseURL: deriveBaseURL,
			keyRefOf: keyRefOf,
			parseConnection: parseConnection,
			suggestProviderId: suggestProviderId,
			parseCapacity: parseCapacity,
			formatCapacity: formatCapacity,
			defaultInputsFor: defaultInputsFor,
			buildInput: buildInput,
			buildReasoningEfforts: buildReasoningEfforts,
			firstReasoningFailure: firstReasoningFailure,
			firstCapacityFailure: firstCapacityFailure,
			buildModelEntries: buildModelEntries,
			buildProfile: buildProfile,
			resolveSettingsNs: resolveSettingsNs,
			readNamespace: readNamespace,
			providerIdsOf: providerIdsOf,
			createSettingsPage: createSettingsPage,
			dictionaries: { zh: zh, en: en },
		};

		module.exports = { name: NAME, inject: inject, apply: apply, __internals: __internals };
		return module.exports;
	},
});
