# HotpotQA 多跳推理探索平台

一个基于 Web 的交互式工具，用于探索 [HotpotQA](https://hotpotqa.github.io/) 数据集 —— 一个多跳问答评测基准。构建为一个完全静态的站点，托管在 **GitHub Pages** 上。

## 关于 HotpotQA 数据集

[HotpotQA](https://hotpotqa.github.io/) 是由卡内基梅隆大学、斯坦福大学和 Google Research 联合推出的多跳问答（Multi-Hop Question Answering）数据集。与传统的单跳问答不同，HotpotQA 中的每个问题**需要从多个 Wikipedia 文档中提取并综合多条信息才能回答**，模拟了人类面对复杂问题时"查阅多个来源、串联多条线索"的认知过程。

### 数据集核心特征

- **多跳推理（Multi-Hop Reasoning）**：每个问题都标注了多条"支持性事实"（supporting facts），这些事实散布在不同的 Wikipedia 文章里。模型（或人类）必须找出这些分散的证据，并按逻辑顺序串联起来，才能推导出正确答案。例如问题"2016 年奥斯卡最佳影片的导演出生在哪个城市？"需要：第 1 跳 → 找到 2016 年奥斯卡最佳影片是《聚焦》(Spotlight)；第 2 跳 → 找到《聚焦》的导演是 Tom McCarthy；第 3 跳 → 找到 Tom McCarthy 的出生城市。
- **两种问题类型**：
  - **Bridge（桥接）**：推理链呈线性，从 A 到 B 再到 C，需要一步步"搭桥"。约占数据集的 55%。
  - **Comparison（比较）**：需要同时检索两个实体的信息并进行对比，如"A 和 B 哪个更高？"
- **干扰项设计**：每个问题附带 8 篇 Wikipedia 文章作为上下文，其中只有 2 篇包含真正的支持性事实，其余 6 篇是语义相关的"干扰项"——这考验了模型区分相关信息与噪声的能力。
- **规模**：训练集约 90,000 条，验证集约 7,400 条，同时提供"distractor"（带干扰项）和"fullwiki"（全量 Wikipedia）两种设置。
- **实体标注**：每条支持性事实都关联了命名实体，便于追踪实体间的语义关联。

### 为什么多跳推理重要？

当前的 NLP 模型在单段落抽取式问答上已接近人类水平，但在需要**跨文档信息整合、逻辑推理和证据链构建**的任务上仍有显著差距。HotpotQA 正是为此而生——它不仅评测"答案是否正确"，更要求模型**输出完整的推理路径**，从而推动了可解释 AI 的发展。

## 本 Web 工具的工作内容

本工具将 HotpotQA 数据集从"扁平化的 JSON 问答对"转化为**交互式图网络**，让研究者、开发者和学习者能够以可视化的方式直观理解多跳推理的结构。具体来说，它做了以下工作：

### 1. 数据预处理 — 从文本到图

[preprocess.py](scripts/preprocess.py) 脚本执行以下流水线：

- **下载与采样**：从 HuggingFace Hub 下载 HotpotQA 的 distractor 子集，按 bridge/comparison 比例（55:45）采样 250 个问题，保证类型的均衡分布。
- **实体提取**：使用正则表达式从所有支持性事实句子中抽取命名实体（专有名词、年份日期等），作为图的关键节点。
- **图结构构建**：将每个问题展开成一张异构图（heterogeneous graph），包含 4 种节点和 5 种边（详见下方数据模型），将原本扁平化的 JSON 数据转化为有向图，完整保留推理链结构。
- **多跳路径计算**：为每个问题按 hop number 排序其支持性事实，生成从第 1 跳到第 N 跳的有序推理链，同时标注每跳涉及的实体和文档。
- **共现关系**：检测同一问题下共享实体的实体对，建立 co-occurrence 边，为聚类模块提供实体共现信息。
- **导出 JSON**：将完整的图数据（节点 + 边 + 多跳路径元数据）序列化为 [hotpot_graph.json](docs/data/hotpot_graph.json)，供前端直接加载。

### 2. 前端可视化 — 从图到交互界面

Web 前端是一个无后端依赖的纯静态单页应用（SPA），核心模块分工如下：

| 模块 | 文件 | 职责 |
|------|------|------|
| 图引擎 | [graph.js](docs/js/graph.js) | 基于邻接表（Map 实现）的内存图数据结构，支持 BFS 邻域查询、子图提取、实体反向查找 |
| 搜索 | [search.js](docs/js/search.js) | 使用 Lunr.js 构建客户端全文索引，支持直接匹配（问题匹配）和间接匹配（事实/文档匹配后反向查找所属问题），带相关度评分 |
| 聚类 | [cluster.js](docs/js/cluster.js) | 基于共享实体的 Jaccard 相似度 + 凝聚式层次合并，先按类型（bridge/comparison）粗分，再在每个类型内迭代合并相似聚类，最终生成主题标签 |
| 可视化 | [visualize.js](docs/js/visualize.js) | 封装 vis-network 渲染引擎，提供：问题子图展开、多跳路径橙色高亮、聚类视图、邻域浏览、节点悬浮提示 |
| 应用主控 | [app.js](docs/js/app.js) | 串联所有模块：加载数据 → 初始化 → 事件绑定（搜索、点击、双击、标签切换），管理详情面板和 toast 通知 |

### 3. 探索流程

1. **概览模式**：启动时随机展示 30 个问题的局部邻域，用户获得全局感知。
2. **搜索驱动探索**：输入关键词（如 "film"、"award"、"sports"），搜索模块在问题文本、事实句子和文档标题中匹配，返回按相关度排序的问题列表。
3. **点击聚焦**：点击某个搜索结果，图视图切换到该问题的完整推理子图——问题节点居中，所有支持性事实、对应文档和实体以不同形状/颜色展开，推理路径以橙色边框高亮。
4. **深度展开**：双击问题节点进一步展开更完整的邻域，查看推理链的细粒度连接。
5. **聚类浏览**：切换到"聚类"标签页，查看按共享实体自动分组的问题集合，快速定位特定主题（如"体育人物"、"电影奖项"）的问题群。

## 功能特点

- **🔍 全文搜索** — 跨问题、支持性事实和文档进行搜索，并带有相关性评分
- **🔗 多跳可视化** — 交互式图谱展示推理链（问题 → 事实 → 实体 → 事实 → 答案）
- **📊 简单聚类** — 使用 Jaccard 相似度 + 凝聚式合并，按共享实体对问题进行分组
- **🖱️ 交互式图谱** — 点击、缩放、平移、展开节点；多跳路径以橙色边框高亮显示

## 技术栈

| 组件 | 技术 |
|------|------|
| 数据处理 | Python + HuggingFace `datasets` |
| 图引擎 | 自定义邻接表图（原生 JavaScript） |
| 搜索 | [Lunr.js](https://lunrjs.com/)（客户端全文搜索） |
| 可视化 | [vis-network](https://visjs.github.io/vis-network/docs/network/) |
| 聚类 | Jaccard 相似度 + 凝聚式合并 |
| 界面 | 原生 HTML/CSS/JS + [Tailwind CSS](https://tailwindcss.com/)（CDN） |
| 托管 | GitHub Pages（`/docs` 文件夹） |

## 项目结构

```
hotpot_qa/
├── scripts/
│   └── preprocess.py        # 下载 HotpotQA → 构建图谱 → 导出 JSON
├── docs/                     # GitHub Pages 根目录
│   ├── index.html           # 主单页应用
│   ├── css/
│   │   └── style.css        # 自定义样式
│   ├── js/
│   │   ├── app.js           # 应用初始化与事件绑定
│   │   ├── graph.js         # 图数据结构与查询
│   │   ├── search.js        # Lunr.js 搜索索引与查询
│   │   ├── cluster.js       # 基于实体的问题聚类
│   │   └── visualize.js     # vis-network 渲染与交互
│   └── data/
│       └── hotpot_graph.json # 预处理后的图谱数据（约250个问题）
└── README.md
```

## 快速开始

### 1. 预处理数据

```bash
pip install datasets
python scripts/preprocess.py
```

此命令会下载 HotpotQA "distractor" 子集，抽样 250 个问题，提取实体，并导出 `docs/data/hotpot_graph.json`。

### 2. 本地运行

```bash
cd docs
python -m http.server 8080
```

在浏览器中打开 http://localhost:8080。

### 3. 部署到 GitHub Pages

将仓库推送到 GitHub 并从 `/docs` 文件夹启用 Pages：

```
Settings → Pages → Source: Deploy from a branch → Branch: main, Folder: /docs
```

## 使用指南

1. **搜索** — 在搜索框中输入（例如 "film"、"sports"、"award"）来查找问题
2. **点击结果** — 图谱将显示该问题及其上下文文档、支持性事实和实体
3. **双击问题节点** — 展开完整的推理链视图
4. **多跳路径** — 支持性事实以橙色高亮边框连接，展示推理链
5. **聚类标签页** — 浏览按共享实体分组的基于主题的问题聚类
6. **图谱控制** — 缩放、平移、拖拽节点；使用 Fit/Reset 按钮

## 数据模型

图谱包含 4 种节点类型和 5 种边类型：

**节点：**
- **Question**（蓝色圆点） — 问题文本、答案和类型（bridge/comparison）
- **Document**（绿色方块） — 用作上下文的 Wikipedia 文章标题
- **Fact**（黄色矩形） — 支持性事实句子及其跳数编号
- **Entity**（红色菱形） — 提取的命名实体

**边：**
- `supported_by` — 问题 → 事实（含跳数编号，构成多跳链）
- `appears_in` — 问题 → 文档
- `belongs_to` — 事实 → 文档
- `mentions` — 事实 → 实体
- `co_occurs` — 实体 ↔ 实体（在同一问题内共享）
