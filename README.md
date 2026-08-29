# dsh-connect

`dsh-connect` 是 DeepSeek Harness（DSH）的连接器插件，围绕两类能力工作：

1. 连接数据库，发现物理结构，并生成可供 Agent 检索的语义元数据。
2. 配置固定的第三方 HTTP API，将每个已启用的 API 注册为一个受约束的 Agent 工具。

它适合把企业数据库和已有业务 API 安全地接入 DSH 对话。用户不需要在聊天中输入数据库密码或 API 密钥，也不需要记住工具名；工具描述会注册到 DSH Agent，由 Agent 根据对话和元数据决定是否调用。

## 功能边界

| 范围 | dsh-connect 提供 | 明确不提供 |
| --- | --- | --- |
| 数据库 | MySQL、PostgreSQL、ClickHouse over HTTP(S) 的连接、扫描、元数据管理和受限查询 | 写库、DDL、多语句 SQL |
| 元数据 | 表、视图、字段、主外键、DDL、注释、语义识别、YAML 导出 | 把样例数据暴露给 Agent 或模型 |
| HTTP API | 用户预先配置的固定方法、域名、路径、参数和认证方式 | 模型任意决定 URL、跨域跳转或任意 HTTP 请求 |
| 对话 | Agent 自动使用已注册的元数据工具和 API 工具 | 完整 ChatBI 编排、无限制 NL2SQL |
| 关系 | 保留数据库实际发现的外键引用 | 关系推荐、关系分析和关系建模功能 |

## 安装

### 从 DSH 插件源安装

在 DSH Web profile 中执行：

```bash
dsh plugin --profile web add dsh-connect
```

安装后重启 DSH，在 **设置 -> DSH连接器** 中可以看到插件入口。入口图标使用连接图标，页面包含 **数据库** 和 **HTTP API** 两个 tab。

### 本地开发安装

项目需要 Node.js 22+ 和 pnpm：

```bash
pnpm install
pnpm run check
pnpm pack --pack-destination dist
```

开发时也可以直接安装目录：

```bash
dsh plugin --profile web add /path/to/dsh-connect
```

如果使用本地 DSH runtime 的 profile 包管理器，可安装打包文件：

```bash
cd /path/to/dsh-runtime
./node_modules/.bin/pnpm \
  --dir /path/to/dsh-home/profiles/web \
  add -w file:/path/to/dsh-connect/dist/dsh-connect-0.1.0.tgz
```

安装或更新后需要重启 DSH，使 Host 端和浏览器端插件重新加载。

## 快速上手

1. 打开 **设置 -> DSH连接器 -> 数据库**，点击 **添加数据库**。
2. 填写连接信息，点击 **测试连接**，确认数据库凭据可用。
3. 点击 **扫描**，完成物理元数据发现；需要语义识别时，先勾选 **AI 语义增强（DSH 默认模型）**，再点击 **AI 建模**。
4. 点击数据库卡片上的 **元数据**，检查和编辑表、字段的业务描述。
5. 在聊天中直接描述需求，例如“查一下销售库最近 7 天每天的订单量”。Agent 会先检索元数据，再在允许的范围内调用查询工具。
6. 在 **HTTP API** tab 中添加固定 API，测试成功并启用后，在聊天中用自然语言描述业务需求即可触发对应 API。

插件没有额外的斜杠命令。是否调用某个工具由 DSH Agent 根据工具描述、已启用状态和当前对话判断；显式说出工具名可以帮助排查，但不是正常使用的必要条件。

## 典型使用案例

### 数据库问答

销售团队接入一个只读的 MySQL 数据源，扫描并完成 AI 语义识别后，用户可以直接提问：

```text
华东区域本月每天的订单量和销售金额是多少？
```

Agent 会先从表名、字段业务名称和描述中找到相关 profile，再调用只读查询工具。数据库账号本身仍应只授予业务需要的读取权限，插件不会绕过数据库权限。

### 固定业务 API

管理员配置一个天气、物流或内部工单 API，声明固定的 URL、路径参数和认证方式后，用户可以说：

```text
查询上海的物流轨迹，单号是 SF123456。
```

Agent 只能调用已经注册的 API 工具和已声明的参数，响应可通过 JSON Pointer 裁剪为业务需要的字段。

### 数据库结构变化

源库新增字段、删除表或修改字段注释后，再次执行默认的增量扫描。dsh-connect 会比较 fingerprint，只重建变化对象；扫描成功后清理已经不存在的旧对象，未变化的语义描述和人工编辑内容继续保留。若扫描中途停止，已完成对象保留，旧对象不会被提前删除。

## 数据库接入

支持的数据库及默认端口：

