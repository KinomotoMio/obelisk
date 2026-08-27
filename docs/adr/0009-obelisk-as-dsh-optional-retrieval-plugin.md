# ADR-0009：Obelisk 作为 DeepSeek Harness 的可选历史检索插件

> Mount the canonical Obelisk skill as an opt-in second retrieval channel in
> DeepSeek Harness, without changing either product's core or inventing a
> DSH-specific Obelisk protocol.

Status: **Accepted — 2026-08-14; revised after implementation review — 2026-08-27**

## 一句话提案

Obelisk 插件只向 DeepSeek Harness（下称 DSH）的标准 skill registry 注册随包
携带的原版 `obelisk` skill。DSH 通过现有 skill catalog 和 `skill` 工具让模型
发现、加载它；skill 继续通过标准 Bash 工具执行 `obelisk --query ...`。

插件不注册专用查询工具，不追加 system prompt，不接管 Bash 渲染，也不修改任何
DSH 源码。

## 背景：两个检索层各有边界

DSH 的会话检索擅长查本工具内、当前工作区附近的新鲜历史。Obelisk 则把 Claude
Code、Codex、Kimi Code、Pi 等多个编码工具的会话整理成本机档案，并提供一层由
人批准的持久记忆。

因此两者保持并存：DSH 原有检索不变；显式启用 Obelisk 插件后，模型多一个跨
工具历史和记忆层入口。Obelisk 不取代 DSH 的实时会话能力，DSH 也不重新定义
Obelisk 的查询行为。

## 最终设计

### 1. 插件是 skill provider

插件唯一依赖是 DSH 的 `ctx.skills` 服务，并注册一个名为 `obelisk` 的 bundled
skill provider。DSH 自己负责：

- 把 skill 的 name 和 description 放进现有 catalog；
- 通过现有 `skill` 工具按需加载完整内容；
- 用现有资源路径规则加载 skill 引用的 reference 文档；
- 按 DSH 原有优先级允许项目内同名 skill 覆盖 bundled copy。

插件不注入 DSH 专属的模型说明。Obelisk 的触发条件、查询方法、证据纪律、memory
审批边界和错误处理全部来自原版 skill。

### 2. skill 原样随包交付

构建插件时，`skill-doc/` 整个目录直接复制进发布产物。插件读取同一份
`SKILL.md` frontmatter 与正文，并将整个目录暴露为 resource base。实现不维护
第二份经过改写的 Obelisk 说明，也不要求用户另行全局安装 skill。

本地开发从仓库中的 `skill-doc/` 读取；发布包从自身的 `dist/skill/` 读取。测试
验证加载后的正文与 canonical source 一致，并验证正文引用的资源都能从该 resource
base 找到。

### 3. 调用保持为标准 Bash

模型加载 skill 后，依照原版说明创建有界 query 文件，再通过 Bash 执行
`obelisk --query "$qfile"`。调用的语法、nonce、自身 session 识别、stdout、退出
状态、超时与错误呈现都继续由 Obelisk CLI 和 DSH Bash 工具各自负责。

这使 DSH 与其它 Agent harness 使用同一个 Obelisk 协议。插件不再用同步子进程、
固定临时文件、额外输出截断或第二套错误文本包裹 CLI。

## 为什么不保留 `obelisk_query`

最初实现把 Obelisk 包装成专用模型工具，并附加一段 system prompt。这个实现能
获得独立的前端卡片，但同时建立了 DSH 特有的调用路径：skill 教模型调用 Bash，
插件却教模型调用另一套工具；wrapper 还另外定义临时文件、超时、截断和错误
语义。

这些差异并非 Obelisk 的跨 Agent 契约，而只是为了适配展示而产生的机制。review
后的判断是：工具身份和执行协议不应为了 branding 发生变化。DSH 已经能自动把
skill 摘要放入 catalog，并在加载后返回完整说明，因此无需重复 system prompt。

## 前端呈现决策

本轮不追求额外的 Obelisk 工具样式。Obelisk 调用保持为 DSH 原生 Bash 行，用户
可以直接看到真实命令与结果。

DSH 当前的 `tool.call.toolview` 是按线上工具名选择的 keyed slot。插件可以完整
接管一个自有工具名，却不能在不替换整个 Bash renderer 的前提下，只装饰其中
被识别为 Obelisk 的命令。完整接管 `bash` 会与 DSH 自带注册冲突；复制 Bash
renderer 则会形成长期耦合，而且组合命令、管道和 shell 语法也无法被 UI 层可靠
还原成唯一业务归因。

为实现一个标记去修改 DSH、复制其 renderer，或重新引入专用工具，都不符合本
集成的边界。因此该能力留空，不在 Obelisk plugin 中设计变通方案。

## 启用与配置

插件默认不启用，由部署方显式加入 Cordis patch。唯一前提是 `obelisk` CLI 已在
DSH 进程的 `PATH` 中。插件没有 `cliPath`、timeout 或输出长度配置，也不新增设置
页面；CLI 缺失或命令失败时，由标准 Bash 调用如实呈现。

若以后出现插件自有的产品能力，而不仅是跨工具一致的历史查询，可以另行定义
设置页或产品页面。当前集成没有为未来可能性预设空配置壳。

## 不变式

| 边界 | 最终约束 |
|---|---|
| DSH 源码 | 不修改 |
| DSH 原有会话检索 | 不替代、不改写 |
| Obelisk CLI | 复用公开命令，不加 wrapper 协议 |
| Obelisk skill | 从 canonical `skill-doc/` 原样构建并完整携带 resources |
| 模型说明 | 只走 DSH 标准 skill catalog 与加载结果 |
| 前端 | 使用标准 Bash 呈现 |
| Memory mutation | 继续遵守 Obelisk skill 中的人类批准流程 |
| 可见范围 | 与其它 harness 一致，查询本机 Obelisk 档案 |

## 已明确不做

- 不让 Obelisk 取代 DSH 自有的实时会话检索；
- 不注册 `obelisk_query` 或其它 DSH 专用工具；
- 不注入额外 system prompt；
- 不在插件中接管或复制 DSH Bash renderer；
- 不为本轮增加 settings page；
- 不修改 DSH 来增加条件式 Bash decoration slot。
