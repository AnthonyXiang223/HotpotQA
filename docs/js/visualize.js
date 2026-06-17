/**
 * visualize.js - 使用 vis-network 进行图可视化。
 * 渲染 HotpotQA 图并支持交互功能。
 * 需要在此脚本之前加载 vis-network。
 */

class HotpotViz {
  constructor(containerId, graph) {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.graph = graph;
    this.network = null;
    this.data = { nodes: new vis.DataSet(), edges: new vis.DataSet() };
    this.currentQuestionId = null;
    this.highlightedPath = null;

    // 节点类型配色方案（深色调，白色文字可清晰阅读）
    this.colors = {
      question: { background: '#1a3a6e', border: '#0f2240', shape: 'dot' },
      document: { background: '#1a4a2a', border: '#0e2a17', shape: 'square' },
      fact: { background: '#7a5c10', border: '#4a3708', shape: 'box' },
      entity: { background: '#7a1f1a', border: '#4a100e', shape: 'diamond' },
    };

    // 节点类型到图标的映射（使用 Unicode 字符）
    this.icons = {
      question: 'Q',
      document: 'D',
      fact: 'F',
      entity: 'E',
    };
  }

  /**
   * 初始化 vis-network 实例。
   */
  init() {
    if (!this.container) {
      console.error(`容器 #${this.containerId} 未找到`);
      return;
    }

    const options = {
      nodes: {
        font: { size: 12, face: 'Arial', color: '#e0e0e0' },
        borderWidth: 2,
        size: 25,
        color: {
          border: '#1a3a5c',
          background: '#2a4a7c',
          highlight: { border: '#3a5a9c', background: '#4a6aac' },
        },
        shape: 'dot',
        scaling: {
          min: 20,
          max: 50,
          label: { enabled: true, min: 10, max: 18 },
        },
      },
      edges: {
        width: 1.5,
        color: { color: '#6a6a8a', highlight: '#6a8aff', opacity: 0.6 },
        smooth: { type: 'continuous', roundness: 0.5 },
        arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -35,
          centralGravity: 0.01,
          springLength: 120,
          springConstant: 0.08,
          damping: 0.4,
        },
        stabilization: { iterations: 200, updateInterval: 25 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        navigationButtons: true,
        keyboard: true,
        zoomView: true,
      },
      layout: { improvedLayout: true },
    };

    this.network = new vis.Network(this.container, this.data, options);

    // 事件处理
    this.network.on('click', (params) => this._onClick(params));
    this.network.on('doubleClick', (params) => this._onDoubleClick(params));
    this.network.on('hoverNode', (params) => this._onHoverNode(params));
    this.network.on('blurNode', () => this._unhoverNode());

    console.log('可视化已初始化');
  }

  /**
   * 将图子图转换为 vis-network 格式并渲染。
   */
  renderSubgraph(subgraph, options = {}) {
    const { focusNode = null, highlightPath = null, fit = true } = options;

    // 清空现有数据
    this.data.nodes.clear();
    this.data.edges.clear();

    // 添加节点
    const visNodes = subgraph.nodes.map(node => this._toVisNode(node));
    this.data.nodes.add(visNodes);

    // 添加边
    const visEdges = subgraph.edges.map((edge, idx) => this._toVisEdge(edge, idx));
    this.data.edges.add(visEdges);

    // 如果指定了多跳路径则高亮显示
    if (highlightPath) {
      this._highlightPath(highlightPath);
      this.highlightedPath = highlightPath;
    }

    // 适应视图
    if (fit) {
      setTimeout(() => {
        if (focusNode) {
          this.network.focus(focusNode, { scale: 1.2, animation: true });
        } else {
          this.network.fit({ animation: true });
        }
      }, 300);
    }
  }

  /**
   * 显示问题的完整图（问题 + 上下文文档 + 事实 + 实体）。
   */
  showQuestionGraph(questionId) {
    this.currentQuestionId = questionId;
    const subgraph = this.graph.getQuestionSubgraph(questionId);
    const path = this.graph.getMultiHopPath(questionId);

    this.renderSubgraph(subgraph, {
      focusNode: questionId,
      highlightPath: path,
    });

    return subgraph;
  }

