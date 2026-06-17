"""
FastAPI 后端 —— Neo4j 与前端之间的桥梁。
将所有 HotpotQA 图查询封装为 REST API，返回与原有 JSON 格式兼容的数据。
"""
import json as _json
from collections import defaultdict
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase

app = FastAPI(title="HotpotQA Neo4j API", version="1.0")

# 允许前端跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Neo4j 连接 ────────────────────────────────────────────────
# 本地用默认值，AuraDB 云服务通过环境变量覆盖
import os as _os
NEO4J_URI = _os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_AUTH = (
    _os.environ.get("NEO4J_USER", "neo4j"),
    _os.environ.get("NEO4J_PASSWORD", "password123"),
)
DATABASE = _os.environ.get("NEO4J_DATABASE", "neo4j")

driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)


def get_session():
    return driver.session(database=DATABASE)


# ── 辅助函数 ──────────────────────────────────────────────────

def _node_to_dict(neo_node):
    """将 Neo4j Node 转换为与前端兼容的字典格式。"""
    d = dict(neo_node)
    # Neo4j 的节点类型存储在 Label 中，前端期望 type 属性
    if "type" not in d and hasattr(neo_node, 'labels'):
        labels = list(neo_node.labels)
        if labels:
            d["type"] = labels[0].lower()
    # 反序列化 JSON 格式的多跳路径
    if "multi_hop_path" in d and isinstance(d["multi_hop_path"], str):
        try:
            d["multi_hop_path"] = _json.loads(d["multi_hop_path"])
        except (_json.JSONDecodeError, TypeError):
            pass
    return d


def _record_to_dict(record, key="n"):
    """将查询结果记录转换为字典。"""
    node = record.get(key)
    if node is not None:
        return _node_to_dict(node)
    return dict(record)


def _subgraph_query(cypher, params):
    """执行子图查询，返回 {nodes, edges} 格式，与旧 JSON 兼容。"""
    with get_session() as session:
        result = session.run(cypher, params)
        records = list(result)

    nodes_map = {}
    edges_list = []
    seen_edges = set()

    for record in records:
        for key, value in record.items():
            if value is None:
                continue
            # Neo4j Node
            if hasattr(value, 'labels'):
                nid = value.get("id")
                if nid and nid not in nodes_map:
                    nodes_map[nid] = _node_to_dict(value)
            # Neo4j Relationship
            elif hasattr(value, 'type'):
                eid = f"{value.start_node.get('id')}_{value.end_node.get('id')}_{value.type}"
                if eid not in seen_edges:
                    seen_edges.add(eid)
                    edges_list.append({
                        "source": value.start_node.get("id"),
                        "target": value.end_node.get("id"),
                        "type": value.type.lower(),
                        "hop": value.get("hop"),
                    })
            # Path object
            elif hasattr(value, 'nodes') and hasattr(value, 'relationships'):
                for node in value.nodes:
                    nid = node.get("id")
                    if nid and nid not in nodes_map:
                        nodes_map[nid] = _node_to_dict(node)
                for rel in value.relationships:
                    eid = f"{rel.start_node.get('id')}_{rel.end_node.get('id')}_{rel.type}"
                    if eid not in seen_edges:
                        seen_edges.add(eid)
                        edges_list.append({
                            "source": rel.start_node.get("id"),
                            "target": rel.end_node.get("id"),
                            "type": rel.type.lower(),
                            "hop": rel.get("hop"),
                        })

    return {
        "nodes": list(nodes_map.values()),
        "edges": edges_list,
    }


# ── API 端点 ──────────────────────────────────────────────────

@app.get("/api/graph/full")
def get_full_graph():
    """返回完整的图数据（节点 + 边 + 多跳路径），与旧 hotpot_graph.json 格式兼容。"""
    with get_session() as session:
        # 获取所有节点
        nodes_result = session.run("MATCH (n) RETURN n")
        nodes = [_node_to_dict(r["n"]) for r in nodes_result]

        # 获取所有关系
        edges_result = session.run("""
            MATCH ()-[r]->()
            RETURN DISTINCT startNode(r).id AS source,
                   endNode(r).id AS target,
                   type(r) AS type,
                   r.hop AS hop
        """)
        edges = []
        seen = set()
        for r in edges_result:
            key = (r["source"], r["target"], r["type"])
            if key not in seen:
                seen.add(key)
                edges.append({
                    "source": r["source"],
                    "target": r["target"],
                    "type": r["type"].lower(),
                    "hop": r["hop"],
                })

        # 获取多跳路径（JSON 字符串需反序列化）
        paths_result = session.run("""
            MATCH (q:Question)
            WHERE q.multi_hop_path IS NOT NULL
            RETURN q.id AS qid, q.multi_hop_path AS path
        """)
        multi_hop_paths = {}
        for r in paths_result:
            path_str = r["path"]
            if isinstance(path_str, str):
                try:
                    multi_hop_paths[r["qid"]] = _json.loads(path_str)
                except (_json.JSONDecodeError, TypeError):
                    multi_hop_paths[r["qid"]] = []
            else:
                multi_hop_paths[r["qid"]] = path_str or []

        # 统计
        question_nodes = [n for n in nodes if n.get("qtype")]
        bridge_count = sum(1 for n in question_nodes if n.get("qtype") == "bridge")
        comp_count = sum(1 for n in question_nodes if n.get("qtype") == "comparison")

    return {
        "meta": {
            "total_questions": len(question_nodes),
            "bridge_count": bridge_count,
            "comparison_count": comp_count,
            "total_nodes": len(nodes),
            "total_edges": len(edges),
        },
        "nodes": nodes,
        "edges": edges,
        "multi_hop_paths": multi_hop_paths,
    }


