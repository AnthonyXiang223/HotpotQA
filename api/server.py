import json as _json
from collections import defaultdict
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase

app = FastAPI(title="HotpotQA Neo4j API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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

def _node_to_dict(neo_node):
    
    d = dict(neo_node)

    if "type" not in d and hasattr(neo_node, 'labels'):
        labels = list(neo_node.labels)
        if labels:
            d["type"] = labels[0].lower()

    if "multi_hop_path" in d and isinstance(d["multi_hop_path"], str):
        try:
            d["multi_hop_path"] = _json.loads(d["multi_hop_path"])
        except (_json.JSONDecodeError, TypeError):
            pass
    return d

def _record_to_dict(record, key="n"):
    
    node = record.get(key)
    if node is not None:
        return _node_to_dict(node)
    return dict(record)

def _subgraph_query(cypher, params):
    
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

            if hasattr(value, 'labels'):
                nid = value.get("id")
                if nid and nid not in nodes_map:
                    nodes_map[nid] = _node_to_dict(value)

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

@app.get("/api/graph/full")
def get_full_graph():
    
    with get_session() as session:

        nodes_result = session.run("MATCH (n) RETURN n")
        nodes = [_node_to_dict(r["n"]) for r in nodes_result]

        edges_result = session.run()
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

        paths_result = session.run()
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
    
    with get_session() as session:
        result = session.run()
        stats = {}
        for record in result:
            stats[f"{record['label'].lower()}Count"] = record['cnt']

        result = session.run()
        for record in result:
            stats[f"{record['rel_type'].lower()}EdgeCount"] = record['cnt']

        total_nodes = sum(v for k, v in stats.items() if k.endswith("Count") and not k.endswith("EdgeCount"))
        total_edges = sum(v for k, v in stats.items() if k.endswith("EdgeCount"))
        stats["totalNodes"] = total_nodes
        stats["totalEdges"] = total_edges

    return stats

@app.get("/api/questions")
def get_questions(limit: int = Query(250, ge=1, le=1000)):
    
    with get_session() as session:
        result = session.run(
            "MATCH (n:Question) RETURN n ORDER BY n.id LIMIT $limit",
            limit=limit
        )
        questions = [_record_to_dict(r) for r in result]
    return questions

@app.get("/api/questions/{question_id}")
def get_question(question_id: str):
    
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
    
    cypher = 
    return _subgraph_query(cypher, {"qid": question_id})

@app.get("/api/nodes/{node_id}")
def get_node(node_id: str):
    
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
    
    cypher =  + str(depth) + 
    return _subgraph_query(cypher, {"nid": node_id})

@app.get("/api/search")
def search(q: str = Query(..., min_length=2), limit: int = Query(15, ge=1, le=50)):
    
    matches = []

    with get_session() as session:

        try:
            result = session.run(
                ,
                query=q, limit=limit * 3
            )
            for record in result:
                matches.append((
                    _node_to_dict(record["node"]),
                    record["score"],
                ))
        except Exception:
            pass

        if not matches:
            try:
                result = session.run(
                    ,
                    q=q, limit=limit * 3
                )
                for record in result:
                    matches.append((
                        _node_to_dict(record["node"]),
                        record["score"],
                    ))
            except Exception:
                pass

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
    
    with get_session() as session:
        result = session.run(, nid=node_id)
        return [_node_to_dict(r["question"]) for r in result if r["question"]]

@app.get("/api/clusters")
def get_clusters(
    min_cluster_size: int = Query(3, ge=2, le=20, alias="minClusterSize"),
    max_clusters: int = Query(15, ge=1, le=50, alias="maxClusters"),
):
    
    with get_session() as session:
        result = session.run()
        raw_groups = [(r["qtype"], r["difficulty"], r["questions"]) for r in result]

    clusters_result = []
    for idx, (qtype, difficulty, neo_nodes) in enumerate(raw_groups):
        q_nodes = [_node_to_dict(n) for n in neo_nodes]
        if len(q_nodes) < min_cluster_size:
            continue

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
    
    with get_session() as session:
        result = session.run(, name=entity_name)
        return [_node_to_dict(r["q"]) for r in result]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