  /**
   * 显示搜索结果邻域。
   */
  showNeighborhood(nodeId, depth = 2) {
    const subgraph = this.graph.getNeighborhood(nodeId, depth);
    this.renderSubgraph(subgraph, { focusNode: nodeId });
    return subgraph;
  }

  /**
   * 显示聚类概览：聚类中的所有问题及其连接。
   */
  showCluster(cluster) {
    const subNodes = [];
    const subEdges = [];
    const addedNodes = new Set();
    const addedEdges = new Set();

    for (const qNode of cluster.questions) {
      // 添加问题节点
      if (!addedNodes.has(qNode.id)) {
        addedNodes.add(qNode.id);
        subNodes.push(qNode);
      }

      // 添加关联的事实和实体
      const neighbors = this.graph.adjacency.get(qNode.id) || [];
      for (const { target, edgeId } of neighbors) {
        if (!addedEdges.has(edgeId)) {
          addedEdges.add(edgeId);
          const edge = this.graph.edges.get(edgeId);
          if (edge) subEdges.push(edge);
        }
        if (!addedNodes.has(target)) {
          addedNodes.add(target);
          const node = this.graph.getNode(target);
          if (node) subNodes.push(node);
        }
      }
    }

    this.renderSubgraph({ nodes: subNodes, edges: subEdges }, { fit: true });
    return { nodes: subNodes, edges: subEdges };
  }

  /**
   * 高亮显示多跳推理路径。
   */
  _highlightPath(path) {
    if (!path || path.length === 0) return;

    const pathNodeIds = new Set();
    const pathEdgePairs = new Set();

    // 收集路径节点
    for (const hop of path) {
      pathNodeIds.add(hop.fact_id);
      // 添加关联的实体
      const factNode = this.graph.getNode(hop.fact_id);
      if (factNode) {
        const neighbors = this.graph.adjacency.get(hop.fact_id) || [];
        for (const { target, edgeId, edgeType } of neighbors) {
          if (edgeType === 'mentions') {
            pathNodeIds.add(target);
            pathEdgePairs.add(`${hop.fact_id}_${target}`);
          }
        }
        // 添加文档连接
        for (const { target, edgeId, edgeType } of neighbors) {
          if (edgeType === 'belongs_to') {
            pathNodeIds.add(target);
            pathEdgePairs.add(`${hop.fact_id}_${target}`);
          }
        }
      }
    }

    // 更新节点样式和边样式
    const allNodes = this.data.nodes.get();
    const allEdges = this.data.edges.get();

    for (const node of allNodes) {
      if (pathNodeIds.has(node.id)) {
        this.data.nodes.update({
          id: node.id,
          borderWidth: 4,
          borderWidthSelected: 4,
          color: {
            ...node.color,
            border: '#FF6D00',
            highlight: { ...node.color.highlight, border: '#FF6D00' },
          },
        });
      }
    }

    for (const edge of allEdges) {
      const key1 = `${edge.from}_${edge.to}`;
      const key2 = `${edge.to}_${edge.from}`;
      if (pathEdgePairs.has(key1) || pathEdgePairs.has(key2)) {
        this.data.edges.update({
          id: edge.id,
          width: 3,
          color: { color: '#FF6D00', highlight: '#FF8F00', opacity: 1.0 },
        });
      }
    }
  }

  /**
   * 重置所有高亮。
   */
  clearHighlights() {
    const allNodes = this.data.nodes.get();
    const allEdges = this.data.edges.get();

    for (const node of allNodes) {
      const defaultColor = this.colors[node.nodeType] || this.colors.question;
      this.data.nodes.update({
        id: node.id,
        borderWidth: 2,
        color: {
          background: node._origBackground || defaultColor.background,
          border: node._origBorder || defaultColor.border,
          highlight: { border: node._origBorder || defaultColor.border, background: node._origBackground || defaultColor.background },
        },
      });
    }

    for (const edge of allEdges) {
      this.data.edges.update({
        id: edge.id,
        width: 1.5,
        color: { color: '#6a6a8a', highlight: '#6a8aff', opacity: 0.6 },
      });
    }
  }

