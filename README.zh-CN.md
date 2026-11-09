# dsh-ldf

Local Decision Framework（LDF）的 DeepSeek Harness 主机插件。需要 DSH `>=0.2 <0.3`、Node.js `>=22`，以及安装了上游 `mcp` 依赖的 Python `>=3.10`。此 MVP 曾针对本地 DSH SDK `0.2.2-alpha.2` 验证；声明的版本范围代表兼容目标，并不证明所有历史 `0.2` 版本都具备所需的易变设置 API。

上游实现位于 Git 子模块 `upstream/`，由父仓库固定版本。所有 DSH 适配都在 `src/`，不会复制或修改上游源码。套件补丁会挂载主机插件；`src/client.js` 在 DSH 外挂设置页提供表单，不依赖可选的主机 UI 组件包。

[English](README.md) · [繁體中文](README.zh-TW.md)

## 安装与设置

```sh
git clone --recurse-submodules https://github.com/phillui-37/dsh-ldf.git dsh-ldf
cd dsh-ldf
# 已有检出目录时：
git submodule update --init --recursive
python3 -m venv .venv
.venv/bin/python -m pip install ./upstream
npm install
```

通过 DSH 外挂管理器将此本机目录安装为套件。DSH 主机需提供 `package.json` 中列出的 peer 套件。在 DSH Settings 中打开 **Local Decision Framework**（`ldf`）设置表单，并将 `python` 设为 `.venv/bin/python` 的绝对路径。外挂会将子模块的 `src` 加入 `PYTHONPATH`，因此始终使用固定版本，而不是系统中其他版本的 LDF。

设置 `baseUrl` 和 `model`，指向兼容 OpenAI chat-completions 的端点。默认值为本机 Ollama：`http://127.0.0.1:11434/v1`，模型为 `qwen3:8b`；可自行准备该模型，或使用下文的模型设置工具。LDF 会在设定的基础 URL 后附加 `/chat/completions`。托管服务可通过 `apiKeyFile` 指定主机可读取的 UTF-8 密钥文件路径；密钥本身不会显示在设置表单中。配置路径应使用绝对路径；上游相对路径会以插件根目录为基准。

## 设置字段

下列字段都可在 DSH Settings 中编辑，并使用 DSH 原生持久化配置。保存后会依序更新子运行环境、关闭旧 MCP 连接和提示词区段，再启动新配置。停用会移除工具和指引；设置变更可中断正在运行的调用。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启用 MCP 和提示词指引 |
| `python` | `python3` | Python 执行档，建议使用虚拟环境的绝对路径 |
| `serverName` | `ldf` | MCP 命名空间，仅允许 1–32 个 ASCII 字母、数字、下划线或连字符 |
| `baseUrl` | `http://127.0.0.1:11434/v1` | 判定 API 基础 URL |
| `model` | `qwen3:8b` | 判定模型 |
| `apiKeyFile` | 空 | 可选的密钥文件路径 |
| `timeout` | `30` | 上游 HTTP 超时秒数，范围 1–300 |
| `maxOutputTokens` | `1200` | 模型回复预算，范围 1–8192 |
| `reasoningEffort` | 空 | 可选的推理强度参数 |
| `outputMode` | `json_object` | `json_schema`、`json_object` 或 `plain` |
| `clientName` | `dsh` | 收据中的调用端标签，不可含空白 |
| `capture` | `false` | 保留上游证据输入快照 |
| `captureResponse` | `false` | 保留上游原始模型回复 |
| `dataDir` | 空 | 覆盖上游收据和快照的保存目录 |
| `toolCallTimeoutMs` | `60000` | DSH 原生 MCP 调用期限，单位为毫秒 |
| `followUpstreamSkill` | `false` | 找到相符技能时，仅使用上游技能作为插件提示词指引 |
| `prefix` | 有界的 LDF 使用指引 | 可编辑的多行模型指引 |
| `suffix` | 空 | 额外的可编辑多行模型指引 |

`prefix` 和 `suffix` 会围绕插件自己的指引区段；不会取代 DSH 全域 persona 的前缀或后缀。两者都是可选的系统提示词内容，且需主机提供原生 `systemPrompt` 服务。默认提示词建议 Agent 对会影响下一步行动的重大不确定事实使用 LDF 和稳定证据 ID；不会强制自动调用工具。

`followUpstreamSkill` 默认关闭。启用后，外挂会在 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 和 `~/.opencode/skills` 中寻找名称为 `ldf-check-claim` 且 frontmatter 相符的技能。若找到有效的 `SKILL.md`，它会取代 LDF 外挂提供的全部提示词，包括 `prefix` 和 `suffix`；若没有可用文件，则保留原本设定并记录警告。此开关无法卸载由 DSH 独立载入的技能。