| 类型 | 连接方式 | 默认端口 |
| --- | --- | ---: |
| MySQL | MySQL 协议 | 3306 |
| PostgreSQL | PostgreSQL 协议 | 5432 |
| ClickHouse | HTTP(S) | 8123 |

数据库卡片可配置：

- 名称、数据库类型、主机、端口、数据库名、用户名和密码。
- `Schema 白名单`：逗号分隔；留空表示扫描当前账号可见的全部 schema。
- TLS 开关。
- 样例行数：0 到 3 行，默认不采样。
- AI 语义增强开关和数据源启用开关。

密码不会写入普通业务表，也不会在列表接口返回，而是通过 DSH credential service 保存。编辑已有数据源时密码留空表示保留旧凭据。

## 元数据发现与同步

一次扫描会读取以下信息：

- schema、表、视图和表注释；
- 字段名、数据库类型、可空性、默认值和字段注释；
- 主键、外键及其引用的 schema、对象和字段；
- 数据库原生 DDL，或驱动生成的 DDL；
- 可选的最多 3 行样例数据。

样例数据只用于本地 profile，不会通过 Agent 元数据工具返回，也不会发送给 AI 模型。样例中的密码、token、API key、邮箱、手机号、身份证等敏感字段会脱敏。

### 扫描模式

| 模式 | 用途 |
| --- | --- |
| `incremental` | 默认模式。每次发现全部对象，但只对物理 fingerprint 或语义 fingerprint 发生变化的对象重新处理。 |
| `rebuild-ai` | 在已开启 AI 语义增强时，强制重建 AI 语义结果；适合切换 DSH 默认模型或 prompt 版本后重新识别。 |
| `full` | 完整重建 profile，适合需要彻底刷新本地元数据的场景。 |

物理 fingerprint 会覆盖表结构变化，因此增删字段、字段类型变化、注释或 DDL 变化会在下一次扫描时重新入库。扫描成功结束后，数据库中已经不存在的对象会从 profile 中清理；如果中途停止，则不会执行这一步，以免误删尚未扫描到的对象。

当前同步由用户在设置页手动触发，没有内置的定时扫描任务；需要自动化时可由 DSH 或外部调度器调用 `sources/scan`。

扫描状态包括等待、扫描中、完成和失败。点击 **停止** 会中止当前任务并立即移除未完成的任务记录，已经逐表写入的 profile 会保留，尚未处理的对象不会写入。用户界面不会把停止后的数据源永久显示为“已取消”。

## AI 元数据识别

AI 识别使用 DSH 当前的默认模型路由，不在 dsh-connect 中单独配置模型。任务启动时会记录 provider、model、reasoning effort 和分析时间，并在 profile 中保留模型状态和 prompt 版本。

识别结果包括：

- 表业务名称、表描述、标签、同义词和临时对象判断；
- 字段业务名称、字段描述、同义词、枚举值和字段角色；
- 0 到 100 的置信度及置信度原因。

模型输出会经过严格 JSON/schema 校验。普通数字置信度会自动识别为 0~1 概率或 0~100 分数，然后四舍五入并限制在 0~100；模型结果格式错误会单独标记。AI 服务不可用或返回无效结果时，插件保留启发式识别结果并将 `modelStatus` 标记为 `failed`。

字段角色的含义是元数据语义，不是数据库权限：

- `标识/关联字段`：主键、外键以及 `*_id`、`*_code`、`*_uuid`、`*_no` 等标识字段；
- `描述/分类字段`：名称、状态、类型、地区、分类等属性；
- `数值字段`：金额、数量、计数、比率和评分；
- `时间字段`：日期、时间戳等；
- `暂不确定`：无法可靠判断的字段。

存在主键、显式外键或明显标识命名时，Host 会进行保护性纠正，避免把关联标识误判为普通维度字段。AI 结果不是业务事实，仍应在元数据页面人工复核。

## 元数据页面

从数据库卡片进入 **元数据** 后：

- 左侧展示所有表名、schema 和表描述，并支持搜索；
- 右侧分为 **表元数据** 和 **字段元数据** 两个 tab；
- 表元数据可编辑业务名称、描述、标签、同义词以及是否从 Agent 检索中忽略；
- 字段元数据可编辑业务名称、字段用途、同义词、枚举值和描述；
- 另有只读的元数据浏览入口，可查看 DDL、字段类型、主键和实际外键引用。

### 指标

插件提供指标推荐和持久化 RPC，可生成记录数以及数值字段的求和、平均值等候选指标，并支持 `count`、`sum`、`avg`、`min`、`max`、`formula` 聚合方式和批量保存。

指标是业务定义，不是仅凭字段名就能确定的事实。推荐结果只能作为候选，业务人员需要确认名称、口径、表达式、单位和启用状态。dsh-connect 不会自动建立关系，也不会把指标推荐当作关系建模。

