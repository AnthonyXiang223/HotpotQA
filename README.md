# HotpotQA 多跳推理探索平台

[HotpotQA](https://hotpotqa.github.io/) 多跳问答数据集的可视化探索工具。
本项目通过 import_to_neo4j.py 将 HotpotQA 数据集导入 Neo4j（4 种节点 Label + 5 种关系），server.py 用 Cypher 封装为 REST API 提供搜索、子图、聚类等查询，前端在设置 apiBase 后自动切换到 Neo4j 模式进行全文索引和服务端聚类
## 访问

在线访问：`https://anthonyxiang223.github.io/HotpotQA/`

## 关于数据集

HotpotQA 是一个多跳问答基准，由 CMU、Stanford 和 Google Research 联合发布。每个问题**需要从多篇 Wikipedia 文章中提取线索并串联推理**才能回答，模拟了人类查阅多个来源、逐步推导的认知过程。

- **Bridge（桥接）**：线性推理链，从 A→B→C 逐步推导，占 55%
- **Comparison（比较）**：同时检索两个实体并对比，占 45%

本项目采样了 1,000 个问题，从中提取实体、构建图结构，以可视化方式展示推理链。

## 页面使用

页面采用三栏布局：左侧搜索/聚类、中间图谱、右侧详情。

- **搜索**：顶栏输入英文关键词（如 `film`、`award`、`sports`），结果出现在左侧，点击一条即可切换到该问题的推理子图
- **浏览图谱**：滚轮缩放、拖拽平移；点击任意节点右侧显示详情；双击蓝色问题节点展开完整推理链；多跳路径以橙色边框高亮
- **聚类**：点左侧"聚类"标签，查看按类型和难度分组的 6 个问题集合，点击可批量查看
- **图例**：左下角标示了蓝=问题、绿=文档、黄=事实、红=实体
- **按钮**：右上角 Fit 适配视图、Reset 重置回概览

## 数据模型

将问答对转化为异构图，包含 4 种节点和 5 种边：

| 节点 | 说明 |
|------|------|
| **Question**（蓝） | 问题文本、答案、类型 |
| **Document**（绿） | Wikipedia 文章标题 |
| **Fact**（黄） | 支持性事实句子，标注跳数 |
| **Entity**（红） | 命名实体（人名、年份等） |

其中，命名实体是从事实句子里用正则提取的，规则：2 个及以上连续大写开头的词、非句首的大写单词、四位年份数字。

| 边 | 方向 | 含义 |
|----|------|------|
| `supported_by` | 问题 → 事实 | 支持关系，构成多跳链 |
| `appears_in` | 问题 → 文档 | 引用关系 |
| `belongs_to` | 事实 → 文档 | 来源归属 |
| `mentions` | 事实 → 实体 | 实体提及 |
| `co_occurs` | 实体 ↔ 实体 | 同一问题内共现 |

## 项目结构

```
hotpot_qa/
├── scripts/preprocess.py      # 下载 → 构图 → 导出 JSON
├── docs/                      # GitHub Pages 根目录
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── app.js             # 主控
│   │   ├── graph.js           # 图引擎
│   │   ├── search.js          # 搜索
│   │   ├── cluster.js         # 聚类
│   │   └── visualize.js       # 可视化
│   └── data/hotpot_graph.json # 预处理数据
├── api/server.py              # FastAPI
└── scripts/import_to_neo4j.py # Neo4j 导入
```
