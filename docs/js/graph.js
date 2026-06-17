class HotpotGraph {
  constructor() {
    
    this.apiCandidates = [
      'https://hotpotqa-api.onrender.com',
      'http://localhost:8000',
    ];
    
    this.apiBase = null;
    
    this.nodes = new Map();
    
    this.edges = new Map();
    
    this.adjacency = new Map();
    
    this.multiHopPaths = {};
    
    this.nodeTypes = new Map();
  }

  
  
  async _detectApi() {
    for (const url of this.apiCandidates) {
      try {
        const resp = await fetch(`${url}/api/graph/stats`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          this.apiBase = url;
          console.log(`API 已连接：${url}`);
          return;
        }
      } catch (_) {  }
    }
    console.log('无可用 API，将使用本地 JSON 数据');
  }

  async load(_data) {
    let data = _data;
    if (!data) {

      if (!this.apiBase) await this._detectApi();

      if (this.apiBase) {

        try {
          const resp = await fetch(`${this.apiBase}/api/graph/full`);
          if (!resp.ok) throw new Error(`API 返回 ${resp.status}`);
          data = await resp.json();
          console.log(`数据已从 ${this.apiBase} 加载`);
        } catch (err) {
          console.warn('API 加载失败，回退本地 JSON...', err.message);
        }
      }

      if (!data) {
        const resp = await fetch('data/hotpot_graph.json');
        if (!resp.ok) throw new Error(`本地 JSON 加载失败 ${resp.status}`);
        data = await resp.json();
        console.log('已回退到本地 JSON 数据');
      }
    }

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

    for (const edge of data.edges) {
      const edgeId = `${edge.source}_${edge.target}_${edge.type}`;
      this.edges.set(edgeId, edge);

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

    this.multiHopPaths = data.multi_hop_paths || {};

    console.log(`图已加载：${this.nodes.size} 个节点，${this.edges.size} 条边`);
    console.log(`  节点类型：${[...this.nodeTypes.entries()].map(([t, ids]) => `${t}:${ids.length}`).join(', ')}`);
  }

  
  getNode(nodeId) {
    return this.nodes.get(nodeId);
  }

  
  getNodesByType(type) {
    return (this.nodeTypes.get(type) || []).map(id => this.nodes.get(id));
  }

  
  getQuestions() {
    return this.getNodesByType('question');
  }

  
  getMultiHopPath(questionId) {
    return this.multiHopPaths[questionId] || [];
  }

  
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

    addNode(questionId);

    const neighbors = this.adjacency.get(questionId) || [];
    for (const { target, edgeId } of neighbors) {
      addEdge(edgeId);
      addNode(target);

      const secondNeighbors = this.adjacency.get(target) || [];
      for (const { target: t2, edgeId: e2 } of secondNeighbors) {
        addEdge(e2);
        addNode(t2);
      }
    }

    return { nodes: subNodes, edges: subEdges };
  }

  
  findQuestionsByEntity(entityName) {
    const results = [];
    const entityNameLower = entityName.toLowerCase();
    for (const [nodeId, node] of this.nodes) {
      if (node.type === 'entity' && node.label.toLowerCase().includes(entityNameLower)) {

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

window.HotpotGraph = HotpotGraph;