## 只读 SQL

在数据库卡片的 **元数据 -> 只读 SQL** tab 中可以执行查询，Agent 也可以调用同一能力。

约束如下：

- 只允许一条 `SELECT` 或 `WITH` 语句；
- SQL 最长 20,000 个字符；
- 禁止分号、SQL 注释、多语句以及 `INSERT`、`UPDATE`、`DELETE`、`DROP`、`ALTER`、`CREATE`、`TRUNCATE`、`GRANT`、`REVOKE`、`SET`、`USE`、`CALL`、`INTO`、`OUTFILE`、`DUMPFILE` 等操作；
- 默认最多返回 100 行，调用接口可请求 1 到 1,000 行；
- 返回列名、行数据、行数、是否截断和耗时；敏感列会脱敏；
- MySQL 和 PostgreSQL 使用只读事务，ClickHouse 使用 readonly 设置和 30 秒执行限制。

查询失败时，错误会显示在当前页面底部，不会强制跳转到其他页面。

示例：

```text
请从“销售库”查询最近 7 天每天的订单量，只返回日期和数量，不要修改数据。
```

Agent 通常会先调用元数据搜索和单表详情工具，再生成符合上述约束的查询。这个流程不等同于一个可以执行任意 SQL 的完整 ChatBI 系统。

## Agent 工具

插件启动时注册以下固定工具：

| 工具 | 用途 |
| --- | --- |
| `dsh_connect_list_data_sources` | 列出已启用数据源、类型、数据库名、对象数和扫描状态；不返回主机和凭据。 |
| `dsh_connect_search_metadata` | 搜索表、视图、字段、业务名称、描述、标签和同义词。 |
| `dsh_connect_get_table_metadata` | 根据 profile id 读取单表的 DDL、字段、主外键和语义信息；不返回样例行。 |
| `dsh_connect_query_data_source` | 执行受限只读 SQL。 |
| `dsh_connect_export_metadata_yaml` | 导出当前数据源的元数据和指标 YAML。 |
| `dsh_connect_create_http_api` | 根据自然语言生成 HTTP API 的非敏感配置，并进入 DSH 审批流程。 |

每个已启用的 HTTP API 还会动态注册为：

```text
dsh_connect_api_<slug>
```

`slug` 只能使用小写字母、数字和下划线，并以小写字母开头。停用或删除 API 后，动态工具会同步移除。

## HTTP API 接入

### 在设置页面配置

进入 **设置 -> DSH连接器 -> HTTP API -> 添加 API**，填写：

- 名称、工具标识（slug）和用途描述；
- HTTP 方法：`GET`、`POST`、`PUT`、`PATCH` 或 `DELETE`；
- 基础 URL 和路径模板；路径参数使用 `{name}`；
- 参数位置：`path`、`query`、`header`、`body`；
- 参数类型：`string`、`number`、`integer`、`boolean`、`json`；
- 认证方式：无认证、Bearer Token、API Key 或 Basic Auth；
- 超时（1,000~120,000 毫秒）、最大响应大小（1 KiB~2 MiB）和可选 JSON Pointer；
- 是否允许访问私有网络、是否启用为 Agent 工具。

基础 URL 不应包含 query string；query 参数应声明在参数列表中。响应为 JSON 时，可使用 RFC 6901 JSON Pointer（例如 `/data/items`）只提取需要的部分。设置页提供 **测试请求**，测试错误会留在当前弹窗中。

### 配置示例

下面的定义会注册 `dsh_connect_api_weather`：

```text
名称：上海天气
工具标识：weather
描述：查询指定城市当前天气，返回温度和天气状况
方法：GET
基础 URL：https://api.example.com
路径模板：/v1/weather/{city}
参数：city / path / string / 必填
参数：units / query / string / 可选
JSON Pointer：/data
认证：无
```

配置完成并启用后，在聊天中可以直接说：

```text
查一下上海今天的天气。
```

Agent 会根据 API 描述填充 `city=上海` 并调用固定工具。模型不能临时修改基础域名、HTTP 方法、路径模板或声明之外的参数。

### 通过对话添加 API

固定工具 `dsh_connect_create_http_api` 支持用自然语言创建配置，但创建不是无确认写入，流程为：

1. 用户描述公开的 API 信息；
2. Agent 生成结构化的非敏感配置；
3. DSH 展示审批预览；
4. 用户批准后保存并注册工具。

示例：

```text
添加一个上海天气 API：
GET https://api.example.com/v1/weather/{city}
参数 city 是路径参数，返回 JSON 的 /data，暂时不需要认证。
```

对话创建不会接受 token、密码、API key 值、Authorization 值或私网访问开关。需要认证时，只能在对话中声明认证类型和公开参数名；创建后 API 默认禁用，下一步到 **设置 -> DSH连接器 -> HTTP API** 填写凭据并启用。

