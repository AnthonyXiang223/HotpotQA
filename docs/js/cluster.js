/**
 * cluster.js - HotpotQA 问题聚类模块。
 * 默认使用 Neo4j API 进行服务端聚类（Jaccard 相似度 + 凝聚式合并），
 * 当 API 不可用时回退到客户端计算。
 */
class HotpotCluster {
  constructor(graph) {
    this.graph = graph;
    this.apiBase = graph.apiBase || 'http://localhost:8000';
    /** 聚类结果：[{id, label, questions, topEntities, size, type}] */
    this.clusters = [];
  }

  /**
   * 运行聚类（优先 API，回退本地计算）。
   */
  async cluster(options = {}) {
    const { minClusterSize = 3, maxClusters = 20 } = options;

    // 尝试 Neo4j API
    try {
      const resp = await fetch(
        `${this.apiBase}/api/clusters?minClusterSize=${minClusterSize}&maxClusters=${maxClusters}`
      );
      if (resp.ok) {
        this.clusters = await resp.json();
        if (this.clusters && this.clusters.length > 0) {
          console.log(`API 聚类完成：${this.clusters.length} 个聚类`);
          return this.clusters;
        }
      }
    } catch (err) {
      console.warn('API 聚类不可用，回退到本地计算：', err.message);
    }

    // 回退：本地 Jaccard 聚类（逻辑保持不变）
    this._clusterLocal(minClusterSize, maxClusters);
    return this.clusters;
  }

  /**
   * 本地 Jaccard 聚类（回退方案，逻辑与旧版相同）。
   */
  _clusterLocal(minClusterSize, maxClusters) {
    const questions = this.graph.getQuestions();
    if (questions.length === 0) return;

    const questionEntities = new Map();
    const entityQuestions = new Map();

    for (const q of questions) {
      const entities = new Set();
      const path = this.graph.getMultiHopPath(q.id);
      for (const hop of path) {
        for (const entName of (hop.entities || [])) {
          entities.add(entName.toLowerCase());
          if (!entityQuestions.has(entName.toLowerCase())) {
            entityQuestions.set(entName.toLowerCase(), new Set());
          }
          entityQuestions.get(entName.toLowerCase()).add(q.id);
        }
      }
      questionEntities.set(q.id, entities);
    }

    const bridgeQuestions = questions.filter(q => q.qtype === 'bridge');
    const comparisonQuestions = questions.filter(q => q.qtype === 'comparison');
    const allClusters = [];

    for (const group of [bridgeQuestions, comparisonQuestions]) {
      if (group.length === 0) continue;
      let subClusters = group.map(q => ({
        ids: new Set([q.id]),
        entities: new Set(questionEntities.get(q.id) || []),
      }));

      for (let iter = 0; iter < 50; iter++) {
        let merged = false;
        for (let i = 0; i < subClusters.length; i++) {
          for (let j = i + 1; j < subClusters.length; j++) {
            if (!subClusters[i].ids.size || !subClusters[j].ids.size) continue;
            const overlap = new Set([...subClusters[i].entities].filter(x => subClusters[j].entities.has(x)));
            const union = new Set([...subClusters[i].entities, ...subClusters[j].entities]);
            const jaccard = union.size > 0 ? overlap.size / union.size : 0;
            if (jaccard > 0.08 || overlap.size >= 1) {
              for (const id of subClusters[j].ids) subClusters[i].ids.add(id);
              for (const ent of subClusters[j].entities) subClusters[i].entities.add(ent);
              subClusters[j].ids.clear();
              subClusters[j].entities.clear();
              merged = true;
            }
          }
        }
        subClusters = subClusters.filter(c => c.ids.size > 0);
        if (!merged) break;
      }
      allClusters.push(...subClusters);
    }

    this.clusters = allClusters
      .filter(c => c.ids.size >= minClusterSize)
      .map((c, idx) => {
        const qNodes = [...c.ids].map(id => this.graph.getNode(id)).filter(Boolean);
        const entCount = {};
        for (const ent of c.entities) entCount[ent] = (entCount[ent] || 0) + 1;
        const topEntities = Object.entries(entCount)
          .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
        return {
          id: `cluster_${idx}`,
          label: topEntities.slice(0, 3).join(', ') || `聚类 ${idx + 1}`,
          questions: qNodes, topEntities, size: qNodes.length,
          type: qNodes[0]?.qtype || 'mixed',
        };
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, maxClusters);

    console.log(`本地聚类完成：${this.clusters.length} 个聚类`);
  }

  /** 通过 ID 获取聚类。 */
  getCluster(clusterId) {
    return this.clusters.find(c => c.id === clusterId);
  }

  /** 获取所有聚类。 */
  getClusters() {
    return this.clusters;
  }

  /** 获取聚类统计信息。 */
  getStats() {
    const totalClustered = this.clusters.reduce((sum, c) => sum + c.size, 0);
    const totalQuestions = this.graph.getQuestions().length;
    return {
      clusterCount: this.clusters.length,
      clusteredQuestions: totalClustered,
      totalQuestions,
      coverage: totalQuestions > 0 ? (totalClustered / totalQuestions * 100).toFixed(1) : 0,
      avgSize: this.clusters.length > 0 ? (totalClustered / this.clusters.length).toFixed(1) : 0,
    };
  }
}

window.HotpotCluster = HotpotCluster;
