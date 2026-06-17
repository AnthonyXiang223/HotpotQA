"""
将 HotpotQA 数据集预处理为图结构，供 Web 可视化使用。
下载 distractor 子集，抽样问题，提取实体，
并导出 JSON 图文件供 Web 应用使用。
"""
import json
import re
import os
import sys
from collections import defaultdict

try:
    from datasets import load_dataset
except ImportError:
    print("请安装 datasets：pip install datasets")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────
SAMPLE_SIZE = 250           # 抽样问题总数
BRIDGE_RATIO = 0.55         # 约 55% bridge 类型，45% comparison 类型
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "hotpot_graph.json")
RANDOM_SEED = 42

# ── 简单实体提取 ───────────────────────────────────────────────
# 提取候选实体：首字母大写的名词短语、命名实体模式
ENTITY_PATTERNS = [
    # 年份和日期
    (r'\b(1[89]\d{2}|20[0-2]\d)\b', 'DATE'),
    # 专有名词序列（2个及以上首字母大写的单词）
    (r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b', 'ENTITY'),
    # 单个专有名词（非句首的大写单词）
    (r'(?<!\.\s)(?<!\?\s)(?<!\!\s)\b([A-Z][a-z]{2,})\b', 'ENTITY'),
]

def extract_entities(text, used_names=None):
    """从文本中提取候选实体，避免重复。"""
    if used_names is None:
        used_names = set()
    entities = []
    for pattern, etype in ENTITY_PATTERNS:
        for match in re.finditer(pattern, text):
            name = match.group(1).strip()
            if len(name) > 2 and name.lower() not in {'the', 'and', 'for', 'was', 'are', 'has', 'had', 'his', 'her', 'its', 'this', 'that', 'with', 'from', 'they', 'them', 'their', 'have', 'been', 'were', 'also', 'not', 'can', 'may', 'who', 'whom', 'which'}:
                if name not in used_names:
                    used_names.add(name)
                    entities.append({"name": name, "type": etype})
    return entities


# ── 加载数据集 ─────────────────────────────────────────────────
print("正在加载 HotpotQA 数据集（distractor 子集）...")
ds = load_dataset("hotpotqa/hotpot_qa", "distractor")
train_ds = ds["train"]
val_ds = ds["validation"]
print(f"  训练集：{len(train_ds)} 条样本")
print(f"  验证集：{len(val_ds)} 条样本")

# ── 抽样问题 ───────────────────────────────────────────────────
# 按类型分开
bridge_train = [s for s in train_ds if s["type"] == "bridge"]
comparison_train = [s for s in train_ds if s["type"] == "comparison"]
bridge_val = [s for s in val_ds if s["type"] == "bridge"]
comparison_val = [s for s in val_ds if s["type"] == "comparison"]

print(f"  Bridge：{len(bridge_train)} 训练, {len(bridge_val)} 验证")
print(f"  Comparison：{len(comparison_train)} 训练, {len(comparison_val)} 验证")

# 合并并抽样
all_samples = bridge_train + comparison_train + bridge_val + comparison_val

import random
random.seed(RANDOM_SEED)
random.shuffle(all_samples)

# 取平衡子集
n_bridge = int(SAMPLE_SIZE * BRIDGE_RATIO)
n_comparison = SAMPLE_SIZE - n_bridge

sampled = []
bridge_count = 0
comp_count = 0
for s in all_samples:
    if s["type"] == "bridge" and bridge_count < n_bridge:
        sampled.append(s)
        bridge_count += 1
    elif s["type"] == "comparison" and comp_count < n_comparison:
        sampled.append(s)
        comp_count += 1
    if bridge_count >= n_bridge and comp_count >= n_comparison:
        break

print(f"\n已抽样：{len(sampled)} 个问题（{bridge_count} bridge, {comp_count} comparison）")

# ── 构建图 ────────────────────────────────────────────────────
nodes = []
edges = []
node_ids = set()
used_entity_names = set()
doc_id_map = {}  # title → doc_node_id

def make_id(prefix, index):
    return f"{prefix}_{index}"

for qi, sample in enumerate(sampled):
    qid = make_id("q", qi)
    question_text = sample["question"]
    answer = sample["answer"]
    qtype = sample["type"]
    difficulty = sample.get("level", "medium")

    # 问题节点
    nodes.append({
        "id": qid,
        "type": "question",
        "label": question_text[:80] + ("..." if len(question_text) > 80 else ""),
        "full_text": question_text,
        "answer": answer,
        "qtype": qtype,
        "difficulty": difficulty,
    })
    node_ids.add(qid)

    # 支持性事实：包含 'title' 和 'sent_id' 列表的字典
    supporting_facts = sample.get("supporting_facts", {})
    # 按文档标题分组，按句子索引排序
    facts_by_doc = defaultdict(list)
    sf_titles = supporting_facts.get("title", [])
    sf_sent_ids = supporting_facts.get("sent_id", [])
    for title, sent_idx in zip(sf_titles, sf_sent_ids):
        facts_by_doc[title].append(sent_idx)

    # 上下文文档
    context = sample.get("context", {})
    titles = context.get("title", [])
    sentences_list = context.get("sentences", [])

    # 构建文档和事实节点
    hop_number = 0
    # 先处理支持性事实文档（按顺序），再处理其他
    processed_titles = set()
    ordered_titles = list(facts_by_doc.keys())

    for title in ordered_titles:
        if title not in titles:
            continue
        processed_titles.add(title)
        doc_idx = titles.index(title) if title in titles else -1
        if doc_idx < 0:
            continue

        # 文档节点
        if title not in doc_id_map:
            doc_nid = make_id("d", len(doc_id_map))
            doc_id_map[title] = doc_nid
            first_sent = sentences_list[doc_idx][0] if doc_idx < len(sentences_list) and sentences_list[doc_idx] else ""
            nodes.append({
                "id": doc_nid,
                "type": "document",
                "label": title,
                "title": title,
                "first_sentence": first_sent[:150],
            })
            node_ids.add(doc_nid)

        doc_nid = doc_id_map[title]

        # 边：问题 → 文档
        edges.append({
            "source": qid,
            "target": doc_nid,
            "type": "appears_in",
        })

        # 事实节点（仅支持性事实）
        hop_number += 1
        for sent_idx in sorted(facts_by_doc[title]):
            if doc_idx < len(sentences_list) and sent_idx < len(sentences_list[doc_idx]):
                sent_text = sentences_list[doc_idx][sent_idx].strip()
                fid = make_id("f", len([n for n in nodes if n["type"] == "fact"]))
                nodes.append({
                    "id": fid,
                    "type": "fact",
                    "label": sent_text[:120] + ("..." if len(sent_text) > 120 else ""),
                    "full_text": sent_text,
                    "hop": hop_number,
                    "document_title": title,
                })
                node_ids.add(fid)

                # 边：事实 → 文档
                edges.append({
                    "source": fid,
                    "target": doc_nid,
                    "type": "belongs_to",
                })

                # 边：问题 → 事实
                edges.append({
                    "source": qid,
                    "target": fid,
                    "type": "supported_by",
                    "hop": hop_number,
                })

                # 从事实中提取实体
                entities = extract_entities(sent_text, used_entity_names)
                for ent in entities:
                    eid = make_id("e", len([n for n in nodes if n["type"] == "entity"]))
                    nodes.append({
                        "id": eid,
                        "type": "entity",
                        "label": ent["name"],
                        "entity_type": ent["type"],
                    })
                    node_ids.add(eid)

                    # 边：事实 → 实体，实体 → 事实（用于连通性）
                    edges.append({
                        "source": fid,
                        "target": eid,
                        "type": "mentions",
                    })

    # 添加剩余的上下文文档（非支持性）
    for doc_idx, title in enumerate(titles):
        if title in processed_titles:
            continue
        if title not in doc_id_map:
            doc_nid = make_id("d", len(doc_id_map))
            doc_id_map[title] = doc_nid
            first_sent = sentences_list[doc_idx][0] if doc_idx < len(sentences_list) and sentences_list[doc_idx] else ""
            nodes.append({
                "id": doc_nid,
                "type": "document",
                "label": title,
                "title": title,
                "first_sentence": first_sent[:150],
            })
            node_ids.add(doc_nid)
        else:
            doc_nid = doc_id_map[title]

        edges.append({
            "source": qid,
            "target": doc_nid,
            "type": "appears_in",
        })

# ── 跨事实链接实体（共现）──────────────────────────────────────
# 出现在同一问题的事实中的实体之间建立 co_occurs 边
entity_to_questions = defaultdict(set)
entity_to_facts = defaultdict(set)
for edge in edges:
    if edge["type"] == "mentions":
        entity_to_facts[edge["target"]].add(edge["source"])
for node in nodes:
    if node["type"] == "fact":
        fid = node["id"]
        # 找到该事实所属的问题
        for edge in edges:
            if edge["type"] == "supported_by" and edge["target"] == fid:
                question_id = edge["source"]
                # 找到该事实中提及的实体
                for e_edge in edges:
                    if e_edge["type"] == "mentions" and e_edge["source"] == fid:
                        entity_to_questions[e_edge["target"]].add(question_id)

# 添加共现边：出现在同一问题中的实体之间
for qid in [n["id"] for n in nodes if n["type"] == "question"]:
    q_entities = [eid for eid, qs in entity_to_questions.items() if qid in qs]
    for i in range(len(q_entities)):
        for j in range(i + 1, len(q_entities)):
            edges.append({
                "source": q_entities[i],
                "target": q_entities[j],
                "type": "co_occurs",
            })

# 去除重复边（相同的 source, target, type）
seen_edges = set()
unique_edges = []
for edge in edges:
    key = (edge["source"], edge["target"], edge["type"])
    if key not in seen_edges:
        seen_edges.add(key)
        # 对于无向边类型，同时检查反向
        if edge["type"] in ("co_occurs",):
            seen_edges.add((edge["target"], edge["source"], edge["type"]))
        unique_edges.append(edge)

# ── 计算多跳路径 ──────────────────────────────────────────────
# 为每个问题记录跳转序列
multi_hop_paths = {}
for node in nodes:
    if node["type"] != "question":
        continue
    qid = node["id"]
    # 获取按跳数排序的支持性事实
    q_facts = []
    for edge in unique_edges:
        if edge["type"] == "supported_by" and edge["source"] == qid:
            q_facts.append((edge.get("hop", 0), edge["target"]))
    q_facts.sort()
    path = []
    for hop, fid in q_facts:
        # 找到该事实中的实体
        fact_entities = []
        for edge in unique_edges:
            if edge["type"] == "mentions" and edge["source"] == fid:
                ent_node = next((n for n in nodes if n["id"] == edge["target"]), None)
                if ent_node:
                    fact_entities.append(ent_node["label"])
        # 找到该事实对应的文档
        doc_title = None
        for edge in unique_edges:
            if edge["type"] == "belongs_to" and edge["source"] == fid:
                doc_node = next((n for n in nodes if n["id"] == edge["target"]), None)
                if doc_node:
                    doc_title = doc_node["title"]
        fact_node = next((n for n in nodes if n["id"] == fid), None)
        if fact_node:
            path.append({
                "hop": hop,
                "fact_id": fid,
                "text": fact_node["full_text"],
                "entities": fact_entities,
                "document": doc_title,
            })
    multi_hop_paths[qid] = path

# ── 输出 ───────────────────────────────────────────────────────
output = {
    "meta": {
        "total_questions": len(sampled),
        "bridge_count": bridge_count,
        "comparison_count": comp_count,
        "total_nodes": len(nodes),
        "total_edges": len(unique_edges),
    },
    "nodes": nodes,
    "edges": unique_edges,
    "multi_hop_paths": multi_hop_paths,
}

os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

file_size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
print(f"\n[完成] 已导出至：{OUTPUT_PATH}")
print(f"  文件大小：{file_size_mb:.2f} MB")
print(f"  节点数：{len(nodes)}")
print(f"  边数：{len(unique_edges)}")
print(f"  多跳路径数：{len(multi_hop_paths)}")

# 统计信息
node_types = defaultdict(int)
for n in nodes:
    node_types[n["type"]] += 1
for t, c in sorted(node_types.items()):
    print(f"    {t}: {c}")

edge_types = defaultdict(int)
for e in unique_edges:
    edge_types[e["type"]] += 1
for t, c in sorted(edge_types.items()):
    print(f"    {t} 边: {c}")