## HTTP 安全边界

- 只允许 `http` 和 `https`，URL 不得内嵌用户名、密码，也不得包含 fragment；
- 基础 URL 和路径必须保持同一 origin，禁止重定向；
- 默认拒绝私网、回环、链路本地和保留地址；私网访问只能由设置页面对固定 API 显式开启；
- `Authorization`、`Host`、`Cookie`、`Content-Length`、`Connection` 等受控请求头不能由模型覆盖；
- 动态调用只能传入配置中声明的参数，未知参数会被拒绝；
- 请求超时和响应大小均受配置上限约束，响应超限会截断；
- Bearer token、API key、Basic password 和数据库密码只保存在 DSH credential service 中，不会出现在设置列表或 Agent 返回值中。

## 变更记录与 YAML

元数据页面的 **变更记录** 使用分页摘要，只显示变更时间、动作和摘要，不加载整份 `before/after` YAML，避免大数据量导致页面卡顿。记录类型包括元数据创建、更新、扫描和 AI 建模。

点击 **导出 YAML**，或调用 `dsh_connect_export_metadata_yaml`，可以得到当前数据源的可审阅文本，内容包括：

- 表和视图的业务名称、描述、标签、同义词和忽略状态；
- 字段类型、可空性、主键标识和语义描述；
- 已保存的指标定义。

导出的 YAML 适合代码审查、版本管理或在其他流程中二次处理；它不是回灌数据库的迁移脚本。

## RPC 开发者参考

Host 端 RPC 前缀为 `/dsh-connect`：

| 能力 | endpoint |
| --- | --- |
| 数据源 | `sources/list`、`sources/save`、`sources/delete`、`sources/test`、`sources/scan`、`sources/cancel`、`sources/query` |
| 任务 | `jobs/list` |
| 元数据 | `metadata/list`、`metadata/get`、`metadata/update`、`metadata/yaml`、`metadata/changes` |
| 指标 | `metrics/list`、`metrics/recommend`、`metrics/save`、`metrics/save-batch`、`metrics/delete` |
| HTTP API | `apis/list`、`apis/save`、`apis/delete`、`apis/test` |

所有写入 payload 都会经过 schema 校验。校验失败统一返回 `Invalid dsh-connect request`，具体字段错误在 RPC error details 中；业务执行错误会返回受限的安全错误信息。

## 目录结构

```text
src/
  index.ts                  Host 插件入口
  domain.ts                 持久化表定义
  types.ts                  领域模型和校验 schema
  host/rpc.ts               设置页 RPC 和业务操作
  host/store.ts             存储访问及安全视图
  host/datasource/          MySQL、PostgreSQL、ClickHouse 接入
  host/metadata/            元数据发现、AI 识别、指标和 YAML
  host/http/                HTTP 安全、执行器、动态工具、对话创建
  client/                   DSH 设置界面
tests/                      单元测试
scripts/build.mjs           Host 和 Browser 构建脚本
```

## 开发命令

```bash
pnpm install                # 安装依赖
pnpm run typecheck          # TypeScript 类型检查
pnpm run test               # 运行 Vitest
pnpm run build              # 构建 Host、Browser 和声明文件
pnpm run check              # 类型检查 + 测试 + 构建
pnpm pack --pack-destination dist
```

构建产物为：

- `lib/index.js`：Host ESM 插件入口；
- `lib/client.js`：浏览器端设置页 loader bundle；
- `lib/types/`：TypeScript 声明文件；
- `dist/dsh-connect-0.1.0.tgz`：可安装的插件包。

## 常见问题

### AI 建模按钮不可用

请确认该数据库已勾选 **AI 语义增强（DSH 默认模型）**，并且 DSH 的默认模型服务已加载。dsh-connect 不提供单独的模型配置入口。

### 扫描很慢

扫描需要读取数据库对象；开启 AI 后还会逐个对象调用模型。日常同步使用默认的 `incremental`，只有需要重建语义结果时才使用 `rebuild-ai` 或 `full`。

### 停止扫描后为什么仍有部分元数据

扫描按对象逐个提交，停止前已经完成的对象会保留；未完成对象不会写入。只有扫描成功结束后，才会清理数据库中已经删除的旧对象。

### HTTP API 无法调用

检查 API 是否启用、凭据是否已在设置页配置，以及目标地址是否触发私网或 origin 安全策略。认证 API 通过对话创建后默认是禁用状态，必须先补充凭据再启用。

### 只读 SQL 报错

确认只提交一条 `SELECT` 或 `WITH`，不要带分号、注释或写入/DDL 关键字。页面会在当前只读 SQL tab 底部显示错误详情。

## License

MIT
