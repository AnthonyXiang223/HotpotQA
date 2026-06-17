"""
将 HotpotQA 数据集导入 Neo4j 图数据库。
与 preprocess.py 共享前 90% 的逻辑（下载、采样、实体提取、图构建），
最终写入 Neo4j 而非 JSON 文件。

使用前请确保 Neo4j 已启动：
    docker run -d --name neo4j-hotpot -p 7474:7474 -p 7687:7687 \\
      -e NEO4J_AUTH=neo4j/password123 neo4j:5

用法：
    pip install neo4j datasets
    python scripts/import_to_neo4j.py
"""
import re
import os
import sys
from collections import defaultdict

try:
    from datasets import load_dataset
except ImportError:
    print("请安装 datasets：pip install datasets")
    sys.exit(1)

try:
    from neo4j import GraphDatabase
except ImportError:
    print("请安装 neo4j：pip install neo4j")
    sys.exit(1)

# ── Neo4j 连接配置 ────────────────────────────────────────────
# 本地 Neo4j 用默认值，AuraDB 云服务通过环境变量覆盖：
#   set NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
#   set NEO4J_USER=neo4j
#   set NEO4J_PASSWORD=your_password
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password123")
NEO4J_AUTH = (NEO4J_USER, NEO4J_PASSWORD)
DATABASE = os.environ.get("NEO4J_DATABASE", "neo4j")

# ── 数据配置 ──────────────────────────────────────────────────
SAMPLE_SIZE = 250
BRIDGE_RATIO = 0.55
RANDOM_SEED = 42

