/**
 * dsh-import-newapi —— 宿主半边。
 *
 * 这个插件真正的写盘动作全部发生在浏览器半边：它通过 DSH 已经注册好的
 * Remote（`settings.mutate` 与 `credentials.set`）提交改动，因此
 *
 *   - 供应商写进当前 profile 的 `cordis.patch.yml`（`llm-pi-ai` 条目的
 *     `config.providers` 下），由 config-editor 负责加锁、校验与原子写入；
 *   - 密钥写进 `$DSH_HOME/.credentials.yaml` 的 `refs:` 映射。
 *
 * 宿主半边不注册任何 HTTP 路由、不自己解析 YAML。它只做两件事：
 *
 *   1. 挂载自检：确认当前 profile 里确实存在 `@deepseek-ai/dsh-llm-pi-ai`
 *      这个条目，并把它的条目 id（即设置命名空间）写进日志。这样一个配置
 *      不对的 profile 会在启动日志里直接说明原因，而不是让设置页报一句
 *      看不懂的错误。
 *
 *   2. 把空的 `refs: {}` 归一化成块状写法。凭据提供者用「解析成 YAML 文档
 *      → 在原文档上增量改一个键 → 渲染回去」的方式写盘，格式基本原样保留；
 *      于是当文件里只剩一个空的流式映射时，后写入的密钥也只能挤在同一行：
 *
 *          refs: { COTTON_API_API_KEY: sk-… }
 *
 *      而把这一行删掉之后，它会新建一个块状映射，写成
 *
 *          refs:
 *            COTTON_API_API_KEY: sk-…
 *
 *      两种写法在提供者眼里完全等价（它把「缺失」和「null」都当成空段，
 *      见 dsh-credentials-local 的 `asSection`），所以这里只删一个空键，
 *      不动任何值 —— 值永远由 `credentials.set` 写。直接编辑该文件是提供者
 *      明确支持的用法：它有文件监视器，改完会整体重载并接收变更。
 *
 * 凭据文档的位置按可信度问三次：活着的凭据服务（它自己解析出来的路径）、
 * 进程环境里的 `$DSH_HOME`、以及加载基点 `<home>/profiles/<profile>` 反推
 * 出来的 home；三者都落空时再退回 `~/.dsh`。只有确实是版本 1 的凭据文档
 * （含 `version: 1`）才会被碰，绝不误改同名的别的文件。
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 插件名（Cordis 用它做条目 id 与诊断前缀）。 */
export const name = "dsh-import-newapi";

/** 只依赖 config-editor：它是本插件唯一的宿主侧信息源。 */
export const inject = ["configEditor"];

/** 目标适配器的包名。 */
const PI_AI_PACKAGE = "@deepseek-ai/dsh-llm-pi-ai";

/** 凭据文档的文件名。 */
const CREDENTIALS_FILENAME = ".credentials.yaml";

