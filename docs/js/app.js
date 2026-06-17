(function () {
  'use strict';

  let graph, search, cluster, viz;

  async function init() {
    showLoading('正在连接 Neo4j 并加载图数据……');

    try {

      graph = new HotpotGraph();
      await graph.load();

      updateLoading(`已加载 ${graph.nodes.size} 个节点，${graph.edges.size} 条边`);

      updateLoading('正在构建搜索索引……');
      search = new HotpotSearch(graph);
      search.buildIndex();

      updateLoading('正在运行聚类……');
      cluster = new HotpotCluster(graph);
      await cluster.cluster({ minClusterSize: 3, maxClusters: 15 });

      updateLoading('正在初始化可视化……');
      viz = new HotpotViz('graph-container', graph);
      viz.init();

      updateLoading('正在渲染概览……');
      showOverview();

      hideLoading();

      updateStats();

      setupEvents();

      toast('就绪！探索多跳推理链。（数据来自 Neo4j）', 'success');

    } catch (err) {
      console.error('初始化失败：', err);
      hideLoading();
      toast('数据加载失败，请检查 Neo4j 和 API 是否已启动。', 'error');
    }
  }

  function showOverview() {
    const questions = graph.getQuestions();
    console.log(`问题总数: ${questions.length}`);
    const q0 = questions[0];
    const nbrs = graph.adjacency.get(q0.id) || [];
    console.log(`${q0.id} 的邻居数: ${nbrs.length}`);

    const sampleSize = Math.min(200, questions.length);
    const sampled = questions.sort(() => Math.random() - 0.5).slice(0, sampleSize);
    const subNodes = [];
    const subEdges = [];
    const addedNodes = new Set();
    const addedEdges = new Set();

    for (const q of sampled) {
      if (!addedNodes.has(q.id)) { addedNodes.add(q.id); subNodes.push(q); }
      const neighbors = graph.adjacency.get(q.id) || [];
      for (const { target, edgeId } of neighbors.slice(0, 8)) {
        if (!addedEdges.has(edgeId)) { addedEdges.add(edgeId);
          const edge = graph.edges.get(edgeId);
          if (edge) subEdges.push(edge);
        }
        if (!addedNodes.has(target)) { addedNodes.add(target);
          const node = graph.getNode(target);
          if (node) subNodes.push(node);
        }
      }
    }

    console.log(`概览：${subNodes.length} 节点, ${subEdges.length} 边（${sampled.length} 个采样问题）`);
    viz.renderSubgraph({ nodes: subNodes, edges: subEdges }, { fit: true });
  }

  function setupEvents() {

    const searchInput = document.getElementById('search-input');
    const searchSuggestions = document.getElementById('search-suggestions');
    let searchTimeout;

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        searchSuggestions.classList.add('hidden');
        return;
      }
      searchTimeout = setTimeout(() => performSearch(query), 300);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchSuggestions.classList.add('hidden');
        searchInput.blur();
      }
    });

    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !searchSuggestions.contains(e.target)) {
        searchSuggestions.classList.add('hidden');
      }
    });

    document.getElementById('tab-search').addEventListener('click', () => switchTab('search'));
    document.getElementById('tab-clusters').addEventListener('click', () => switchTab('clusters'));

    document.addEventListener('node-click', (e) => {
      const { nodeId, node } = e.detail;
      if (node && node.type === 'question') {
        showQuestionDetail(nodeId);
      } else if (node) {
        showNodeDetail(nodeId);
      }
    });

    document.addEventListener('question-dblclick', (e) => {
      const { nodeId } = e.detail;
      viz.showQuestionGraph(nodeId);
      showQuestionDetail(nodeId);
    });

    document.getElementById('btn-fit').addEventListener('click', () => viz.fitView());
    document.getElementById('btn-reset').addEventListener('click', () => {
      viz.reset();
      showOverview();
      updateStats();
      document.getElementById('detail-content').innerHTML =
        '<p class="text-gray-500 text-sm text-center mt-8">点击问题节点查看详情</p>';
    });
  }

  async function performSearch(query) {
    const container = document.getElementById('search-results');
    const suggestions = document.getElementById('search-suggestions');

    const results = await search.searchQuestions(query, 15);

    if (results.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm text-center mt-8">未找到结果</p>';
      suggestions.classList.add('hidden');
      return;
    }

    container.innerHTML = results.map((r, i) => `
      <div class="search-result-item bg-gray-750 rounded-lg p-3 border border-gray-700 fade-in"
           data-question-id="${r.ref}"
           style="animation-delay: ${i * 30}ms">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <p class="text-sm text-gray-200 leading-snug">${escapeHtml(r.node?.label || r.ref)}</p>
            ${r.node?.answer ? `<p class="text-xs text-blue-400 mt-1">答案：${escapeHtml(r.node.answer)}</p>` : ''}
          </div>
          <span class="text-xs px-1.5 py-0.5 rounded ${r.node?.qtype === 'bridge' ? 'bg-purple-900/50 text-purple-300' : 'bg-teal-900/50 text-teal-300'}">${r.node?.qtype || '?'}</span>
        </div>
        ${r.matchedVia ? `<p class="text-xs text-gray-500 mt-1">匹配自：${escapeHtml(r.matchedVia)}</p>` : ''}
        <div class="flex items-center gap-2 mt-2">
          <span class="text-xs text-gray-500">相关度：${r.score.toFixed(2)}</span>
          <button class="text-xs text-blue-400 hover:text-blue-300 show-in-graph-btn"
                  data-question-id="${r.ref}">在图谱中显示</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', function () {
        const qid = this.dataset.questionId;
        viz.showQuestionGraph(qid);
        showQuestionDetail(qid);
        container.querySelectorAll('.search-result-item').forEach(el => el.classList.remove('active'));
        this.classList.add('active');
      });
    });

    container.querySelectorAll('.show-in-graph-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const qid = this.dataset.questionId;
        viz.showQuestionGraph(qid);
        showQuestionDetail(qid);
      });
    });

    suggestions.innerHTML = results.slice(0, 8).map(r => `
      <div class="px-3 py-2 hover:bg-gray-700 cursor-pointer text-sm border-b border-gray-700 last:border-0 suggestion-item"
           data-question-id="${r.ref}">
        <span class="text-gray-200">${escapeHtml(r.node?.label?.substring(0, 70) || '')}</span>
        <span class="text-xs text-gray-500 ml-2">${r.node?.qtype || ''}</span>
      </div>
    `).join('');
    suggestions.classList.remove('hidden');

    suggestions.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', function () {
        const qid = this.dataset.questionId;
        viz.showQuestionGraph(qid);
        showQuestionDetail(qid);
        suggestions.classList.add('hidden');
        const sideItem = container.querySelector(`[data-question-id="${qid}"]`);
        if (sideItem) {
          container.querySelectorAll('.search-result-item').forEach(el => el.classList.remove('active'));
          sideItem.classList.add('active');
          sideItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    });
  }

  function showQuestionDetail(questionId) {
    const node = graph.getNode(questionId);
    if (!node) return;

    const path = graph.getMultiHopPath(questionId);
    const panel = document.getElementById('detail-content');

    let html = `
      <div class="space-y-4 fade-in">
        <!-- 问题 -->
        <div>
          <span class="text-xs text-gray-500 uppercase tracking-wide">问题</span>
          <span class="ml-2 text-xs px-1.5 py-0.5 rounded ${node.qtype === 'bridge' ? 'bg-purple-900/50 text-purple-300' : 'bg-teal-900/50 text-teal-300'}">${node.qtype}</span>
          <p class="text-sm text-gray-200 mt-1 leading-relaxed">${escapeHtml(node.full_text || node.label)}</p>
        </div>

        <!-- 答案 -->
        <div>
          <span class="text-xs text-gray-500 uppercase tracking-wide">答案</span>
          <p class="text-sm text-green-400 font-medium mt-1">${escapeHtml(node.answer || '未知')}</p>
        </div>

        <!-- 多跳路径 -->
        <div>
          <span class="text-xs text-gray-500 uppercase tracking-wide">多跳推理链（${path.length} 跳）</span>
          <div class="mt-2 space-y-3">
    `;

    if (path.length === 0) {
      html += '<p class="text-xs text-gray-500">没有记录的支持性事实</p>';
    } else {
      path.forEach((hop, i) => {
        html += `
          <div class="hop-step pb-3">
            <span class="text-xs font-bold text-yellow-400">跳 ${hop.hop || (i + 1)}</span>
            <span class="text-xs text-gray-500 ml-2">${escapeHtml(hop.document || '')}</span>
            <p class="text-xs text-gray-300 mt-1 leading-relaxed">${escapeHtml(hop.text || '')}</p>
            ${hop.entities && hop.entities.length > 0 ? `
              <div class="mt-1">
                ${hop.entities.map(e => `<span class="entity-tag">${escapeHtml(e)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        `;
      });
    }

    html += `
          </div>
        </div>

        <!-- 操作 -->
        <div class="flex gap-2 pt-2 border-t border-gray-700">
          <button class="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-white transition"
                  onclick="document.dispatchEvent(new CustomEvent('question-dblclick', {detail: {nodeId:'${questionId}', node:null}}))">
            展开图谱
          </button>
        </div>
      </div>
    `;

    panel.innerHTML = html;
    panel.scrollTop = 0;
  }

  function showNodeDetail(nodeId) {
    const node = graph.getNode(nodeId);
    if (!node || node.type === 'question') return;

    const panel = document.getElementById('detail-content');
    const typeNames = { question: '问题', document: '文档', fact: '事实', entity: '实体' };
    let html = `
      <div class="space-y-3 fade-in">
        <div>
          <span class="text-xs text-gray-500 uppercase tracking-wide">${typeNames[node.type] || node.type}</span>
          <p class="text-sm text-gray-200 mt-1">${escapeHtml(node.full_text || node.label || node.id)}</p>
        </div>
    `;

    const neighbors = graph.adjacency.get(nodeId) || [];
    const connectedQuestions = [];
    const visited = new Set();
    for (const { target, edgeType } of neighbors) {
      const targetNode = graph.getNode(target);
      if (targetNode && targetNode.type === 'question' && !visited.has(target)) {
        visited.add(target);
        connectedQuestions.push(targetNode);
      }
      const secondNeighbors = graph.adjacency.get(target) || [];
      for (const { target: t2 } of secondNeighbors) {
        const t2Node = graph.getNode(t2);
        if (t2Node && t2Node.type === 'question' && !visited.has(t2)) {
          visited.add(t2);
          connectedQuestions.push(t2Node);
        }
      }
    }

    if (connectedQuestions.length > 0) {
      html += `
        <div>
          <span class="text-xs text-gray-500 uppercase tracking-wide">关联问题</span>
          <div class="mt-1 space-y-1">
      `;
      connectedQuestions.slice(0, 5).forEach(q => {
        html += `
          <div class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer hover:underline"
               onclick="document.dispatchEvent(new CustomEvent('question-dblclick', {detail: {nodeId:'${q.id}', node:null}}))">
            ${escapeHtml(q.label?.substring(0, 80) || '')}
          </div>
        `;
      });
      html += '</div></div>';
    }

    html += '</div>';
    panel.innerHTML = html;
  }

  function renderClusters() {
    const clusters = cluster.getClusters();
    const stats = cluster.getStats();
    const listContainer = document.getElementById('cluster-list');
    const statsContainer = document.getElementById('cluster-stats');

    statsContainer.textContent = `${stats.clusterCount} 个聚类 · ${stats.clusteredQuestions}/${stats.totalQuestions} 个问题（${stats.coverage}%）· 平均 ${stats.avgSize} 个/聚类`;

    listContainer.innerHTML = clusters.map((c, i) => `
      <div class="cluster-card bg-gray-750 rounded-lg p-3 border border-gray-700 fade-in"
           data-cluster-id="${c.id}"
           style="animation-delay: ${i * 40}ms">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-medium text-gray-200 truncate">${escapeHtml(c.label)}</span>
          <span class="text-xs px-1.5 py-0.5 rounded ${c.type === 'bridge' ? 'bg-purple-900/50 text-purple-300' : 'bg-teal-900/50 text-teal-300'}">${c.size}</span>
        </div>
        <div class="flex flex-wrap gap-1 mb-2">
          ${c.topEntities.slice(0, 4).map(e => `<span class="entity-tag text-xs">${escapeHtml(e)}</span>`).join('')}
        </div>
        <button class="text-xs text-purple-400 hover:text-purple-300 show-cluster-btn"
                data-cluster-id="${c.id}">可视化聚类</button>
      </div>
    `).join('');

    listContainer.querySelectorAll('.cluster-card').forEach(card => {
      card.addEventListener('click', function () {
        const clusterId = this.dataset.clusterId;
        const c = cluster.getCluster(clusterId);
        if (c) {
          viz.showCluster(c);
          listContainer.querySelectorAll('.cluster-card').forEach(el => el.classList.remove('active'));
          this.classList.add('active');
          if (c.questions.length > 0) {
            showQuestionDetail(c.questions[0].id);
          }
        }
      });
    });

    listContainer.querySelectorAll('.show-cluster-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const clusterId = this.dataset.clusterId;
        const c = cluster.getCluster(clusterId);
        if (c) viz.showCluster(c);
      });
    });
  }

  function switchTab(tab) {
    const tabSearch = document.getElementById('tab-search');
    const tabClusters = document.getElementById('tab-clusters');
    const panelSearch = document.getElementById('panel-search');
    const panelClusters = document.getElementById('panel-clusters');

    if (tab === 'search') {
      tabSearch.className = 'flex-1 px-3 py-2 text-sm font-medium text-blue-400 border-b-2 border-blue-400';
      tabClusters.className = 'flex-1 px-3 py-2 text-sm font-medium text-gray-400 border-b-2 border-transparent hover:text-gray-200';
      panelSearch.classList.remove('hidden');
      panelClusters.classList.add('hidden');
    } else {
      tabClusters.className = 'flex-1 px-3 py-2 text-sm font-medium text-blue-400 border-b-2 border-blue-400';
      tabSearch.className = 'flex-1 px-3 py-2 text-sm font-medium text-gray-400 border-b-2 border-transparent hover:text-gray-200';
      panelClusters.classList.remove('hidden');
      panelSearch.classList.add('hidden');
      if (panelClusters.querySelector('#cluster-list').children.length === 0) {
        renderClusters();
      }
    }
  }

  function updateStats() {
    const stats = graph.getStats();
    document.getElementById('graph-stats').textContent =
      `${stats.questionCount}问题 · ${stats.documentCount}文档 · ${stats.factCount}事实 · ${stats.entityCount}实体`;
  }

  function showLoading(msg) {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden-overlay');
    document.getElementById('loading-progress').textContent = msg || '';
  }

  function updateLoading(msg) {
    document.getElementById('loading-progress').textContent = msg || '';
  }

  function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hidden-overlay');
  }

  function toast(message, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.style.opacity = '1';
    if (type === 'error') {
      el.className = el.className.replace('text-gray-200', 'text-red-300');
    }
    setTimeout(() => { el.style.opacity = '0'; }, 3000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);

})();