# ── 实体提取 ──────────────────────────────────────────────────
ENTITY_PATTERNS = [
    (r'\b(1[89]\d{2}|20[0-2]\d)\b', 'DATE'),
    (r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b', 'ENTITY'),
    (r'(?<!\.\s)(?<!\?\s)(?<!\!\s)\b([A-Z][a-z]{2,})\b', 'ENTITY'),
]

STOP_WORDS = {'the', 'and', 'for', 'was', 'are', 'has', 'had', 'his', 'her',
              'its', 'this', 'that', 'with', 'from', 'they', 'them', 'their',
              'have', 'been', 'were', 'also', 'not', 'can', 'may', 'who',
              'whom', 'which'}


def extract_entities(text, used_names=None):
    """从文本中提取候选实体，避免重复。"""
    if used_names is None:
        used_names = set()
    entities = []
    for pattern, etype in ENTITY_PATTERNS:
        for match in re.finditer(pattern, text):
            name = match.group(1).strip()
            if len(name) > 2 and name.lower() not in STOP_WORDS:
                if name not in used_names:
                    used_names.add(name)
                    entities.append({"name": name, "type": etype})
    return entities


def make_id(prefix, index):
    return f"{prefix}_{index}"


# ── 主流程 ────────────────────────────────────────────────────
def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)
    driver.verify_connectivity()
    print("已连接到 Neo4j")

    # ── 1. 下载并采样数据 ──────────────────────────────────
    print("正在加载 HotpotQA 数据集（distractor 子集）...")
    ds = load_dataset("hotpotqa/hotpot_qa", "distractor")
    train_ds = ds["train"]
    val_ds = ds["validation"]

    bridge_train = [s for s in train_ds if s["type"] == "bridge"]
    comparison_train = [s for s in train_ds if s["type"] == "comparison"]
    bridge_val = [s for s in val_ds if s["type"] == "bridge"]
    comparison_val = [s for s in val_ds if s["type"] == "comparison"]

    all_samples = bridge_train + comparison_train + bridge_val + comparison_val

    import random
    random.seed(RANDOM_SEED)
    random.shuffle(all_samples)

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

    print(f"已采样：{len(sampled)} 个问题（{bridge_count} bridge, {comp_count} comparison）")

    # ── 2. 构建图数据（同 preprocess.py 逻辑）──────────────
    nodes_to_create = []  # [{label, props}]
    edges_to_create = []  # [{source_id, target_id, type, props}]
    used_entity_names = set()
    doc_id_map = {}
    multi_hop_paths = {}

    # 节点计数器（每种类型单独编号，确保 ID 唯一）
    node_counters = {"question": 0, "document": 0, "fact": 0, "entity": 0}

    for qi, sample in enumerate(sampled):
        qid = make_id("q", qi)
        node_counters["question"] += 1
        question_text = sample["question"]
        answer = sample["answer"]
        qtype = sample["type"]
        difficulty = sample.get("level", "medium")

        nodes_to_create.append({
            "label": "Question",
            "props": {
                "id": qid,
                "label": question_text[:80] + ("..." if len(question_text) > 80 else ""),
                "full_text": question_text,
                "answer": answer,
                "qtype": qtype,
                "difficulty": difficulty,
            }
        })

        # 支持性事实
        supporting_facts = sample.get("supporting_facts", {})
        facts_by_doc = defaultdict(list)
        sf_titles = supporting_facts.get("title", [])
        sf_sent_ids = supporting_facts.get("sent_id", [])
        for title, sent_idx in zip(sf_titles, sf_sent_ids):
            facts_by_doc[title].append(sent_idx)

        context = sample.get("context", {})
        titles = context.get("title", [])
        sentences_list = context.get("sentences", [])

        hop_number = 0
        processed_titles = set()
        ordered_titles = list(facts_by_doc.keys())

        for title in ordered_titles:
            if title not in titles:
                continue
            processed_titles.add(title)
            doc_idx = titles.index(title)

            # 文档节点（去重）
            if title not in doc_id_map:
                doc_nid = make_id("d", len(doc_id_map))
                node_counters["document"] += 1
                doc_id_map[title] = doc_nid
                first_sent = sentences_list[doc_idx][0] if doc_idx < len(sentences_list) and sentences_list[doc_idx] else ""
                nodes_to_create.append({
                    "label": "Document",
                    "props": {
                        "id": doc_nid,
                        "label": title,
                        "title": title,
                        "first_sentence": first_sent[:150],
                    }
                })

            doc_nid = doc_id_map[title]

            # 边：Question → Document
            edges_to_create.append({
                "source_id": qid, "target_id": doc_nid,
                "type": "APPEARS_IN", "props": {}
            })

            # 事实节点
            hop_number += 1
            for sent_idx in sorted(facts_by_doc[title]):
                if doc_idx < len(sentences_list) and sent_idx < len(sentences_list[doc_idx]):
                    sent_text = sentences_list[doc_idx][sent_idx].strip()
                    fid = make_id("f", node_counters["fact"])
                    node_counters["fact"] += 1

                    nodes_to_create.append({
                        "label": "Fact",
                        "props": {
                            "id": fid,
                            "label": sent_text[:120] + ("..." if len(sent_text) > 120 else ""),
                            "full_text": sent_text,
                            "hop": hop_number,
                            "document_title": title,
                        }
                    })

                    # 边：Fact → Document
                    edges_to_create.append({
                        "source_id": fid, "target_id": doc_nid,
                        "type": "BELONGS_TO", "props": {}
                    })

                    # 边：Question → Fact
                    edges_to_create.append({
                        "source_id": qid, "target_id": fid,
                        "type": "SUPPORTED_BY", "props": {"hop": hop_number}
                    })

                    # 实体提取
                    entities = extract_entities(sent_text, used_entity_names)
                    for ent in entities:
                        eid = make_id("e", node_counters["entity"])
                        node_counters["entity"] += 1
                        nodes_to_create.append({
                            "label": "Entity",
                            "props": {
                                "id": eid,
                                "label": ent["name"],
                                "entity_type": ent["type"],
                            }
                        })
                        edges_to_create.append({
                            "source_id": fid, "target_id": eid,
                            "type": "MENTIONS", "props": {}
                        })

        # 剩余上下文文档
        for doc_idx, title in enumerate(titles):
            if title in processed_titles:
                continue
            if title not in doc_id_map:
                doc_nid = make_id("d", len(doc_id_map))
                node_counters["document"] += 1
                doc_id_map[title] = doc_nid
                first_sent = sentences_list[doc_idx][0] if doc_idx < len(sentences_list) and sentences_list[doc_idx] else ""
                nodes_to_create.append({
                    "label": "Document",
                    "props": {
                        "id": doc_nid,
                        "label": title,
                        "title": title,
                        "first_sentence": first_sent[:150],
                    }
                })
            else:
                doc_nid = doc_id_map[title]

            edges_to_create.append({
                "source_id": qid, "target_id": doc_nid,
                "type": "APPEARS_IN", "props": {}
            })

    # ── 实体共现 ────────────────────────────────────────────
    # 同一问题中出现的实体之间建立 CO_OCCURS 关系
    entity_to_questions = defaultdict(set)
    for edge in edges_to_create:
        if edge["type"] == "MENTIONS":
            # 找到该 fact 所属的 question
            for e2 in edges_to_create:
                if e2["type"] == "SUPPORTED_BY" and e2["target_id"] == edge["source_id"]:
                    entity_to_questions[edge["target_id"]].add(e2["source_id"])

    co_occur_added = set()
    for qi in range(len(sampled)):
        qid = make_id("q", qi)
        q_entities = [eid for eid, qs in entity_to_questions.items() if qid in qs]
        for i in range(len(q_entities)):
            for j in range(i + 1, len(q_entities)):
                pair = (q_entities[i], q_entities[j])
                if pair not in co_occur_added:
                    co_occur_added.add(pair)
                    co_occur_added.add((q_entities[j], q_entities[i]))
                    edges_to_create.append({
                        "source_id": q_entities[i], "target_id": q_entities[j],
                        "type": "CO_OCCURS", "props": {}
                    })

    # ── 计算多跳路径 ────────────────────────────────────────
    fact_nodes = {n["props"]["id"]: n for n in nodes_to_create if n["label"] == "Fact"}

    for qi in range(len(sampled)):
        qid = make_id("q", qi)
        q_facts = []
        for edge in edges_to_create:
            if edge["type"] == "SUPPORTED_BY" and edge["source_id"] == qid:
                hop = edge["props"].get("hop", 0)
                q_facts.append((hop, edge["target_id"]))
        q_facts.sort()
        path = []
        for hop, fid in q_facts:
            fact_node = fact_nodes.get(fid)
            if not fact_node:
                continue
            # 找到该事实中的实体
            fact_entities = []
            for edge in edges_to_create:
                if edge["type"] == "MENTIONS" and edge["source_id"] == fid:
                    ent_node = next((n for n in nodes_to_create if n["props"]["id"] == edge["target_id"]), None)
                    if ent_node:
                        fact_entities.append(ent_node["props"]["label"])
            # 找到该事实对应的文档
            doc_title = None
            for edge in edges_to_create:
                if edge["type"] == "BELONGS_TO" and edge["source_id"] == fid:
                    doc_node = next((n for n in nodes_to_create if n["props"]["id"] == edge["target_id"]), None)
                    if doc_node:
                        doc_title = doc_node["props"]["title"]

            path.append({
                "hop": hop,
                "fact_id": fid,
                "text": fact_node["props"]["full_text"],
                "entities": fact_entities,
                "document": doc_title,
            })
        multi_hop_paths[qid] = path

    # ── 3. 写入 Neo4j ───────────────────────────────────────
    print(f"\n正在写入 Neo4j：{len(nodes_to_create)} 个节点，{len(edges_to_create)} 条边...")

    with driver.session(database=DATABASE) as session:
        # 先清空旧数据
        session.run("MATCH (n) DETACH DELETE n")
        print("  已清空旧数据")

        # 批量创建节点（每批 200 个）
        batch_size = 200
        for i in range(0, len(nodes_to_create), batch_size):
            batch = nodes_to_create[i:i + batch_size]
            # 按 Label 分组执行 UNWIND 创建
            by_label = defaultdict(list)
            for n in batch:
                by_label[n["label"]].append(n["props"])

            for label, props_list in by_label.items():
                session.execute_write(
                    lambda tx, label=label, props_list=props_list: (
                        tx.run(
                            f"UNWIND $props_list AS props "
                            f"CREATE (n:{label}) SET n = props",
                            props_list=props_list
                        ).consume()
                    )
                )

            print(f"  已创建节点：{min(i + batch_size, len(nodes_to_create))}/{len(nodes_to_create)}")

        # 批量创建关系（按类型分组，纯 Cypher 无需 APOC 插件）
        edges_by_type = defaultdict(list)
        for e in edges_to_create:
            edges_by_type[e["type"]].append({
                "source_id": e["source_id"],
                "target_id": e["target_id"],
                "props": e["props"],
            })

        total_created = 0
        for rel_type, rel_edges in edges_by_type.items():
            for i in range(0, len(rel_edges), batch_size):
                batch = rel_edges[i:i + batch_size]
                # 动态 Cypher：关系类型在查询字符串拼接时已确定（按类型分组后是安全的字面量）
                session.execute_write(
                    lambda tx, rt=rel_type, b=batch: (
                        tx.run(
                            f"UNWIND $batch AS edge "
                            f"MATCH (a {{id: edge.source_id}}) "
                            f"MATCH (b {{id: edge.target_id}}) "
                            f"CREATE (a)-[r:{rt}]->(b) SET r = edge.props",
                            batch=b
                        ).consume()
                    )
                )
            total_created += len(rel_edges)
            print(f"  已创建 {rel_type} 关系：{len(rel_edges)} 条 ({total_created}/{len(edges_to_create)})")

        # ── 4. 创建约束和索引 ───────────────────────────────
        print("\n正在创建约束和索引...")
        for label in ["Question", "Document", "Fact", "Entity"]:
            try:
                session.run(
                    f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE"
                )
                print(f"  约束：{label}.id UNIQUE")
            except Exception as e:
                print(f"  约束 {label} 已存在或创建失败：{e}")

        # 全文索引（替代 Lunr.js）
        try:
            session.run("""
                CREATE FULLTEXT INDEX searchIndex IF NOT EXISTS
                FOR (n:Question|Fact|Document)
                ON EACH [n.full_text, n.label, n.answer, n.title, n.first_sentence]
            """)
            print("  全文索引：searchIndex 已创建")
        except Exception as e:
            print(f"  全文索引创建失败：{e}")

        # 存储多跳路径（JSON 序列化后存入 Neo4j）
        print("\n正在写入多跳路径元数据...")
        import json as _json
        for qid, path in multi_hop_paths.items():
            session.run(
                "MATCH (q:Question {id: $qid}) SET q.multi_hop_path = $path",
                qid=qid, path=_json.dumps(path, ensure_ascii=False)
            )
        print(f"  已写入 {len(multi_hop_paths)} 条多跳路径")

    # ── 5. 统计 ─────────────────────────────────────────────
    with driver.session(database=DATABASE) as session:
        result = session.run("MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt")
        print("\n节点统计：")
        for record in result:
            print(f"  {record['label']}: {record['cnt']}")

        result = session.run("MATCH ()-[r]->() RETURN type(r) AS rel_type, count(r) AS cnt")
        print("关系统计：")
        for record in result:
            print(f"  {record['rel_type']}: {record['cnt']}")

    driver.close()
    print("\n[完成] 数据已成功导入 Neo4j！")


if __name__ == "__main__":
    main()