上游会写入收据，即使关闭快照选项也是如此。请妥善设置 `dataDir` 和保留政策；快照选项可能保留证据或模型内容。原生 MCP 客户端负责程序启动、重连、工具注册和清理。启动失败会由 DSH 记录并可能重连；若解释器不存在，外挂不会假装判定成功。

## 工具

默认情况下，DSH 原生 MCP 客户端会在 `mcp__ldf__` 命名空间提供上游工具：`ldf_check_claim`、`ldf_check_claims`、`ldf_summarize_output` 和 `ldf_fetch_evidence`。自订 `serverName` 会改变命名空间。工具的参数和证据语义来自上游。只要 LDF 已启用，DSH 主机外挂还会提供 `ldf_discover_models` 和 `ldf_setup_local_model`。证据来源、判定结果、注册来源和模型端点详情请参阅[上游 README](upstream/README.md)。

## 本机模型发现与设置

`ldf_discover_models` 会按需查看本机模型运行环境、模型及 Agent CLI。它检查 Ollama 的 `127.0.0.1:11434`、LM Studio 的 `127.0.0.1:1234`；只有目前设定的 `baseUrl` 是 loopback 时才会检查该端点。只有 LM Studio 的 loopback API 已响应时，才会调用 `lms ls --json --llm` 查看模型，以免触发应用启动。此工具不会扫描其他连线埠、读取密钥文件、启动服务、下载模型或修改设定。对 `codex` 和 `claude` 的检测只报告 CLI 是否安装，不读取认证状态，也无法证明订阅有效。OpenCode 模型清单仅供查看；这些模型不会因此成为 LDF 判定后端。

`ldf_setup_local_model` 支援 Ollama 和 LM Studio。调用前，请先询问使用者的 RAM、可用磁盘空间、语言和速度/品质需求；列出确切运行环境、模型 ID、格式和预估下载大小，若无法确认大小就明确说明。只有使用者同意该组确切选项后才能开始。工具使用固定命令参数，只会在 `127.0.0.1` 启动服务，通过 `/v1/models` 验证模型，然后将 LDF 的 `baseUrl` 和 `model` 更新为本机端点。切换至本机服务时会清除 `apiKeyFile` 的设定路径，但不会删除该路径所指的文件。工具不会安装运行环境。若后续步骤失败，磁盘上可能留下部分模型，或本机服务仍在运行；结果会说明这类状况。

Ollama 使用确切模型标签。LM Studio 支援 `auto`、`gguf` 或 `mlx`；`auto` 可能选择运行环境偏好的模型版本。MLX 下载由 LM Studio 执行。Replicate 是云端服务，不是本机设置目标。

## 验证

```sh
npm run check
LDF_TEST_PYTHON="$PWD/.venv/bin/python" npm test
npm pack --dry-run --json
```

整合测试会组装真实 Cordis Loader、DSH 系统提示词、ToolRuntime、原生执行器及 MCP 客户端，启动真实上游 Python stdio 服务，并通过受控 loopback 服务传送判定请求。它会验证判定结果、模型和 URL、命名空间更新、旧工具移除、提示词更新及停用清理；需要 SDK 开发依赖，并会在仓库内建立和清理数据目录，不需要 API key 或外部模型。另一个测试会启动一次性的 DSH 配置，使用真实 SettingsForms 和 ConfigEditor 服务，检查选项显示、保存持久化、无效值拒绝和重新启动恢复；之后实际 MCP 调用会使用保存的模型。上述自动化测试尚未覆盖模型发现/下载流程或上游技能查找。

先前基线验证使用 DSH `0.2.2-alpha.2`、Node `26.13.0`、Python `3.15` 和 Python MCP `1.30.0`。当时 DSH Web 设置表单成功显示；修改提示词后缀，离开并重新打开面板仍保留设定，再还原原本空白值。`mcp__ldf__ldf_check_claim` 工具成功注册，但当时预设端点 `127.0.0.1:11434` 未监听，实际调用返回 `provider_or_protocol_error`。托管服务认证及其他 DSH 0.2 版本仍未验证。`npm pack --dry-run` 只检查压缩包内容。GitHub 原始码公开不代表已发布到 npm registry。

## 授权与子模块维护

DSH 适配部分采用 MIT 授权，详见 [LICENSE](LICENSE)。上游授权由上游储存库管理；发布时请保留其授权文件。固定版本的上游目录内含 `upstream/LICENSE`。维护者应按一般方式更新子模块、审阅上游变更并重新验证；不要将上游文件复制进此插件。
