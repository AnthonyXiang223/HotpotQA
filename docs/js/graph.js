/**
 * graph.js - HotpotQA 多跳探索图引擎。
 * 管理图的构建、路径查找和邻域查询。
 * 数据来源：Neo4j 图数据库（通过 FastAPI）。
 */
class HotpotGraph {
  constructor() {
    /**
     * API 地址列表（按优先级自动检测）：
     * 1. Render 云端 API（部署后自动生效）
     * 2. 本地开发 API
     * 无法连接时回退到本地 JSON 文件。
     */
    this.apiCandidates = [
      'https://hotpotqa-api.onrender.com',  // Render 云端（push 后去 Render 创建即可）
      'http://localhost:8000',              // 本地开发
    ];
    /** 当前可用的 API 地址（自动探测） */
    this.apiBase = null;
    /** 节点 Map：id → 节点数据 */
    this.nodes = new Map();
    /** 边 Map：id → 边数据 */
    this.edges = new Map();
    /** 邻接表：nodeId → [{target, edgeId, edgeType}] */
    this.adjacency = new Map();
    /** 多跳路径：questionId → 跳转链 */
    this.multiHopPaths = {};
    /** 节点类型索引：type → [nodeIds] */
    this.nodeTypes = new Map();
  }

  /**
   * 从 Neo4j API 加载完整图数据，格式与旧 JSON 兼容。
   * @param {object} [_data] - 可选，传入数据则从本地加载（回退模式）
   */
  /**
   * 自动探测可用的 API 地址。
   */
  async _detectApi() {
    for (const url of this.apiCandidates) {
      try {
        const resp = await fetch(`${url}/api/graph/stats`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          this.apiBase = url;
          console.log(`API 已连接：${url}`);
          return;
        }
      } catch (_) { /* 继续尝试下一个 */ }
    }
    console.log('无可用 API，将使用本地 JSON 数据');
  }

  async load(_data) {
    let data = _data;
    if (!data) {
      // 先探测可用的 API
      if (!this.apiBase) await this._detectApi();

      if (this.apiBase) {
        // 从 Neo4j API 加载
        try {
          const resp = await fetch(`${this.apiBase}/api/graph/full`);
          if (!resp.ok) throw new Error(`API 返回 ${resp.status}`);
          data = await resp.json();
          console.log(`数据已从 ${this.apiBase} 加载`);
        } catch (err) {
          console.warn('API 加载失败，回退本地 JSON...', err.message);
        }
      }

      // API 不可用或失败 → 回退本地 JSON
      if (!data) {
        const resp = await fetch('data/hotpot_graph.json');
        if (!resp.ok) throw new Error(`本地 JSON 加载失败 ${resp.status}`);
        data = await resp.json();
        console.log('已回退到本地 JSON 数据');
      }
    }

    // 加载节点（逻辑与旧版相同）
    for (const node of data.nodes) {
      this.nodes.set(node.id, node);
      if (!this.nodeTypes.has(node.type)) {
        this.nodeTypes.set(node.type, []);
      }
      this.nodeTypes.get(node.type).push(node.id);
      if (!this.adjacency.has(node.id)) {
        this.adjacency.set(node.id, []);
      }
    }

    // 加载边
    for (const edge of data.edges) {
      const edgeId = `${edge.source}_${edge.target}_${edge.type}`;
      this.edges.set(edgeId, edge);
      // 构建邻接表（无向图遍历）
      if (this.adjacency.has(edge.source)) {
        this.adjacency.get(edge.source).push({
          target: edge.target,
          edgeId: edgeId,
          edgeType: edge.type,
        });
      }
      if (this.adjacency.has(edge.target)) {
        this.adjacency.get(edge.target).push({
          target: edge.source,
          edgeId: edgeId,
          edgeType: edge.type,
        });
      }
    }

    // 加载多跳路径
    this.multiHopPaths = data.multi_hop_paths || {};

    console.log(`图已加载：${this.nodes.size} 个节点，${this.edges.size} 条边`);
    console.log(`  节点类型：${[...this.nodeTypes.entries()].map(([t, ids]) => `${t}:${ids.length}`).join(', ')}`);
  }

  /**
   * 通过 ID 获取节点。
   */
  getNode(nodeId) {
    return this.nodes.get(nodeId);
  }

  /**
   * 获取给定类型的所有节点。
   */
  getNodesByType(type) {
    return (this.nodeTypes.get(type) || []).map(id => this.nodes.get(id));
  }