  /**
   * 适应视图以显示所有节点。
   */
  fitView() {
    if (this.network) {
      this.network.fit({ animation: true });
    }
  }

  /**
   * 重置视图。
   */
  reset() {
    this.data.nodes.clear();
    this.data.edges.clear();
    this.currentQuestionId = null;
    this.highlightedPath = null;
  }

  // ── 内部辅助函数 ────────────────────────────────────────────

  _toVisNode(node) {
    const colors = this.colors[node.type] || this.colors.question;
    const label = this._truncate(node.label || node.id, 35);

    return {
      id: node.id,
      label: label,
      title: this._buildTooltip(node),
      shape: colors.shape,
      color: {
        background: colors.background,
        border: colors.border,
        highlight: { border: colors.border, background: colors.background },
      },
      borderWidth: 2,
      size: node.type === 'question' ? 30 : (node.type === 'entity' ? 18 : 22),
      font: {
        size: node.type === 'question' ? 13 : 11,
        color: '#e0e0e0',
        multi: false,
      },
      nodeType: node.type,
      _origBackground: colors.background,
      _origBorder: colors.border,
    };
  }

  _toVisEdge(edge, idx) {
    const styleMap = {
      supported_by: { color: '#6a9fff', dashes: false, width: 2 },
      appears_in: { color: '#6a6a8a', dashes: true, width: 1 },
      belongs_to: { color: '#4a9a5a', dashes: true, width: 1 },
      mentions: { color: '#d4706a', dashes: false, width: 1.5 },
      co_occurs: { color: '#b87cc7', dashes: true, width: 1 },
    };
    const style = styleMap[edge.type] || { color: '#6a6a8a', dashes: false, width: 1 };

    return {
      id: `${edge.source}_${edge.target}_${edge.type}_${idx}`,
      from: edge.source,
      to: edge.target,
      label: edge.type === 'supported_by' ? `跳 ${edge.hop || '?'}` : '',
      color: { color: style.color, highlight: '#6a8aff', opacity: 0.7 },
      width: style.width,
      dashes: style.dashes,
      arrows: { to: { enabled: !style.dashes, scaleFactor: 0.5 } },
      edgeType: edge.type,
      font: { size: 8, color: '#ccc', strokeWidth: 0 },
    };
  }

  _buildTooltip(node) {
    // 节点类型中文映射
    const typeNames = { question: '问题', document: '文档', fact: '事实', entity: '实体' };
    let html = `<div style="max-width:300px;padding:4px;">`;
    html += `<strong>${typeNames[node.type] || node.type.toUpperCase()}</strong><br>`;
    html += `<span>${node.label}</span>`;
    if (node.answer) {
      html += `<br><b>答案：</b> ${node.answer}`;
    }
    if (node.qtype) {
      html += `<br><b>类型：</b> ${node.qtype}`;
    }
    if (node.hop) {
      html += `<br><b>跳：</b> ${node.hop}`;
    }
    html += `</div>`;
    return html;
  }

  _truncate(text, maxLen) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  // ── 事件处理 ────────────────────────────────────────────────

  _onClick(params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const node = this.graph.getNode(nodeId);
      // 派发事件供应用处理
      const event = new CustomEvent('node-click', { detail: { nodeId, node } });
      document.dispatchEvent(event);
    }
  }

  _onDoubleClick(params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const node = this.graph.getNode(nodeId);
      if (node && node.type === 'question') {
        const event = new CustomEvent('question-dblclick', { detail: { nodeId, node } });
        document.dispatchEvent(event);
      }
    }
  }

  _onHoverNode(params) {
    const nodeId = params.node;
    const node = this.graph.getNode(nodeId);
    // 可以显示浮动提示或高亮关联边
  }

  _unhoverNode() {
    // 重置悬停状态
  }
}

window.HotpotViz = HotpotViz;
