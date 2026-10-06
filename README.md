[English](README.en.md) · **简体中文**

# dsh-import-newapi

把 [New API](https://github.com/Calcium-Ion/new-api) 复制出来的连接信息导入成本 profile 里
`@deepseek-ai/dsh-llm-pi-ai` 适配器的一个新供应商，并把密钥写进 DSH 的凭据文件。

仓库：<https://github.com/Deanyu148/dsh-import-newapi>

- **界面**：DSH 设置面板 →「New API 导入」（在「模型」下面）。
- **连接信息**写进当前 profile 的 `cordis.patch.yml`：`llm-pi-ai` 条目的
  `config.providers.<供应商 id>`，只新增键，不动任何已有的键与父级。
- **密钥**写进 `$DSH_HOME/.credentials.yaml` 的 `refs:`，键名由供应商 id 推导。
- 想接入第二个 New API，就再导入一次：会新建另一个供应商。

## 安装

```bash
# 在 DSH 里：设置 → 插件 → 安装，填本目录的绝对路径
# 或让 agent 用 plugin_manager install_bundle 安装这个目录
```

装好后刷新页面，设置面板左侧就会出现「New API 导入」。

## 使用

1. **连接信息**：把 New API 里复制出来的那段 JSON 粘进第一个框，例如
   `{"_type":"newapi_channel_conn","key":"sk-…","url":"https://…"}`。
   识别成功后下面会自动填好站点地址与密钥，也可以完全手填。
2. **供应商**：填供应商 id（会按站点地址给一个候选值）、可选的显示名、协议。
   `baseURL` 按协议自动推导，也可以手改：
   - OpenAI Chat Completions / OpenAI Responses → `<站点地址>/v1`
   - Anthropic Messages → `<站点地址>`（SDK 自己拼 `/v1/messages`）
3. **模型**：点「获取模型列表」，用搜索栏过滤，逐个勾选，或用「全选 / 反选 / 全不选」
   （这三个按钮只作用于当前搜索结果）。
4. **名称与容量**：勾选后每个模型一行，左边是模型 id（不可改），接着是**名称**、
   上下文窗口、最大输出。
   - 名称是该模型的显示名（`models[].name`，**不是** id），默认填成目录里报的名字，
     可以逐个改；改成空、只留空白、或与 id 相同，都不会写这个键。
   - 容量支持 `256K` / `1M` 这种写法（`K`/`M` 是十进制，即 1K = 1000、1M = 1000000，
     允许小数），也可以直接写数字。**留空就不写这个键**，交给适配器或内置目录决定。
     已验证：`272K` → `272000`、`1.05M` → `1050000`、`384K` → `384000`。
5. **输入格式与思考强度**（都可以留空）：每个勾选的模型一张卡片。
   - **输入格式**：勾 `文本` / `图像`。文本默认勾上；目录报告该模型支持图像时图像也默认
     勾上。只勾文本等于适配器的默认值，**不写 `input` 键**；勾了图像写
     `input: [text, image]`；一个都不勾也不写。
   - **思考强度**：也就是模板里的 `reasoningEfforts`，每个模型提供六个档位
     `off / low / medium / high / xhigh / max`（界面按当前语言显示档位名）。
     勾上档位后：中间的输入框是**配置键**（默认就是档位名，可以改），右边的输入框是
     **该档位要发给网关的值**（默认与档位名相同，可以改）。
     - `off` 可以**只有键没有值**：留空表示"不思考时不发送这个参数"（写出来是
       `off: null`，YAML 里 `off:` 与 `off: null` 是同一个空值）；给 `off` 填了值就
       发送那个值。
     - 除 `off` 外每个勾上的档位都必须有值；键名必须落在适配器允许的集合里
       （`off / minimal / low / medium / high / xhigh / max`），所以想用 `minimal`
       就把某一行的键名改成它。
     - 只勾 `off`、键名重复、键名为空、非 off 档位没给值，都会在点导入之前被拦住并
       说明原因。
     - **一个档位都不勾就不写 `reasoningEfforts`**，由适配器与内置目录决定该模型的能力。
6. 点「导入」。展开的预览框里能看到将要写入的 provider 对象。

## 规则

- **供应商 id**：小写英文字母开头，只能用小写英文字母、数字、连字符（`-`），
  且连字符不能开头、结尾或连续出现。已经存在的 id 一律拒绝导入——本插件只新增，
  不覆盖。
- **密钥引用名**：供应商 id 全大写、`-` 换成 `_`，末尾加 `_API_KEY`。
  例如 `example-api` → `EXAMPLE_API_API_KEY`，`example-api-2` → `EXAMPLE_API_2_API_KEY`。
- **写盘方式**：全部通过 DSH 自己的 Remote（`settings.mutate` / `credentials.set`）
  提交，所以校验、加锁、原子写入、热重载都由宿主负责，本插件不直接改文件。
- **密钥已经由环境变量提供**时（`describe` 报 `writable: false`），导入会跳过写
  `.credentials.yaml` 并给出提示，供应商照常写入。
- **空的 `refs: {}` 会在写入前被去掉**：凭据提供者是「解析成 YAML 文档 → 在原文档上
  增量改一个键 → 渲染回去」，格式基本原样保留；文件里只剩一个空的流式映射时，新密钥
  也只能挤在同一行（`refs: { EXAMPLE_API_API_KEY: sk-… }`）。宿主半边在挂载时把这一行
  删掉并盯着该文件，于是提供者会新建块状映射，写成

  ```yaml
  refs:
    EXAMPLE_API_API_KEY: sk-…
  ```

  两种写法在提供者眼里完全等价，所以这只是一次纯文本的排版整理：插件只删空的 `refs: {}`
  那一行，绝不解析或生成 YAML，也绝不读写任何密钥值（值永远由 `credentials.set` 写）。
  骨架位置按可信度问三次：活着的凭据服务自己报的路径 → `$DSH_HOME/.credentials.yaml` →
  由加载基点反推的 `<home>/.credentials.yaml`，最后才退回 `~/.dsh`；并且只有确实是
  `version: 1` 的凭据文档才会被碰。
- **模型条目只写有信息的键**：`name` 留空/与 id 相同不写；容量留空不写；`input` 只勾
  文本不写；`reasoningEfforts` 一个档位都没勾不写。键的书写顺序照模板：
  `id`、`name`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts`。
- **思考档位的取值**与适配器 `resolveModelReasoning` 的规则一致（除 `off` 外都必须有
  值；声明了就必须至少有一个非 off 档位）。生成的条目已经用 profile 里真实的
  `@deepseek-ai/schemastery` 与适配器 `lib/index.js:1001-1013` 的原样 schema 验过：
  `off: null` 与自定义键 `minimal` 都能通过校验，未知档位键、非字符串值会被拒。
- **注意**：config-editor 写入时会重排该条目的整个 `config` 块，所以
  `llm-pi-ai` 条目 `config:` 里的注释会丢失，其他条目的注释不受影响。

## 开发

```bash
node test/run.mjs
```

离线测试会加载真实的客户端 bundle，给它一个迷你 React 与假的 cordis 上下文，
把整条导入流程（粘贴 → 推导 → 拉模型 → 勾选 → 填名称/容量 → 勾输入模态 → 勾思考档位 →
提交）跑一遍，并断言提交给宿主的载荷。`lib/client.js` 末尾导出的 `__internals` 就是给它用的。
宿主半边同样有覆盖：空 `refs: {}` 的改写（含用 profile 里真实的 `yaml` 复现提供者写入）、
只认凭据文档的保护、候选路径的优先级、以及挂载时的归一化 + 文件监视。

改完 `lib/client.js` 只要**刷新页面**；改完 `lib/index.js`（宿主半边）**必须重启 DSH** ——
`plugin_manager` 的禁用/启用不会重新导入宿主模块（Node 的 ESM 缓存），浏览器半边则每次
刷新都会拿新 bundle。

## 发布（维护者）

```bash
npm run release                 # 检查 → 跑测试 → 发布 latest（始终发官方源）
npm run release -- --dry-run    # 只检查并打印将要发布的文件
npm run release -- --tag beta   # 发到别的 dist-tag
npm run release -- --otp 123456 # 账号开了 2FA 时带上一次性验证码
```

`scripts/publish.mjs` 依次做这几件事，任何一步不满足就停下并说清原因：

1. 核对包名、版本与 registry —— **写死 `https://registry.npmjs.org/`**，不跟随任何镜像配置；
2. 确认 Git 工作区干净（可用 `--skip-git-check` 跳过），并提醒还没推送的提交；
3. 跑 `node test/run.mjs`（可用 `--skip-tests` 跳过，不推荐）；
4. 用 registry API 确认这个版本还没被发布过 —— 已经有了就只提示 `npm version patch`，**绝不覆盖**；
5. 执行 `npm publish --registry https://registry.npmjs.org/`。

2FA 账号可以带 `--otp` 直接发，也可以先 `npm login --auth-type=web` 完成浏览器授权再 `npm run release`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：挂载自检 + 把空的 `refs: {}` 归一化成块状 `refs:` 段并盯住该文件 |
| `lib/client.js` | 浏览器半边：设置页与导入流程 |
| `cordis.patch.yml` | 把本插件条目插进 profile |
| `test/run.mjs` | 离线自测：迷你 React + 假 cordis 上下文，跑完整导入流程并断言载荷 |
| `scripts/publish.mjs` | 发布脚本：自测 → 校验官方源与版本占用 → `npm publish` |

## 许可

[MIT](LICENSE) © 2026 Deanyu148