/** 版本戳那一行（允许行尾注释），用来确认这确实是一份凭据文档。 */
const VERSION_LINE = /^version:[ \t]*1[ \t]*(?:#.*)?\r?$/m;

/** 空的 `refs` 流式映射那一行（允许行尾注释）。 */
const EMPTY_REFS_LINE = /^refs:[ \t]*\{[ \t]*\}[ \t]*(?:#.*)?\r?$/;

/** 文件事件合并窗口：等提供者写完再看一眼，避免与它抢同一个文件。 */
const SETTLE_MS = 200;

/**
 * 活着的凭据服务自己报的文档路径。
 * @param ctx - 插件上下文（可选）。
 * @returns 绝对路径，或 `undefined`（服务还没起来、或换了别的实现）。
 */
export function liveCredentialsFile(ctx) {
	try {
		const filename = ctx?.get?.("credentials")?.spec?.filename;
		return typeof filename === "string" && filename.length > 0 ? filename : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 所有可能指向凭据文档的路径，按可信度排列并去重。
 * @param ctx - 插件上下文（可选）。
 * @returns 绝对路径数组（可能为空）。
 */
export function credentialsFileCandidates(ctx) {
	const candidates = [];
	const live = liveCredentialsFile(ctx);
	if (live !== undefined) candidates.push(live);
	const home = process.env.DSH_HOME;
	if (typeof home === "string" && home.trim().length > 0) {
		candidates.push(join(home.trim(), CREDENTIALS_FILENAME));
	}
	// DSH 以 <harness home>/profiles/<profile> 作为加载基点。
	const base = ctx?.baseDir;
	if (typeof base === "string" && base.trim().length > 0) {
		candidates.push(join(dirname(dirname(base.trim())), CREDENTIALS_FILENAME));
	}
	try {
		candidates.push(join(homedir(), ".dsh", CREDENTIALS_FILENAME));
	} catch {
		/* 取不到家目录就当没有这个候选。 */
	}
	return [...new Set(candidates)];
}

/**
 * 挑出第一份真实存在的凭据文档。
 * @param ctx - 插件上下文（可选）。
 * @returns 绝对路径，或 `undefined`。
 */
export function pickCredentialsFile(ctx) {
	return credentialsFileCandidates(ctx).filter((file) => existsSync(file))[0];
}

/**
 * 目录存在吗（`fs.watch` 与 `statSync` 都只认真实目录）。
 * @param directory - 绝对路径。
 * @returns 是否是目录。
 */
function hasDirectory(directory) {
	try {
		return statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 把空的 `refs: {}` 那一行删掉，其它字节原样保留。
 *
 * 只在「确实是一份版本 1 的凭据文档」「确实存在空的 refs 流式映射」
 * 「复读一遍确认没有被别人改写」三个条件同时成立时才落盘，并且用
 * 同目录临时文件 + 改名的方式原子替换，绝不覆盖并发写入的内容。
 *
 * @param filename - 凭据文档的绝对路径。
 * @returns 是否真的改写了文件。
 */
export function normalizeEmptyRefs(filename) {
	let text;
	try {
		text = readFileSync(filename, "utf8");
	} catch {
		return false; // 文件还不存在（或读不动）：不是本插件该管的事。
	}
	if (!VERSION_LINE.test(text)) return false; // 不像凭据文档，绝不碰。
	const lines = text.split("\n");
	// 行尾的 `\r` 只是换行符的一部分，匹配和保留都要先把它摘掉。
	const kept = lines.filter((line) => !EMPTY_REFS_LINE.test(line.replace(/\r$/, "")));
	if (kept.length === lines.length) return false; // 没有空的 refs，收工。
	let settled;
	try {
		settled = readFileSync(filename, "utf8");
	} catch {
		return false;
	}
	if (settled !== text) return false; // 中间有人写过：让给下一次事件。
	let mode = 0o600;
	try {
		mode = statSync(filename).mode & 0o777;
	} catch {
		/* 拿不到权限位就用提供者的默认值。 */
	}
	const temporary = `${filename}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, kept.join("\n"), { mode: mode === 0 ? 0o600 : mode });
		renameSync(temporary, filename);
		return true;
	} catch {
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* 清理失败就算了。 */
		}
		return false;
	}
}

/**
 * 报告目标条目是否存在。
 * @param ctx - 插件上下文，`configEditor` 已由 `inject` 保证可用。
 */
function reportTarget(ctx) {
	try {
		const entry = ctx.configEditor
			.entries()
			.find((row) => row.options.name === PI_AI_PACKAGE);
		if (entry === undefined) {
			ctx.logger.warn(
				"dsh-import-newapi: 当前 profile 没有 %s 条目，设置页没有任何可写入的命名空间；请先在 profile 里启用该适配器。",
				PI_AI_PACKAGE,
			);
			return;
		}
		ctx.logger.info(
			"dsh-import-newapi: 就绪，目标条目 id = %s（设置命名空间），供应商将写在 config.providers 下。",
			entry.options.id,
		);
	} catch (error) {
		ctx.logger.warn("dsh-import-newapi: 挂载自检失败：%s", String(error?.message ?? error));
	}
}

/**
 * 挂载插件：自检 + 归一化一次 + 盯住那份文件所在的目录，别让空的 `refs: {}` 回来。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
	reportTarget(ctx);
	// 凭据服务活着时它说了算：只照看它自己那份文件，不去碰同名的陈旧副本。
	// 服务不在时也只认第一份真实存在的候选，找不到就什么都不做。
	const live = liveCredentialsFile(ctx);
	const files = live !== undefined ? [live] : [pickCredentialsFile(ctx)].filter(Boolean);
	const directories = [...new Set(files.map((file) => dirname(file)))].filter(hasDirectory);
	const normalize = (reason) => {
		for (const file of files) {
			try {
				if (normalizeEmptyRefs(file)) {
					ctx.logger.info(
						"dsh-import-newapi: %s 里空的 `refs: {}` 已按%s改成块状 `refs:` 段，新密钥会缩进写在里面。",
						file,
						reason,
					);
				}
			} catch (error) {
				ctx.logger.warn(
					"dsh-import-newapi: 归一化 %s 失败：%s",
					file,
					String(error?.message ?? error),
				);
			}
		}
	};
	normalize("挂载时的写法");
	if (typeof ctx.effect !== "function") return;
	if (directories.length === 0) {
		ctx.logger.warn(
			"dsh-import-newapi: 既没有凭据服务报的路径，也找不到任何一份真实存在的 %s 候选，跳过空 refs 的归一化。",
			CREDENTIALS_FILENAME,
		);
		return;
	}
	ctx.effect(() => {
		let timer;
		const watchers = [];
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(() => normalize("热重载后的写法"), SETTLE_MS);
			// 监视器不该拖住进程退出。
			if (typeof timer.unref === "function") timer.unref();
		};
		for (const directory of directories) {
			try {
				const watcher = watch(directory, { persistent: false }, (_event, changed) => {
					if (changed !== null && changed !== undefined && changed !== CREDENTIALS_FILENAME) return;
					schedule();
				});
				watcher.on("error", (error) => {
					ctx.logger.warn(
						"dsh-import-newapi: 监视 %s 失败：%s",
						directory,
						String(error?.message ?? error),
					);
				});
				watchers.push(watcher);
			} catch (error) {
				ctx.logger.warn(
					"dsh-import-newapi: 监视 %s 失败：%s",
					directory,
					String(error?.message ?? error),
				);
			}
		}
		return () => {
			clearTimeout(timer);
			for (const watcher of watchers) {
				try {
					watcher.close();
				} catch {
					/* 已经关掉了。 */
				}
			}
		};
	}, "dsh-import-newapi: 把空的 `refs: {}` 维持成块状 refs 段");
}

/** 供离线自测引用的内部实现。 */
export const __internals = {
	credentialsFileCandidates,
	liveCredentialsFile,
	pickCredentialsFile,
	normalizeEmptyRefs,
};
