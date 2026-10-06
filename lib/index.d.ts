/** 插件名。 */
export declare const name: string;
/** 宿主侧依赖。 */
export declare const inject: string[];

/** 宿主侧最小上下文（只声明本插件真正用到的成员）。 */
export interface HostContext {
  configEditor: {
    entries(): Array<{ options: { id: string; name?: string; config?: Record<string, unknown> } }>;
  };
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Cordis 的加载基点（DSH 里是 `<home>/profiles/<profile>`）。 */
  baseDir?: string;
  /** Cordis 的服务访问器。 */
  get?(name: string): { spec?: { filename?: string } } | undefined;
  effect?<T>(callback: () => T | (() => void), label?: string): T;
}

/**
 * 挂载时确认 `@deepseek-ai/dsh-llm-pi-ai` 条目存在并记录它，随后把凭据文档里
 * 空的 `refs: {}` 归一成块状写法，并监视该文件保持这个写法。
 * @param ctx - 插件上下文。
 */
export declare function apply(ctx: HostContext): void;

/**
 * 凭据文档的候选路径，按可信度排列并去重：活着的凭据服务报的路径 →
 * `$DSH_HOME/.credentials.yaml` → 由加载基点反推的 `<home>/.credentials.yaml` →
 * `~/.dsh/.credentials.yaml`。
 * @param ctx - 插件上下文（可选，只用于读服务路径与加载基点）。
 */
export declare function credentialsFileCandidates(ctx?: HostContext): string[];

/**
 * 活着的凭据服务自己报的文档路径。
 * @param ctx - 插件上下文（可选）。
 * @returns 绝对路径，或 `undefined`。
 */
export declare function liveCredentialsFile(ctx?: HostContext): string | undefined;

/**
 * 挑出第一份真实存在的凭据文档，作为没有凭据服务时的兜底目标。
 * @param ctx - 插件上下文（可选）。
 * @returns 绝对路径，或 `undefined`（不存在就不猜）。
 */
export declare function pickCredentialsFile(ctx?: HostContext): string | undefined;

/**
 * 把凭据文档里空的 `refs: {}` 那一行删掉，其它字节原样保留。
 * 只有确实是 `version: 1` 的凭据文档才会被碰。
 * @param filename - 凭据文档的绝对路径。
 * @returns 是否真的改写了文件。
 */
export declare function normalizeEmptyRefs(filename: string): boolean;

/** 供离线自测引用的内部实现。 */
export declare const __internals: {
  credentialsFileCandidates: typeof credentialsFileCandidates;
  liveCredentialsFile: typeof liveCredentialsFile;
  pickCredentialsFile: typeof pickCredentialsFile;
  normalizeEmptyRefs: typeof normalizeEmptyRefs;
};