  /**
   * 获取所有问题节点。
   */
  getQuestions() {
    return this.getNodesByType('question');
  }

  /**
   * 获取问题的多跳推理路径。
   * 返回包含实体和文档的有序事实列表。
   */
  getMultiHopPath(questionId) {
    return this.multiHopPaths[questionId] || [];
  }

  /**
   * 使用 BFS 获取节点周围指定深度的邻域。
   * 返回 {nodes: [...], edges: [...]} 子图。
   */
  getNeighborhood(nodeId, depth = 2) {
    const visited = new Set();
    const queue = [{ id: nodeId, dist: 0 }];
    const subNodes = [];
    const subEdges = [];
    const addedEdges = new Set();

    visited.add(nodeId);
    const startNode = this.nodes.get(nodeId);
    if (startNode) subNodes.push(startNode);

    while (queue.length > 0) {
      const { id, dist } = queue.shift();
      if (dist >= depth) continue;

      const neighbors = this.adjacency.get(id) || [];
      for (const { target, edgeId, edgeType } of neighbors) {
        // 添加边
        if (!addedEdges.has(edgeId)) {
          addedEdges.add(edgeId);
          const edge = this.edges.get(edgeId);
          if (edge) subEdges.push(edge);
        }

        if (!visited.has(target)) {
          visited.add(target);
          const node = this.nodes.get(target);
          if (node) {
            subNodes.push(node);
            queue.push({ id: target, dist: dist + 1 });
          }
        }
      }
    }

    return { nodes: subNodes, edges: subEdges };
  }

  /**
   * 获取问题的完整推理子图：
   * 问题节点 + 其支持性事实 + 对应文档 + 实体。
   */
  getQuestionSubgraph(questionId) {
    const subNodes = [];
    const subEdges = [];
    const addedNodes = new Set();
    const addedEdges = new Set();

    const addNode = (nodeId) => {
      if (!addedNodes.has(nodeId)) {
        addedNodes.add(nodeId);
        const node = this.nodes.get(nodeId);
        if (node) subNodes.push(node);
      }
    };

    const addEdge = (edgeId) => {
      if (!addedEdges.has(edgeId)) {
        addedEdges.add(edgeId);
        const edge = this.edges.get(edgeId);
        if (edge) subEdges.push(edge);
      }
    };

    // 添加问题节点
    addNode(questionId);

    // 添加所有邻居及其边
    const neighbors = this.adjacency.get(questionId) || [];
    for (const { target, edgeId } of neighbors) {
      addEdge(edgeId);
      addNode(target);
      // 添加第二层邻居（事实 → 实体，事实 → 文档）
      const secondNeighbors = this.adjacency.get(target) || [];
      for (const { target: t2, edgeId: e2 } of secondNeighbors) {
        addEdge(e2);
        addNode(t2);
      }
    }

    return { nodes: subNodes, edges: subEdges };
  }

  /**
   * 查找涉及给定实体（按名称）的所有问题。
   */
  findQuestionsByEntity(entityName) {
    const results = [];
    const entityNameLower = entityName.toLowerCase();
    for (const [nodeId, node] of this.nodes) {
      if (node.type === 'entity' && node.label.toLowerCase().includes(entityNameLower)) {
        // 查找与该实体相连的问题
        const neighbors = this.adjacency.get(nodeId) || [];
        for (const { target, edgeType } of neighbors) {
          if (edgeType === 'mentions') {
            const factNode = this.nodes.get(target);
            if (factNode) {
              const factNeighbors = this.adjacency.get(target) || [];
              for (const { target: qTarget, edgeType: qEdgeType } of factNeighbors) {
                if (qEdgeType === 'supported_by') {
                  const qNode = this.nodes.get(qTarget);
                  if (qNode && !results.find(r => r.id === qTarget)) {
                    results.push(qNode);
                  }
                }
              }
            }
          }
        }
      }
    }
    return results;
  }

  /**
   * 获取图统计信息。
   */
  getStats() {
    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      questionCount: (this.nodeTypes.get('question') || []).length,
      documentCount: (this.nodeTypes.get('document') || []).length,
      factCount: (this.nodeTypes.get('fact') || []).length,
      entityCount: (this.nodeTypes.get('entity') || []).length,
    };
  }
}

// 导出供其他模块使用
window.HotpotGraph = HotpotGraph;