@app.get("/api/graph/stats")
def get_stats():
    """获取图统计信息：各类型节点和边的数量。"""
    with get_session() as session:
        result = session.run("""
            MATCH (n)
            RETURN labels(n)[0] AS label, count(n) AS cnt
            ORDER BY label
        """)
        stats = {}
        for record in result:
            stats[f"{record['label'].lower()}Count"] = record['cnt']

        result = session.run("""
            MATCH ()-[r]->()
            RETURN type(r) AS rel_type, count(r) AS cnt
            ORDER BY rel_type
        """)
        for record in result:
            stats[f"{record['rel_type'].lower()}EdgeCount"] = record['cnt']

        # 总数（排除边计数，只算节点）
        total_nodes = sum(v for k, v in stats.items() if k.endswith("Count") and not k.endswith("EdgeCount"))
        total_edges = sum(v for k, v in stats.items() if k.endswith("EdgeCount"))
        stats["totalNodes"] = total_nodes
        stats["totalEdges"] = total_edges

    return stats


@app.get("/api/questions")
def get_questions(limit: int = Query(250, ge=1, le=1000)):
    """获取问题列表。"""
    with get_session() as session:
        result = session.run(
            "MATCH (n:Question) RETURN n ORDER BY n.id LIMIT $limit",
            limit=limit
        )
        questions = [_record_to_dict(r) for r in result]
    return questions


@app.get("/api/questions/{question_id}")
def get_question(question_id: str):
    """获取单个问题详情（含多跳路径）。"""
    with get_session() as session:
        result = session.run(
            "MATCH (n:Question {id: $id}) RETURN n",
            id=question_id
        )
        record = result.single()
        if not record:
            raise HTTPException(status_code=404, detail="问题未找到")
        node = _node_to_dict(record["n"])
        path = node.pop("multi_hop_path", [])
    return {"node": node, "path": path}


@app.get("/api/questions/{question_id}/subgraph")
def get_question_subgraph(question_id: str):
    """获取问题的完整推理子图（问题 + 事实 + 文档 + 实体 + 边）。"""
    cypher = """
        MATCH (q:Question {id: $qid})
        OPTIONAL MATCH (q)-[r1:SUPPORTED_BY]->(f:Fact)
        OPTIONAL MATCH (q)-[r2:APPEARS_IN]->(d:Document)
        OPTIONAL MATCH (f)-[r3:BELONGS_TO]->(fd:Document)
        OPTIONAL MATCH (f)-[r4:MENTIONS]->(e:Entity)
        RETURN q, f, d, fd, e, r1, r2, r3, r4
    """
    return _subgraph_query(cypher, {"qid": question_id})


@app.get("/api/nodes/{node_id}")
def get_node(node_id: str):
    """获取单个节点详情。"""
    with get_session() as session:
        result = session.run(
            "MATCH (n {id: $id}) RETURN n",
            id=node_id
        )
        record = result.single()
        if not record:
            raise HTTPException(status_code=404, detail="节点未找到")
    return _node_to_dict(record["n"])


@app.get("/api/nodes/{node_id}/neighborhood")
def get_neighborhood(node_id: str, depth: int = Query(2, ge=1, le=4)):
    """获取节点周围指定深度的邻域子图（BFS 等价）。"""
    cypher = """
        MATCH path = (n {id: $nid})-[*1..""" + str(depth) + """]-()
        RETURN path
        LIMIT 200
    """
    return _subgraph_query(cypher, {"nid": node_id})


