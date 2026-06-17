class HotpotCluster {
  constructor(graph) {
    this.graph = graph;
    this.apiBase = graph.apiBase;
    this.clusters = [];
  }

  async cluster(options = {}) {
    const { minClusterSize = 3, maxClusters = 20 } = options;

    if (this.apiBase) {
      try {
        const resp = await fetch(
          `${this.apiBase}/api/clusters?minClusterSize=${minClusterSize}&maxClusters=${maxClusters}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (resp.ok) {
          this.clusters = await resp.json();
          if (this.clusters && this.clusters.length > 0) {
            console.log(`API 聚类完成：${this.clusters.length} 个聚类`);
            return this.clusters;
          }
        }
      } catch (err) {
        console.warn('API 聚类不可用，使用本地计算');
      }
    }

    this._clusterLocal(minClusterSize, maxClusters);
    return this.clusters;
  }

  _clusterLocal(minClusterSize, maxClusters) {
    const questions = this.graph.getQuestions();
    if (questions.length === 0) return;

    const groups = {};
    for (const q of questions) {
      const key = `${q.qtype || 'unknown'}|${q.difficulty || 'medium'}`;
      if (!groups[key]) groups[key] = { qtype: q.qtype, difficulty: q.difficulty, questions: [] };
      groups[key].questions.push(q);
    }

    this.clusters = Object.entries(groups)
      .filter(([, g]) => g.questions.length >= minClusterSize)
      .map(([, g], idx) => {
        const qNodes = g.questions;
        const entCount = {};
        for (const q of qNodes) {
          const path = this.graph.getMultiHopPath(q.id);
          for (const hop of path) {
            for (const e of (hop.entities || [])) {
              entCount[e] = (entCount[e] || 0) + 1;
            }
          }
        }
        const topEntities = Object.entries(entCount)
          .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
        const typeCN = g.qtype === 'bridge' ? '桥接' : '比较';
        const diffCN = { easy: '简单', medium: '中等', hard: '困难' }[g.difficulty] || g.difficulty;
        const label = `${typeCN} · ${diffCN}` + (topEntities.length ? `（${topEntities.slice(0, 2).join(', ')}）` : '');

        return {
          id: `cluster_${idx}`, label, questions: qNodes,
          topEntities, size: qNodes.length, type: g.qtype,
        };
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, maxClusters);

    console.log(`本地聚类完成：${this.clusters.length} 个聚类`);
  }

  getCluster(clusterId) {
    return this.clusters.find(c => c.id === clusterId);
  }

  getClusters() {
    return this.clusters;
  }

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
