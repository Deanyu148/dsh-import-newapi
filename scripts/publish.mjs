#!/usr/bin/env node
/**
 * dsh-import-newapi 的发布脚本。
 *
 * 用法（在包根目录执行）：
 *
 *   npm run release                 # 检查 → 跑测试 → 发布 latest
 *   npm run release -- --dry-run    # 只做检查并打印将会发布的文件，不真的发布
 *   npm run release -- --tag beta   # 发布到指定的 dist-tag
 *   npm run release -- --otp 123456 # 账号开了 2FA 时带上一次性验证码
 *   npm run release -- --skip-tests --skip-git-check
 *
 * 设计约定：
 *
 *   1. **永远只用 npm 官方源** `https://registry.npmjs.org/`，不跟随任何镜像配置；
 *   2. 发布前必须能跑通离线自测（`node test/run.mjs`）；
 *   3. 版本号已经存在于 npm 时直接停下，并提示怎么升版本，绝不覆盖；
 *   4. 工作区不干净（有未提交改动）时默认停下，避免把没入库的代码发出去；
 *   5. 所有检查都只是「尽早失败」，任何不确定的情况都打印清楚的原因，而不是悄无声息地继续。
 *
 * 脚本不碰 Git 远端、不打标签：发布成功后打印建议的 `git tag` 命令，由人决定。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** npm 官方源：写死，不读用户配置。 */
const REGISTRY = "https://registry.npmjs.org/";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageFile = join(root, "package.json");
const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
const isWindows = process.platform === "win32";

/**
 * npm 的启动方式。
 *
 * 优先用 node 直接跑 npm 自带的入口脚本：那样既不用 shell，也不会有
 * `D:\Program Files\...` 这种带空格的路径被 shell 拆开的麻烦；
 * 找不到入口脚本时才退回 `npm` / `npm.cmd`（Windows 上必须借 shell）。
 */
function npmInvocation() {
	const candidates = [
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	];
	for (const file of candidates) {
		if (existsSync(file)) return { command: process.execPath, prefix: [file], shell: false };
	}
	return { command: isWindows ? "npm.cmd" : "npm", prefix: [], shell: isWindows };
}

const npm = npmInvocation();

/** 解析命令行参数。 */
function parseArgs(argv) {
	const options = { dryRun: false, tag: "latest", otp: undefined, skipTests: false, skipGitCheck: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--skip-tests") options.skipTests = true;
		else if (arg === "--skip-git-check") options.skipGitCheck = true;
		else if (arg === "--tag") options.tag = argv[++index] ?? "latest";
		else if (arg.startsWith("--tag=")) options.tag = arg.slice(6);
		else if (arg === "--otp") options.otp = argv[++index];
		else if (arg.startsWith("--otp=")) options.otp = arg.slice(6);
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				[
					"用法：npm run release [-- 选项]",
					"  --dry-run          只检查并打印将要发布的文件",
					"  --tag <name>       发布到指定 dist-tag（默认 latest）",
					"  --otp <code>       2FA 账号的一次性验证码",
					"  --skip-tests       跳过离线自测（不推荐）",
					"  --skip-git-check   工作区有未提交改动时也继续",
					"",
				].join("\n"),
			);
			process.exit(0);
		} else {
			process.stderr.write(`未知参数：${arg}\n`);
			process.exit(2);
		}
	}
	return options;
}

/** 打印一行步骤标题。 */
function step(title) {
	process.stdout.write(`\n== ${title} ==\n`);
}

/** 打印一行错误并退出。 */
function fail(message) {
	process.stderr.write(`\n✖ ${message}\n`);
	process.exit(1);
}

/** 跑一个外部命令，输出直接接到当前终端（不经过管道）。 */
function run(command, args, useShell = false) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: useShell });
	return result.status === 0;
}

/** 跑一个外部命令并拿回 stdout；失败时返回 undefined。 */
function capture(command, args) {
	try {
		const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
		if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
		return result.stdout;
	} catch {
		// 受限沙箱里捕获子进程输出会被拒绝：当作「查不到」，继续走后面的检查。
		return undefined;
	}
}

/** 跑 npm，并把它自带的入口脚本前缀补上。 */
function runNpm(args) {
	return run(npm.command, [...npm.prefix, ...args], npm.shell);
}

