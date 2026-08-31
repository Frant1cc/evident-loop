# 搜索记录生成 PPTX / PDF：市面 Agent Skill 与自动化链路调研

> 检索日期：2026-08-20<br>
> 资料范围：只采用产品方官网、官方文档、官方仓库、开放规范和项目自身代码。<br>
> 目标场景：将 EvidentLoop 的一次 `research run`（问题、回答、步骤、来源、引用定位、笔记）转成可下载、可追溯、可重复生成的 PPTX 或 PDF。

## 1. 结论摘要

### 1.1 推荐结论

1. **EvidentLoop 已有 Skill 系统，但它是“研究方法 Skill V1”，不是通用 Agent Skills 执行器。** 当前 Skill 由 TypeScript 注册，支持版本、SHA-256 digest、推荐/必需工具、Run 快照和 Prompt 注入；不支持 `SKILL.md`、脚本、模板、资源、依赖声明或多 Skill 组合。见项目自身的 [Skill contracts](../../backend/src/skills/contracts.ts)、[registry](../../backend/src/skills/registry.ts)、[runtime](../../backend/src/skills/runtime.ts) 和 [V1 设计文档](research-workbench-official-skills.md)。这是**已核实事实**。

2. **不要把“技术方案对比”等研究方法 Skill 与“导出 PPTX/PDF”塞进同一个单选 Skill 槽位。** 前者决定如何研究，后者决定如何把已完成研究编排成 Artifact；它们是正交维度。建议保留现有 `ResearchSkillSnapshot`，新增 `ArtifactJob`、`ArtifactSourceSnapshot`、`ArtifactSpec`、`ArtifactRenderer` 和渲染配置注册表。这是基于当前单 Skill 模型和市场实现的**设计推断**。

3. **默认本地链路建议：**

   - PPTX：`research run -> 规范化 Artifact IR -> PptxGenJS -> PPTX -> LibreOffice/兼容渲染器 -> 每页 PNG -> 结构检查 + 视觉检查`。
   - PDF：`research run -> 规范化 Artifact IR -> 语义 HTML/CSS -> Playwright/Chromium print-to-PDF -> 每页 PNG -> 视觉检查`。
   - 对固定坐标、表单或低层 PDF 操作，可增加 ReportLab/pypdf 专用渲染器；WeasyPrint 可作为强调 CSS Paged Media 的 Python 备选。

   这是综合 OpenAI、Anthropic 和各渲染器官方资料后的**推荐推断**，不是任何单一产品承诺。