@app.get("/api/search")
def search(q: str = Query(..., min_length=2), limit: int = Query(15, ge=1, le=50)):
    """全文搜索——替代 Lunr.js。尝试全文索引，失败时回退 CONTAINS。"""
    matches = []

    with get_session() as session:
        # 尝试全文索引（Neo4j 5 / AuraDB）
        try:
            result = session.run(
                """CALL db.index.fulltext.queryNodes('searchIndex', $query)
                   YIELD node, score
                   RETURN node, score
                   ORDER BY score DESC
                   LIMIT $limit""",
                query=q, limit=limit * 3
            )
            for record in result:
                matches.append((
                    _node_to_dict(record["node"]),
                    record["score"],
                ))
        except Exception:
            pass

        # 全文索引失败或返回空 → 用 CONTAINS
        if not matches:
            try:
                result = session.run(
                    """MATCH (n)
                       WHERE (n:Question OR n:Fact OR n:Document)
                         AND (n.full_text CONTAINS $q OR n.label CONTAINS $q
                              OR n.answer CONTAINS $q OR n.title CONTAINS $q)
                       RETURN n AS node, 0.5 AS score
                       LIMIT $limit""",
                    q=q, limit=limit * 3
                )
                for record in result:
                    matches.append((
                        _node_to_dict(record["node"]),
                        record["score"],
                    ))
            except Exception:
                pass

    # 按问题聚合
    results = []
    seen_questions = set()

    for node, score in matches:
        if node.get("type") == "question" or node.get("qtype"):
            if node["id"] not in seen_questions:
                seen_questions.add(node["id"])
                results.append({
                    "ref": node["id"], "score": round(score, 4),
                    "type": "question", "node": node, "matchedVia": None,
                })
        elif node.get("type") in ("fact", "document"):
            related = _find_related_questions(node["id"])
            for rq in related:
                if rq["id"] not in seen_questions:
                    seen_questions.add(rq["id"])
                    results.append({
                        "ref": rq["id"], "score": round(score * 0.5, 4),
                        "type": "question", "node": rq,
                        "matchedVia": (node.get("label") or "")[:80],
                    })

    return sorted(results, key=lambda x: x["score"], reverse=True)[:limit]


def _find_related_questions(node_id):
    """找到与给定事实/文档节点关联的问题。"""
    with get_session() as session:
        result = session.run("""
            MATCH (n {id: $nid})
            OPTIONAL MATCH (n)-[:BELONGS_TO]-(:Document)-[:APPEARS_IN]-(q:Question)
            OPTIONAL MATCH (n)<-[:SUPPORTED_BY]-(q2:Question)
            RETURN DISTINCT coalesce(q, q2) AS question
            LIMIT 20
        """, nid=node_id)
        return [_node_to_dict(r["question"]) for r in result if r["question"]]


@app.get("/api/clusters")
def get_clusters(
    min_cluster_size: int = Query(3, ge=2, le=20, alias="minClusterSize"),
    max_clusters: int = Query(15, ge=1, le=50, alias="maxClusters"),
):
    """
    按问题类型 × 难度 分组聚类。
    HotpotQA 问题之间的实体和文档几乎不重叠，但类型和难度是有意义的自然维度。
    """
    with get_session() as session:
        result = session.run("""
            MATCH (q:Question)
            RETURN q.qtype AS qtype, q.difficulty AS difficulty, collect(q) AS questions
            ORDER BY qtype, difficulty
        """)
        raw_groups = [(r["qtype"], r["difficulty"], r["questions"]) for r in result]

    clusters_result = []
    for idx, (qtype, difficulty, neo_nodes) in enumerate(raw_groups):
        q_nodes = [_node_to_dict(n) for n in neo_nodes]
        if len(q_nodes) < min_cluster_size:
            continue

        # 收集该组所有问题中的实体，选出频率最高的做标签
        all_entities = []
        for q in q_nodes:
            path = q.get("multi_hop_path", [])
            if isinstance(path, str):
                try:
                    path = _json.loads(path)
                except Exception:
                    path = []
            for hop in (path or []):
                all_entities.extend(hop.get("entities", []))

        from collections import Counter
        top_entities = [e for e, _ in Counter(all_entities).most_common(5)]

        type_cn = "桥接" if qtype == "bridge" else "比较"
        diff_cn = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, difficulty)

        clusters_result.append({
            "id": f"cluster_{idx}",
            "label": f"{type_cn} · {diff_cn}" + (f"（{', '.join(top_entities[:2])}）" if top_entities else ""),
            "questions": q_nodes,
            "topEntities": top_entities,
            "size": len(q_nodes),
            "type": qtype,
        })

    clusters_result.sort(key=lambda c: c["size"], reverse=True)
    return clusters_result[:max_clusters]


@app.get("/api/entities/{entity_name}/questions")
def find_questions_by_entity(entity_name: str):
    """按实体名称反查关联的问题。"""
    with get_session() as session:
        result = session.run("""
            MATCH (e:Entity)-[:MENTIONS]-(:Fact)-[:SUPPORTED_BY]-(q:Question)
            WHERE e.label CONTAINS $name
            RETURN DISTINCT q
            LIMIT 30
        """, name=entity_name)
        return [_node_to_dict(r["q"]) for r in result]


# ── 启动入口 ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