/** 问 npm 这个版本是不是已经发布过了。 */
async function versionOnRegistry(name, version) {
	try {
		const response = await fetch(`${REGISTRY}${name.replace("/", "%2f")}`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(20000),
		});
		if (response.status === 404) return { kind: "free" };
		if (!response.ok) return { kind: "unknown", detail: `HTTP ${response.status}` };
		const document = await response.json();
		if (document?.versions?.[version] === undefined) return { kind: "free" };
		return { kind: "taken", latest: document?.["dist-tags"]?.latest };
	} catch (error) {
		return { kind: "unknown", detail: String(error?.message ?? error) };
	}
}

const options = parseArgs(process.argv.slice(2));
const { name, version, private: isPrivate } = manifest;

step("检查清单");
process.stdout.write(`包名      ${name}\n版本      ${version}\ndist-tag  ${options.tag}\nregistry  ${REGISTRY}（固定官方源）\n`);
if (isPrivate === true) fail("package.json 里 `private: true`，这个包不能被发布。");
if (typeof name !== "string" || name.length === 0) fail("package.json 缺少 name。");
if (typeof version !== "string" || version.length === 0) fail("package.json 缺少 version。");
if (process.env.npm_config_registry !== undefined && process.env.npm_config_registry !== REGISTRY) {
	process.stdout.write(
		`注意      环境里的 npm_config_registry=${process.env.npm_config_registry}，本脚本会用 --registry 覆盖它。\n`,
	);
}

step("检查 Git 工作区");
if (options.skipGitCheck) {
	process.stdout.write("已按 --skip-git-check 跳过。\n");
} else {
	const status = capture("git", ["status", "--porcelain"]);
	if (status === undefined) {
		process.stdout.write("查不到 git 状态（不是仓库，或在受限环境里跑），跳过这项检查。\n");
	} else if (status.trim().length > 0) {
		process.stdout.write(status);
		fail("工作区有未提交改动：先提交（或加 --skip-git-check 强行发布）。");
	} else {
		process.stdout.write("工作区干净。\n");
		const ahead = capture("git", ["log", "--oneline", "@{u}..HEAD"]);
		if (ahead !== undefined && ahead.trim().length > 0) {
			process.stdout.write(`提醒      有还没推送的提交：\n${ahead}`);
		}
	}
}

step("跑离线自测");
if (options.skipTests) {
	process.stdout.write("已按 --skip-tests 跳过。\n");
} else if (!run(process.execPath, [join("test", "run.mjs")])) {
	fail("自测没通过，已中止发布。");
}

step("问 npm 这个版本是否已存在");
const probe = await versionOnRegistry(name, version);
if (probe.kind === "taken") {
	fail(
		`${name}@${version} 已经发布过（latest 是 ${probe.latest ?? "未知"}）。\n` +
			"  先升版本再发：npm version patch && git push --follow-tags（把 patch 换成 minor / major）。",
	);
} else if (probe.kind === "unknown") {
	process.stdout.write(`查不到（${probe.detail}），继续尝试发布。\n`);
} else {
	process.stdout.write(`${name}@${version} 还没被占用。\n`);
}

const publishArgs = ["publish", "--registry", REGISTRY, "--tag", options.tag];
if (options.otp !== undefined && options.otp.length > 0) publishArgs.push("--otp", options.otp);

if (options.dryRun) {
	step("dry-run：将要发布的文件");
	runNpm(["pack", "--dry-run", "--registry", REGISTRY]);
	process.stdout.write("\ndry-run 结束，没有发布。真正发布：npm run release\n");
	process.exit(0);
}

step(`发布到 ${REGISTRY}`);
process.stdout.write(`$ npm ${publishArgs.join(" ")}\n`);
if (!runNpm(publishArgs)) {
	process.stderr.write(
		[
			"\n✖ 发布失败，按提示排查：",
			"  · EOTP（要求一次性验证码）：用 `npm run release -- --otp <6位码>`，",
			"    或先 `npm login --auth-type=web` 完成浏览器授权再重跑；",
			"  · EPUBLISHCONFLICT（版本已存在）：npm version patch，再重跑；",
			"  · E403：当前 token 没有这个包的写权限（或包名被别人占用）；",
			"  · 网络问题：换网络后重跑，注意本脚本始终只发官方源。",
			"",
		].join("\n"),
	);
	process.exit(1);
}

step("完成");
process.stdout.write(
	[
		`npm 页面  https://www.npmjs.com/package/${name}/v/${version}`,
		`安装      npm i ${name}@${options.tag}`,
		"",
		"别忘了把这一版记进 Git（如果还没提交/打标签）：",
		`  git tag v${version} && git push origin v${version}`,
		"",
	].join("\n"),
);