4. **PptxGenJS 是当前 TypeScript/Node 后端的首选 PPTX 引擎。** 它输出 OOXML，支持 PowerPoint/Keynote/LibreOffice/Google Slides、原生文本/表格/图表、Slide Master、placeholder、speaker notes，以及文件、Buffer/Blob/流输出；许可证为 MIT。[官方仓库](https://github.com/gitbrent/PptxGenJS)、[Masters 与 placeholders](https://gitbrent.github.io/PptxGenJS/docs/masters.html)、[输出方式](https://gitbrent.github.io/PptxGenJS/docs/usage-saving.html)、[MIT License](https://github.com/gitbrent/PptxGenJS/blob/master/LICENSE)（均检索于 2026-08-20）。这是**已核实事实**。

5. **PDF 默认采用 HTML + Playwright，而不是直接绘制 PDF。** OpenAI 官方报告自动化 Skill 明确把“HTML/CSS + Playwright/Puppeteer 打印”列为 PDF 路径，并称其为 Codex 工作流中通常最可靠的模式；Playwright 的 `page.pdf()` 返回 PDF Buffer，并支持页面尺寸、页边距、页眉页脚、背景和 tagged PDF 选项。[OpenAI 官方 Skill](https://github.com/openai/plugins/blob/main/plugins/build-web-data-visualization/skills/reports-pdfs-and-slide-automation/SKILL.md)、[Playwright `page.pdf()`](https://playwright.dev/docs/api/class-page#page-pdf)、[Apache-2.0 License](https://github.com/microsoft/playwright/blob/main/LICENSE)（均检索于 2026-08-20）。前两句是**已核实事实**；将其选为 EvidentLoop 默认方案是**设计推断**。

6. **Gamma 适合做可选的“托管生成”适配器，不适合作为唯一主链路。** Gamma v1 API 可从最多 400,000 字符的输入异步生成 presentation/document，并直接导出 PPTX/PDF/PNG；支持 theme、template、图片和分享。但 API 目前不能修改既有 Gamma，结构化内容结果可能跨运行变化，导出 URL 约一周后过期。[Gamma API 首页](https://developers.gamma.app/)、[POST `/generations`](https://developers.gamma.app/generations)、[API scope and limits](https://developers.gamma.app/reference/common-feature-requests)（均检索于 2026-08-20）。这是**已核实事实**。

7. **Canva 更适合“已有品牌模板 + 数据字段自动填充”，而不是任意研究文本的一键后端排版。** Connect API 的 Autofill 能按模板 dataset 异步生成设计并导出 PDF/PPTX，但生产使用 Brand Template/Autofill 要求 Canva Enterprise 用户，且通过 OAuth 2.0 Authorization Code + PKCE 代表用户操作。[Autofill](https://www.canva.dev/docs/connect/api-reference/autofills/)、[Autofill guide](https://www.canva.dev/docs/connect/autofill-guide/)、[Export API](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)、[Authentication](https://www.canva.dev/docs/connect/authentication/)（均检索于 2026-08-20）。这是**已核实事实**。

### 1.2 一句话选型

| 场景 | 首选 | 原因 |
|---|---|---|
| EvidentLoop 默认 PPTX | PptxGenJS + 本地渲染 QA | Node/TS 原生、PPTX 元素可编辑、MIT、可完全控制引用和重放 |
| EvidentLoop 默认 PDF | HTML/CSS + Playwright + Poppler QA | 与 Web 技术栈一致，长文档排版和视觉迭代成本较低 |
| 固定版式/表单 PDF | ReportLab + pypdf | 直接控制 PDF 对象、表单和页面操作 |
| 强 CSS Paged Media 的 Python 服务 | WeasyPrint | HTML/CSS 到 PDF API 清晰，但必须严密沙箱 |
| 追求最快成品、接受 SaaS 和非确定性 | Gamma API | 一次生成并导出 PPTX/PDF，主题和模板能力完整 |
| 企业品牌模板批量个性化 | Canva Autofill | 模板字段契约和 Canva 原生可编辑设计 |
| 需要修改已有 PPTX | python-pptx 或受控 OOXML/template 路径 | python-pptx 官方支持 create/read/update；PptxGenJS 官方定位主要是创建 |

## 2. 判定口径

文中用以下标签防止把产品声明、工程判断和证据缺口混在一起：

- **已核实事实**：官方资料或当前仓库代码直接支持。
- **推断**：由已核实能力推导出的工程选择，需通过 PoC/测试确认。
- **未知**：官方资料没有承诺，不能按确定事实设计 SLA。

比较维度：

1. 输入契约；
2. 生成流程；
3. 成品可编辑性与源数据可再生性；
4. 渲染验证；
5. 依赖、沙箱和安全；
6. 授权、许可证和数据边界；
7. 对 `research run -> artifact` 的适配程度。

## 3. Skill 层：OpenAI/Codex、Anthropic/Claude 与开放规范

### 3.1 OpenAI / Codex Agent Skills

#### 已核实事实

- OpenAI 将 Skill 定义为包含 `SKILL.md` 的目录，可选包含 `scripts/`、`references/`、`assets/` 和 `agents/openai.yaml`。ChatGPT/Codex 先加载 name/description，触发后再读取完整 `SKILL.md`，即 progressive disclosure。[OpenAI Build skills](https://developers.openai.com/codex/skills)（检索于 2026-08-20）。
- Skill 可被显式选择，也可依据 `description` 隐式触发；Codex 支持仓库、用户、管理员和系统级加载位置，插件可把 Skill、MCP 连接和展示资源打包分发。[OpenAI Build skills](https://developers.openai.com/codex/skills)（检索于 2026-08-20）。
- OpenAI 已弃用旧 `openai/skills` catalog，并把当前示例迁移到 `openai/plugins`；旧仓库仍说明 Agent Skills 是“instructions, scripts, resources”组成的可发现能力包，单个 Skill 的许可证位于各自目录。[OpenAI skills catalog README](https://github.com/openai/skills)（检索于 2026-08-20）。
- OpenAI 官方数据可视化插件中的报告自动化 Skill 推荐：PDF 可走 HTML/CSS + Playwright/Puppeteer，或 pdf-lib/PDFKit/jsPDF；PPTX 可走 PptxGenJS；并要求为图表和图形保留可再生成资产与来源/限制信息。[官方 reports/PDFs/slides Skill](https://github.com/openai/plugins/blob/main/plugins/build-web-data-visualization/skills/reports-pdfs-and-slide-automation/SKILL.md)（检索于 2026-08-20）。
- OpenAI 官方 Google Slides Skill 直接引用 `presentations@openai-primary-runtime`：新建原生 Google Slides 时先创建本地 PPTX，再导入为 native Google Slides；写入后不能只相信 API 成功，要求用新缩略图做视觉验证。[官方 Google Slides Skill](https://github.com/openai/plugins/blob/main/plugins/google-drive/skills/google-slides/SKILL.md)（检索于 2026-08-20）。
- 本机 2026-08-20 安装的 `presentations` Skill 指定以 `@oai/artifact-tool` 的 JavaScript ES module 构建 PPTX，要求每页渲染、逐页视觉检查和 overflow 检查；本机 `pdf` Skill 使用 ReportLab 创建、Poppler 渲染、pdfplumber/pypdf 结构检查；`documents` Skill 对 DOCX 采用 python-docx + LibreOffice render-and-review。以上来自当前 Codex primary runtime 的本地 Skill 快照，是**本机已核实事实**，不是公开 API 稳定性承诺。

#### 输入和输出契约

- 通用 Skill 输入以自然语言任务和工作目录文件为主，Skill 本身通过 `SKILL.md` 声明操作步骤；`scripts/` 和 `assets/` 提供确定性执行与模板。[OpenAI Skill Creator](https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md)（检索于 2026-08-20）。
- `presentations` 本地 Skill 的实际生产输入还需要主题、受众、目的、可选模板/参考 deck、图像资产和来源；输出为 PPTX，并保存来源 notes。这是**本机 Skill 已核实事实**。
- `pdf` 本地 Skill 的输入可为结构化内容、HTML/文本或已有 PDF；输出为 PDF，并以整页 raster review 验证。这是**本机 Skill 已核实事实**。

#### 适配判断

- **推断**：OpenAI 的模式证明“Skill 负责工作流和质量门，渲染器负责文件格式”是合理边界；EvidentLoop 不应把 PptxGenJS/Playwright 本身叫成 Skill。
- **推断**：可借鉴 `SKILL.md + scripts + assets`，但不应直接把 Codex primary runtime 内部的 `@oai/artifact-tool` 当成可再分发的后端依赖。
- **未知**：截至检索日，公开官方文档没有给出 `@oai/artifact-tool` 的独立安装、稳定公共 API、服务端再分发许可或版本兼容承诺。本地 bundled runtime 可用不等于 EvidentLoop 可在生产后端合法/稳定依赖。

### 3.2 Anthropic / Claude Skills

#### 已核实事实

- Anthropic 官方仓库把 Skill 定义为自包含目录，`SKILL.md` 包含 instructions/metadata；文档类 `pptx`、`pdf`、`docx`、`xlsx` Skill 是 Claude 文件能力背后的复杂生产模式示例，但明确是 source-available、不是 open source。[Anthropic skills README](https://github.com/anthropics/skills)（检索于 2026-08-20）。
- Claude API 可在容器上附加预置 Skill，`skill_id` 包括 `pptx`、`pdf`、`docx`、`xlsx`；自定义 Skill 使用组织内 `skill_id` 和可选 version。Managed Agents 可给一个 Agent 附加最多 20 个 Skill，并支持精确版本或 `latest`。[Managed Agents tools and skills](https://raw.githubusercontent.com/anthropics/skills/main/skills/claude-api/shared/managed-agents-tools.md)（检索于 2026-08-20）。
- Anthropic 的 cookbook 示例需要 code execution、Files API、Skills 三个 beta header；Skill 在代码执行容器中创建文件，响应返回 `file_id`，调用方再通过 Files API 下载。[Claude Skills cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/skills/README.md)（检索于 2026-08-20）。
- Anthropic `pptx` Skill 对新 deck 使用 PptxGenJS；对已有 deck/模板使用解压、修改 OOXML、重新打包；提供 thumbnail、Office schema/relationship/content-type validation 和 LibreOffice PDF 转换脚本；要求保持图表为 PowerPoint 原生对象，speaker notes 用 `slide.addNotes()`。[Anthropic `pptx` Skill](https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md)（检索于 2026-08-20）。
- Anthropic `pdf` Skill 是工具编排指南：pypdf 处理页面，pdfplumber 提取文本/表格，ReportLab 创建 PDF，Poppler/qpdf/pdftk/Tesseract 处理转换、拆分和 OCR。[Anthropic `pdf` Skill](https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md)（检索于 2026-08-20）。
- Anthropic 文档 Skill 的许可证附带强限制，包括不得在服务外提取/保留、复制、制作衍生作品或分发；它不是可直接拷贝进 EvidentLoop 的开源实现。[Anthropic PPTX Skill License](https://github.com/anthropics/skills/blob/main/skills/pptx/LICENSE.txt)（检索于 2026-08-20）。
- Managed Agents 对仓库 `.claude/skills` 的说明明确指出：仓库 Skill 是 Agent instructions，属于信任边界；能提交代码的人可以修改 Skill，结合 bash/web_fetch 会形成真实执行能力，因此必须审计可信仓库。[Managed Agents tools and skills](https://raw.githubusercontent.com/anthropics/skills/main/skills/claude-api/shared/managed-agents-tools.md)（检索于 2026-08-20）。

#### 输入和输出契约

- API 入口是：模型消息 + container skills + code execution tool；输出通过 `file_id`/Files API 取回。这是**已核实事实**。
- `pptx` Skill 自身仍以自然语言 brief、模板/已有 PPTX 和本地资产为输入，并生成/修改文件；没有面向业务系统的稳定 `ResearchArtifactSpec` JSON。这是从官方 Skill 内容得到的**已核实事实**。

#### 适配判断

- **推断**：Claude API 托管 Skill 可作为快速 PoC 或可选远程 renderer，但会把研究内容和输出文件发送到第三方执行环境，且输出成本、排队和生命周期受 Anthropic API 控制。
- **推断**：Anthropic 的“PptxGenJS 创建 + OOXML 模板修改 + LibreOffice/thumbnail 验证”是值得复制的技术路径，但不能复制其 proprietary Skill 文本和脚本。
- **未知**：预置 Skill 在不同 Claude 版本、容器镜像、字体集和模板复杂度下的完全确定性与跨版本像素一致性没有官方 SLA。

### 3.3 Agent Skills 开放规范

#### 已核实事实

- 开放规范要求一个 Skill 目录至少有 `SKILL.md`；frontmatter 必含 `name` 和 `description`，可含 `license`、`compatibility`、`metadata` 和实验性 `allowed-tools`。[Agent Skills specification](https://agentskills.io/specification)（检索于 2026-08-20）。
- 推荐目录为 `scripts/`、`references/`、`assets/`；依赖和兼容性由 Skill 声明，实际支持语言由宿主决定。[Agent Skills specification](https://agentskills.io/specification)（检索于 2026-08-20）。
- 规范推荐 progressive disclosure：启动时 name/description，激活时完整 `SKILL.md`，按需加载脚本/参考/资产；`SKILL.md` 建议小于 500 行。[Agent Skills specification](https://agentskills.io/specification)（检索于 2026-08-20）。

#### 对 EvidentLoop 的意义

- **推断**：若未来要支持用户/组织安装 Skill，采用该目录规范可减少供应商锁定。
- **推断**：当前阶段不应立即开放任意 `scripts/`，因为 EvidentLoop V1 的安全模型是“Skill 只追加受信任 Prompt，ToolRuntime 才能执行能力”。开放脚本会改变信任边界、依赖供应链、沙箱和审批模型。
- **建议**：先让 Artifact renderer registry 支持受信任代码和内置模板；以后再把经过签名、依赖锁定、静态审计和权限声明的 Agent Skill 映射到这个 registry。

## 4. PPTX 开源生成链路

### 4.1 PptxGenJS

| 维度 | 结论 |
|---|---|
| 输入契约 | JavaScript/TypeScript API；文本、表格、图表、shape、图片、media、master、placeholder、speaker notes。|
| 生成流程 | 新建 Presentation -> 设置 layout/theme/master -> 添加 slides/objects -> `writeFile()`、`write()` 或 stream。|
| 可编辑性 | 输出标准 OOXML；原生文本、表格、shape、chart 保持为 PowerPoint 可编辑对象。复杂非原生视觉若以 PNG/SVG 插入，只能作为图像编辑。|
| 模板能力 | 可定义 Slide Master 和 placeholder；官方文档主要面向生成，不宣传通用“导入并修改任意现有 PPTX”。|
| 渲染验证 | 库本身生成 PPTX，不提供等价于 PowerPoint 的最终渲染验证；需要 LibreOffice/PowerPoint/其他 renderer + PNG review。|
| 依赖 | Node/browser；官方仓库说明可用于 Node、React、Vite、Electron、浏览器和 serverless。|
| 许可证 | MIT。|
| EvidentLoop 适配 | **高**：与 TypeScript/Node 技术栈一致，适合从 typed IR 生成。|

官方依据：[PptxGenJS introduction](https://gitbrent.github.io/PptxGenJS/docs/introduction/)、[Saving presentations](https://gitbrent.github.io/PptxGenJS/docs/usage-saving.html)、[Masters/placeholders](https://gitbrent.github.io/PptxGenJS/docs/masters.html)、[Speaker notes](https://gitbrent.github.io/PptxGenJS/docs/speaker-notes/)、[MIT License](https://github.com/gitbrent/PptxGenJS/blob/master/LICENSE)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：OOXML 输出、环境支持、master/placeholder/notes、输出方式和 MIT license。
- **推断**：对本项目的适配评级、需要额外 renderer 和“不要用于任意 PPTX round-trip”的边界。
- **未知**：没有用目标中文字体、复杂图表、超长引用和 Windows/LibreOffice 做过当前项目 PoC 前，不能保证版式一致。

### 4.2 python-pptx

| 维度 | 结论 |
|---|---|
| 输入契约 | Python 对象 API，可新建、读取和更新 `.pptx`；可从数据库查询、analytics output 或 JSON payload 生成。|
| 生成流程 | 加载/创建 `Presentation` -> 操作 slide/layout/master/placeholder/shape/table/chart/text -> 保存。|
| 可编辑性 | 输出 OOXML；支持的元素保持可编辑。|
| 模板能力 | 相比只生成新文件，更适合读取和更新已有 PPTX；但 PowerPoint 格式很大，官方明确仍有未支持功能。|
| 渲染验证 | 不自带 PowerPoint 渲染器；仍需 LibreOffice/PowerPoint + raster QA。|
| 依赖 | Python；不要求安装或许可 PowerPoint。|
| 许可证 | MIT。|
| EvidentLoop 适配 | **中**：能力成熟，但会引入 Python worker/依赖层；更适合已有模板编辑的专用后端。|

官方依据：[python-pptx 1.0.0 docs](https://python-pptx.readthedocs.io/en/latest/)、[Working with Presentations](https://python-pptx.readthedocs.io/en/stable/user/presentations.html)、[MIT License](https://github.com/scanny/python-pptx/blob/master/LICENSE)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：create/read/update、无需 PowerPoint、API 覆盖和 MIT license。
- **推断**：作为模板编辑专用 renderer，而不是默认 Node 路径。
- **未知**：目标企业模板中的 SmartArt、动画、复杂 charts、嵌入对象和主题是否能无损 round-trip，必须逐模板验证。

### 4.3 PPTX 的可编辑性不是二元值

建议把 Artifact QA 中的“可编辑性”拆为：

1. `editableText`: 标题、正文、脚注、来源是否是文本对象；
2. `editableCharts`: 数据图是否为 native chart，而不是截图；
3. `editableTables`: 表格是否为 native table；
4. `editableLayout`: 是否使用 master/layout/placeholder；
5. `rebuildable`: Artifact IR、模板版本、renderer 版本、资产 hash 是否齐全；
6. `visualPlateRatio`: 有多少页面面积是不可编辑的 raster image。

这套指标是**设计建议**。Anthropic 官方 PPTX Skill 强调 native chart 和 speaker notes；OpenAI 本机 Skill 也要求关键文字/图表为可编辑对象并做逐页验证，二者支持该方向，但具体指标不是厂商标准。

## 5. PDF 开源生成链路

### 5.1 HTML/CSS + Playwright/Chromium

| 维度 | 结论 |
|---|---|
| 输入契约 | 语义 HTML + print CSS + 本地/受控资产；可由 typed Artifact IR 模板化生成。|
| 生成流程 | 生成静态 HTML -> 禁止/限制网络和脚本 -> Chromium 加载 -> `page.pdf()` -> PDF。|
| 可编辑性 | PDF 成品是固定版面；真正可编辑的是 HTML/CSS/Artifact IR，可稳定重生成。|
| 布局能力 | CSS 布局、字体、表格、SVG、分页、页眉页脚；Playwright 支持尺寸、边距、背景、outline 和 tagged PDF 选项。|
| 渲染验证 | 同一 Chromium 能预览 HTML；最终 PDF 仍应由 Poppler raster 成 PNG 逐页检查。|
| 依赖 | Node + Playwright + Chromium，镜像体积和冷启动大于纯 JS PDF 库。|
| 许可证 | Playwright Apache-2.0。|
| EvidentLoop 适配 | **很高**：TypeScript/HTML 技术栈一致，适合长报告、来源列表和丰富图表。|

官方依据：[OpenAI reports/PDFs/slides Skill](https://github.com/openai/plugins/blob/main/plugins/build-web-data-visualization/skills/reports-pdfs-and-slide-automation/SKILL.md)、[Playwright `page.pdf()`](https://playwright.dev/docs/api/class-page#page-pdf)、[Apache-2.0 License](https://github.com/microsoft/playwright/blob/main/LICENSE)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：`page.pdf()` 能返回 PDF Buffer，支持主要 print 参数；OpenAI 官方 Skill 推荐 HTML-first。
- **推断**：它是本项目默认 PDF 路径。
- **未知**：Chromium 的 tagged PDF 选项不自动保证 PDF/UA 合规；无障碍合规需要独立审计。

### 5.2 WeasyPrint

| 维度 | 结论 |
|---|---|
| 输入契约 | HTML/CSS 字符串、文件或 URL，可配置 base URL、字体和 URL fetcher。|
| 生成流程 | `HTML(...).render()` 或 `write_pdf()`；可取得 pages、metadata 和 PDF bytes。|
| 可编辑性 | 同样以 HTML/CSS/IR 为可编辑源，PDF 是固定成品。|
| 渲染验证 | 仍需输出后 raster review。|
| 依赖 | Python、Pango、Harfbuzz 等系统库；Windows 安装明显复杂于 Playwright。|
| 安全 | 官方明确警告不可信 HTML/CSS 可导致高内存、无限/超长渲染、本地文件泄露和危险附件；建议非 root、限制文件系统/网络/内存、容器、超时和自定义 URL fetcher。|
| 许可证 | BSD 3-Clause。|
| EvidentLoop 适配 | **中高**：适合 CSS paged media，但增加 Python/系统库和沙箱运维。|

官方依据：[WeasyPrint First Steps and Security](https://doc.courtbouillon.org/weasyprint/latest/first_steps.html)、[API reference](https://doc.courtbouillon.org/weasyprint/latest/api_reference.html)、[BSD-3-Clause License](https://github.com/Kozea/WeasyPrint/blob/main/LICENSE)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：API、依赖和官方安全警告。
- **推断**：作为 Playwright 的可选 renderer，而不是首选。
- **未知**：目标中文字体、复杂 SVG 和大报告在 Windows/Linux 镜像中的性能上限。

### 5.3 ReportLab

| 维度 | 结论 |
|---|---|
| 输入契约 | Python 对象图；低层 `pdfgen` Canvas 或高层 Platypus Flowables。|
| 生成流程 | 程序化创建页面、文本、表格、图形、图表并直接写 PDF。|
| 可编辑性 | PDF 成品固定；Python/Artifact IR 可再生成。|
| 布局能力 | 精确绘制、流式文档、表格和矢量图强；对 Web 团队而言模板开发成本通常高于 HTML/CSS。|
| 渲染验证 | 仍需 Poppler raster review；文本抽取不能替代视觉检查。|
| 依赖 | Python；ReportLab 4.x 核心已转纯 Python，位图功能可能需要 PyCairo/Pillow 等扩展。|
| 许可证 | 开源 toolkit 为 BSD；ReportLab PLUS/RML 是商业产品，不应混淆。|
| EvidentLoop 适配 | **中**：适合表单、证书、发票、固定报告或 PDF 原生操作；不建议作为所有研究报告的唯一布局层。|

官方依据：[ReportLab docs](https://docs.reportlab.com/)、[User Guide introduction](https://docs.reportlab.com/reportlab/userguide/ch1_intro/)、[Developer FAQ / BSD license](https://docs.reportlab.com/developerfaqs/)、[Open-source installation](https://docs.reportlab.com/install/open_source_installation/)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：直接生成 PDF、对象模型、BSD toolkit 和商业 PLUS 的区分。
- **推断**：将其限定为专用 renderer。
- **未知**：当前项目所需的复杂排版是否值得维护第二套模板系统，应由 PoC 成本决定。

### 5.4 Poppler 作为 QA 而不是生成器

- Poppler 官方定位是基于 xpdf 的 PDF rendering library；适合把最终 PDF 页面 raster 成 PNG，再做人工或视觉模型检查。[Poppler 官方站](https://poppler.freedesktop.org/)（检索于 2026-08-20）。这是**已核实事实**。
- **推断**：结构验证与视觉验证必须同时存在。`pdfplumber`/pypdf 的文本抽取、页数和 metadata 检查无法发现 clipping、字体替换、错页、元素重叠和不可读图表。

## 6. 托管产品：Gamma 与 Canva

### 6.1 Gamma v1 API / MCP

| 维度 | 结论 |
|---|---|
| 输入契约 | `inputText` 1..400,000 字符；`textMode` 为 generate/condense/preserve；format、numCards、themeId、text/image/card/sharing options；或 from-template。|
| 生成流程 | `POST /v1.0/generations` -> 返回 generationId -> 轮询 GET status -> 取得 gammaUrl 和可选 exportUrl。|
| 输出 | presentation/document/social/webpage；单次可选导出 `pptx`、`pdf` 或 `png`，不能一次请求多个格式。|
| 可编辑性 | 可在 Gamma App 继续编辑；API 不能编辑既有 Gamma，只能以修订输入重新生成。导出 PPTX 的逐元素可编辑性/复杂元素 round-trip 未见官方保证。|
| 可预测性 | 官方说明 charts/tables/infographics 可通过 prompt 生成，但结果跨运行变化；template generation 更可预测。|
| 验证 | API 返回文件/URL，但官方没有提供“逐页像素 QA 通过”的保证；仍需本地下载并检查。|
| 依赖/认证 | REST API 使用 `X-API-KEY`；API key 需要 Pro/Ultra/Teams/Business。MCP 可用 OAuth/DCR，连接器可覆盖更多计划。|
| 数据边界 | 研究正文和公开图片 URL 会发送到 Gamma；Gamma 会抓取并重新托管图片。|
| EvidentLoop 适配 | **中高（可选）**：适合快速成品和营销/管理 deck；不适合要求完全确定、私有本地和强引用版式的唯一链路。|

官方依据：[Gamma developer docs](https://developers.gamma.app/)、[POST `/generations`](https://developers.gamma.app/generations)、[Generate guide](https://developers.gamma.app/guides)、[API scope and limits](https://developers.gamma.app/reference/common-feature-requests)、[MCP](https://developers.gamma.app/mcp)、[Access and pricing](https://developers.gamma.app/get-started/access-and-pricing)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：契约、异步轮询、导出格式、计划要求、不能编辑 existing gamma、临时 export URL、结果变化提示。
- **推断**：把它放在显式 opt-in 的 SaaS renderer，生成后回灌本地 Artifact Store。
- **未知**：PPTX 每类元素的原生可编辑比例、来源引用在 speaker notes/footnote 的保真、视觉一致性 SLA、企业数据驻留和具体合同责任；这些需在采购/安全评审中确认。

### 6.2 Canva Connect API / Apps SDK

| 维度 | 结论 |
|---|---|
| 输入契约 | 后端 Connect API 最成熟的内容生成路径是 Brand Template/Design dataset + text/image/chart/sheet fields；先查询 dataset，再提交 async autofill job。|
| 生成流程 | OAuth -> 读取模板 dataset -> 上传所需资产 -> `POST /autofills` -> 轮询结果 -> 得到 Canva design -> Export job -> PDF/PPTX。|
| 输出 | Canva 原生 design 可继续编辑；Export API 支持 PDF、PPTX 等格式。|
| 可编辑性 | Canva 原生 design 高；PPTX 导出后逐元素可编辑性和复杂元素保真未见统一官方承诺。|
| 自动化边界 | Connect API 适合模板实例化和导出；Apps SDK Design Editing API 能读写 pages/elements，但运行在 Canva App 设计上下文，不等同于普通后端 Connect API。|
| 验证 | Connect API 可读取 page metadata/thumbnails（部分 API 为 preview）；仍建议下载导出文件做本地 QA。|
| 依赖/认证 | OAuth 2.0 Authorization Code + PKCE，按最小 scopes 代表用户操作。Autofill 生产使用要求用户属于 Canva Enterprise。|
| 数据边界 | 内容和图片资产上传到 Canva 用户/组织空间；需纳入用户授权、tenant mapping 和删除策略。|
| EvidentLoop 适配 | **中（通用生成）/高（品牌模板批量化）**。|

官方依据：[Canva Authentication](https://www.canva.dev/docs/connect/authentication/)、[Autofill APIs](https://www.canva.dev/docs/connect/api-reference/autofills/)、[Autofill guide](https://www.canva.dev/docs/connect/autofill-guide/)、[Create design autofill job](https://www.canva.dev/docs/connect/api-reference/autofills/create-design-autofill-job/)、[Export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)、[Scopes](https://www.canva.dev/docs/connect/appendix/scopes/)、[Design Editing API](https://www.canva.dev/docs/apps/design-editing/)（均检索于 2026-08-20）。

状态边界：

- **已核实事实**：OAuth/PKCE、scope、Enterprise Autofill、dataset/job/export 流程、导出 PDF/PPTX、Apps SDK 与元素支持边界。
- **推断**：Canva adapter 只在用户选择品牌模板时出现，不做默认 renderer。
- **未知**：Connect API 能否在不依赖预置模板的情况下，完全后端化地把任意研究大纲排成高质量多页 deck；当前官方资料没有给出与 Gamma Generate API 等价的通用生成端点承诺。

## 7. 横向比较

评分：5 为最匹配 EvidentLoop 的本地、可追溯、可再生成目标。评分是**工程推断**，不是厂商基准测试。

| 方案 | Skill/Renderer | 输入结构化 | PPTX 可编辑 | PDF 能力 | 本地/私有 | 确定性 | 自带视觉 QA | 许可清晰 | 综合适配 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| OpenAI/Codex primary-runtime | 完整 Skill + bundled renderer | 3 | 5 | 5 | 4 | 4 | 5 | 2 | 3 |
| Anthropic hosted Skills | 完整 Skill + 托管容器 | 3 | 5 | 5 | 1 | 3 | 4 | 2 | 3 |
| PptxGenJS | PPTX renderer | 5 | 5 | 0 | 5 | 5 | 1 | 5 | 5 |
| python-pptx | PPTX renderer/editor | 5 | 5 | 0 | 5 | 5 | 1 | 5 | 4 |
| HTML + Playwright | PDF renderer | 5 | 0 | 5 | 5 | 5 | 3 | 5 | 5 |
| WeasyPrint | PDF renderer | 5 | 0 | 5 | 5 | 5 | 2 | 5 | 4 |
| ReportLab | PDF renderer | 5 | 0 | 5 | 5 | 5 | 1 | 5 | 3 |
| Gamma v1 API | 托管生成器 | 4 | 3 | 5 | 1 | 2 | 1 | 3 | 3 |
| Canva Autofill | 模板自动化 | 5 | 3 | 5 | 1 | 5 | 2 | 3 | 3/5（通用/模板） |

说明：

- OpenAI primary-runtime “许可清晰=2”只针对其内部 bundled artifact runtime 的公开再分发边界未知，不代表 OpenAI 产品不可用。
- Anthropic “许可清晰=2”是因为文档 Skill 明确 proprietary 且禁止服务外复制，不是 API 合同本身含糊。
- “自带视觉 QA”指方案或 Skill 明确要求并提供渲染检查链路；单纯能导出/预览不算 QA 通过。

## 8. 对当前 EvidentLoop 的核实结果

### 8.1 已有能力

以下是 2026-08-20 当前工作区代码的**已核实事实**：

- 已有 `OfficialResearchSkill`、`ResearchSkillSnapshot`、`ResearchSkillInfo` 和 runtime/registry。[contracts](../../backend/src/skills/contracts.ts)、[registry](../../backend/src/skills/registry.ts)、[runtime](../../backend/src/skills/runtime.ts)。
- Skill 定义校验 id、version、label、description、instructions、4000 字符上限、known tools，以及 required 必须属于 recommended；对定义计算稳定 SHA-256 digest。[registry](../../backend/src/skills/registry.ts)。
- Research Run 持久化 `skill?: ResearchSkillSnapshot` 和 `executionMode`；无 Skill 且无 Tool 时可走 quick conversation，否则走 research agent。[research types](../../backend/src/research/types.ts)、[executionMode](../../backend/src/research/executionMode.ts)。
- 当前 `ArtifactStore` 只接受 DOCX：文件名 sanitizer 固定 `.docx`，content type 固定 Word MIME，存储文件固定 `${artifactId}.docx`。[ArtifactStore](../../backend/src/artifacts/store.ts)。
- 当前 Research 记录已经有 messages、steps、sources、notes、citationKey、locator、tool input/output，具备生成 Artifact 的核心原料。[research types](../../backend/src/research/types.ts)、[research store](../../backend/src/research/store.ts)。

### 8.2 缺口

以下是从当前代码与目标对比得到的**已核实缺口**：

1. ArtifactStore 是 DOCX 专用，无法存 PPTX/PDF 或 preview/manifest。
2. Research Skill 是 Prompt 方法层，不支持 renderer、template、assets、dependencies、capabilities 或输出格式。
3. 没有 Artifact Job 状态机、重试、取消、幂等键、renderer version、source snapshot 或 QA 结果持久化。
4. 没有中立的 Artifact IR；直接把 research 最终 Markdown 喂给各 renderer 会导致 PPTX/PDF 内容漂移。
5. 没有 PPTX/PDF render-to-PNG 统一 QA、字体检查、overflow 检查或引用覆盖检查。
6. 没有 SaaS provider 的授权/数据外发策略。

### 8.3 最关键的模型调整

**不要把输出格式建模为现有 `skillId`。** 当前一个 Run 只能选一个研究 Skill；如果用户选择“技术方案对比”后又要“生成 PPTX”，两者会冲突。建议：

```text
Research Method Skill (现有)
        |
        v
completed Research Run + immutable source snapshot
        |
        v
Artifact Job (新增，outputKind/provider/template/qaPolicy)
        |
        v
Artifact Planner -> typed ArtifactSpec -> Renderer -> Validator -> Store
```

这是**设计建议**。未来如果 UI 需要把 Artifact workflow 也称为 Skill，可在上层展示为“输出技能”，但后端仍应保持方法 Skill 与 renderer capability 分离。

## 9. 建议的目标契约

### 9.1 Artifact Source Snapshot

生成必须绑定一次不可变快照，不能在渲染过程中重新读取会变化的 conversation：

```ts
type ArtifactSourceSnapshot = {
  researchRunId: string;
  conversationId: string;
  assistantMessageId: string;
  contentHash: string;
  generatedAt: string;
  prompt: string;
  answerMarkdown: string;
  notes: Array<{ id: string; content: string }>;
  sources: Array<{
    id: string;
    citationKey: string;
    title: string;
    url?: string;
    locator?: unknown;
    excerpt?: string;
  }>;
};
```

这是**设计建议**。`contentHash` 用于幂等、审计和重新生成判断。

### 9.2 Artifact Request

```ts
type ArtifactRequest = {
  source: { researchRunId: string; assistantMessageId?: string };
  outputKind: 'pptx' | 'pdf';
  provider: 'local' | 'gamma' | 'canva';
  audience?: string;
  purpose?: string;
  language?: string;
  title?: string;
  templateId?: string;
  themeId?: string;
  length?: { slides?: number; pages?: number };
  citationMode: 'speaker-notes' | 'footnotes' | 'references' | 'both';
  imagePolicy: 'none' | 'existing-only' | 'search' | 'generate';
  qaPolicy: 'standard' | 'strict';
};
```

这是**设计建议**。其中 provider 必须是显式选择；私有研究默认 `local`。

### 9.3 中立 Artifact IR

Renderer 不应直接消费聊天文本，建议先生成可校验的中立 IR：

```ts
type ArtifactSpec = {
  version: '1';
  metadata: {
    title: string;
    audience: string;
    purpose: string;
    language: string;
    researchRunId: string;
    sourceSnapshotHash: string;
  };
  narrative: {
    thesis: string;
    sections: Array<{
      id: string;
      heading: string;
      takeaway: string;
      blocks: ArtifactBlock[];
      citations: string[];
    }>;
  };
  sources: Record<string, {
    citationKey: string;
    title: string;
    url?: string;
    locator?: unknown;
  }>;
  assets: Array<{
    id: string;
    kind: 'image' | 'chart-data' | 'table-data';
    contentHash: string;
    sourceCitationKeys: string[];
  }>;
};
```

PPTX renderer 把 section 映射为 slides；PDF renderer 把相同 IR 映射为 sections/pages。这样能测试“内容一致但版式不同”，避免两条生成链各自重新总结研究。

## 10. 建议的生成流程和质量门

### 10.1 通用状态机

```text
queued
  -> snapshotting
  -> planning
  -> rendering
  -> validating_structure
  -> rendering_preview
  -> validating_visual
  -> completed

任一步可进入 failed / cancelled
```

建议持久化：

- `artifactJobId`、`researchRunId`、`assistantMessageId`；
- request、source hash、ArtifactSpec version/hash；
- renderer id/version、template/theme id/version；
- status、progress、attempt、error code；
- output artifact id、preview artifact ids、manifest id；
- structure QA、visual QA、citation QA、font QA；
- provider request id（仅 SaaS）、data egress consent/audit。

### 10.2 PPTX 质量门

1. OOXML ZIP 可打开；
2. slide count 与 IR 一致；
3. relationships/content types 无悬挂；
4. 所有标题/来源/关键数字可在 XML 中检索；
5. 所有外部事实的 citationKey 都在 speaker notes 或 references slide；
6. PPTX 转 PDF/PNG，逐页检查 clipping、overlap、wrap、字体替换、图表标注和空 placeholder；
7. 原生对象比例达到 policy；
8. 输出和 builder/IR 的 hash/版本记录齐全。

Anthropic 官方 Skill 的 schema/relationship validation、thumbnail 和 LibreOffice 转换，以及 OpenAI 本机 Skill 的逐页 render/overflow 检查，支持这条质量路线；具体门槛是**设计建议**。

### 10.3 PDF 质量门

1. PDF 可解析、页数合理、metadata 正确；
2. 文本抽取包含标题、关键结论、来源；
3. 每页 raster 成 PNG 并逐页检查；
4. 链接、书签、页码、页眉页脚符合 request；
5. 字体已嵌入或使用受控 fallback；
6. 表格跨页、孤行、图片分辨率和代码块换行通过；
7. 如要求 accessibility，额外做 tagged structure/PDF-UA 专项审计，不能只检查 `tagged: true`。

这是**设计建议**。

## 11. 安全、沙箱和供应链要求

### 11.1 本地 renderer

建议强制：

- renderer 在无管理员权限、受限文件系统、受限网络、CPU/内存/时间限制的 worker 中运行；
- Artifact IR 的文本必须 HTML escape，不能直接拼接为可执行 HTML；
- 禁止 renderer 任意读取 workspace；只挂载 job temp、approved assets、template；
- HTML/PDF renderer 默认无网络；图片由 AssetResolver 预下载、校验 MIME/大小/hash 后提供本地 URI；
- 限制重定向、私网地址、`file://`、data URI 大小和 SVG 外部引用，防 SSRF/本地文件泄漏；
- 模板 PPTX/POTX 按不可信 ZIP 处理，限制压缩比、解压大小、entry 数、路径穿越和宏；
- 字体、模板、图片、图标必须记录许可证或来源；不能因为“AI 生成”而跳过权利审查；
- PptxGenJS、Playwright/Chromium、LibreOffice/Poppler、Python packages 版本锁定并生成 SBOM。

WeasyPrint 官方明确列出了不可信 HTML/CSS 的资源耗尽、本地文件和附件风险；OpenAI/Anthropic Skill 都把脚本/仓库 Skill 视为真实执行能力。上述扩展控制是基于这些事实的**安全设计建议**。

### 11.2 SaaS provider

Gamma/Canva adapter 必须：

1. 默认关闭，用户/管理员显式启用；
2. 在发送前显示会外发的内容范围；
3. 按 workspace/tenant 隔离凭据；
4. 凭据不进入 Prompt、日志、ArtifactSpec 或 renderer temp；
5. Gamma API key 只放后端 secret store；Canva token 按 OAuth 用户/tenant 绑定并最小 scope；
6. 保存 provider request id，不保存不必要的原始请求；
7. 下载导出文件后立即本地验证，并按 provider 规则处理临时 URL；
8. 支持撤销连接和删除 provider 侧生成物的运维流程。

这是**设计建议**。Gamma/Canva 的认证、scope 和临时 URL 行为由上文官方来源支持。

## 12. 分阶段落地建议

### Phase 0：PoC（先回答未知项）

用同一个已完成 research run 做四个固定样例：

1. 纯中文技术对比；
2. 含 2 个图表、1 个表格；
3. 20+ 来源与精确 locator；
4. 超长正文与长 URL。

分别生成：

- PptxGenJS PPTX；
- HTML + Playwright PDF；
- 可选 Gamma PPTX/PDF；
- 可选 Canva template PPTX/PDF。

测量：生成时延、峰值内存、文件大小、字体替换、overflow、引用覆盖、native object ratio、二次生成稳定性、跨 PowerPoint/LibreOffice 渲染差异。

### Phase 1：本地 MVP

- 泛化 ArtifactStore：按 metadata 决定 extension/contentType，支持 PPTX/PDF/PNG/JSON manifest；
- 新增 Artifact Job API 和持久化；
- 实现 source snapshot 和 typed ArtifactSpec；
- PPTX renderer：PptxGenJS；
- PDF renderer：HTML + Playwright；
- LibreOffice/Poppler preview worker；
- 基础结构/视觉/citation QA；
- 前端提供“生成 PPTX / 生成 PDF”，显示进度、preview、下载和失败原因。

### Phase 2：模板和重新生成

- 版本化模板、theme tokens 和字体包；
- ArtifactSpec 可编辑；
- 只重渲染、不重新研究；
- 输出历史、对比和 reproducibility manifest；
- 模板型 PPTX round-trip PoC 后，再决定 python-pptx/OOXML 专用路径。

### Phase 3：托管 provider

- Gamma adapter：显式 opt-in，适合快速视觉 deck；
- Canva adapter：只在 Enterprise brand template 场景启用；
- provider 级数据外发政策、预算、限流、重试、删除和审计。

### Phase 4：开放 Skill 包

只有在完成以下能力后，才考虑兼容 Agent Skills 目录：

- 签名/来源验证；
- 依赖锁定与 SBOM；
- `allowed-tools`/capability 映射；
- 脚本沙箱；
- 网络和文件系统权限；
- 版本、回滚、禁用、tenant policy；
- 触发评测和输出评测。

## 13. 需要产品确认的问题

这些问题决定实现方向，当前都不能由市场资料替用户选择：

1. PPTX 是“用户继续编辑”还是“只用于演示/下载”？前者要求更高 native object ratio。
2. PDF 是正式报告、打印版、归档版还是轻量分享版？是否要求 PDF/A、PDF/UA 或电子签名？
3. Artifact 默认基于最后一个 assistant message，还是整个 conversation/指定 run？
4. 生成前是否允许用户编辑大纲、受众、标题和来源范围？
5. 来源应该显示在每页脚注、PPT speaker notes、末尾 references，还是三者兼有？
6. 是否允许联网找配图/调用图片生成？是否必须只用 research run 现有证据？
7. 是否允许把研究内容发送到 Gamma/Canva/Anthropic/OpenAI 托管环境？哪些 workspace 禁止？
8. 生成物保存 24 小时、长期保存，还是跟随 conversation 生命周期？
9. 是否需要企业 PPTX/POTX、Canva brand template、字体包和品牌素材管理？
10. 谁对视觉 QA 负责：自动门禁、人工确认，还是两者结合？

## 14. 最终建议

**建议批准的技术基线：**

```text
现有 Research Skill Runtime 保持不变
                 |
completed run -> immutable ArtifactSourceSnapshot
                 |
          Artifact Planner
                 |
          typed ArtifactSpec
           /             \
PptxGenJS renderer    HTML/Playwright renderer
       |                       |
     PPTX                     PDF
       |                       |
LibreOffice -> PNG        Poppler -> PNG
           \             /
        Structure + Visual + Citation QA
                    |
          Generalized ArtifactStore
```

Gamma 和 Canva 作为 `provider` adapter，而不是替代 typed IR、本地存储和 QA。这样即使未来更换模型、SaaS 或渲染器，`research run -> ArtifactSpec` 的证据链、引用和重放能力仍留在 EvidentLoop 内。

## 15. 未知项与验证清单

在 PoC 完成前，下列内容必须继续标为**未知**：

- `@oai/artifact-tool` 是否可作为 EvidentLoop 独立后端依赖及其许可/版本政策；
- 中文字体在 PptxGenJS + LibreOffice、Playwright + Chromium 下的生产镜像一致性；
- PowerPoint、LibreOffice Impress、Google Slides 对同一 PPTX 的像素级差异；
- Gamma 导出 PPTX 的 native text/chart/table 比例和 speaker notes 引用能力；
- Canva PPTX export 对复杂 template、chart、sheet、group 和字体的可编辑性/保真；
- tagged PDF 是否满足目标无障碍规范；
- 20+ 来源、长 URL、长表格、复杂 SVG、大图资产的性能上限；
- 视觉模型 QA 的误报/漏报率，以及是否需要人工批准。

这些未知项不能用供应商“支持导出 PPTX/PDF”的声明替代实测。
