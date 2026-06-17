class HotpotSearch {
  constructor(graph) {
    this.graph = graph;
    this.apiBase = graph.apiBase || 'http://localhost:8000';
    
    this.idx = null;
    
    this.documents = [];
    this.docMap = {};
  }

  
  buildIndex() {
    const self = this;
    this.idx = lunr(function () {
      this.ref('ref');
      this.field('text');
      this.field('type');
      this.field('answer');

      const questions = self.graph.getQuestions();
      for (const q of questions) {
        self.documents.push({
          ref: q.id, text: q.full_text || q.label,
          type: 'question', answer: q.answer || '', node: q,
        });
        this.add({
          ref: q.id, text: q.full_text || q.label,
          type: 'question', answer: q.answer || '',
        });
      }

      const facts = self.graph.getNodesByType('fact');
      for (const f of facts) {
        self.documents.push({
          ref: f.id, text: f.full_text || f.label,
          type: 'fact', answer: '', node: f,
        });
        this.add({
          ref: f.id, text: f.full_text || f.label,
          type: 'fact', answer: '',
        });
      }

      const docs = self.graph.getNodesByType('document');
      for (const d of docs) {
        self.documents.push({
          ref: d.id,
          text: (d.title || '') + ' ' + (d.first_sentence || ''),
          type: 'document', answer: '', node: d,
        });
        this.add({
          ref: d.id,
          text: (d.title || '') + ' ' + (d.first_sentence || ''),
          type: 'document', answer: '',
        });
      }
    });

    for (const doc of this.documents) {
      this.docMap[doc.ref] = doc;
    }
    console.log(`Lunr 回退索引已构建：${this.documents.length} 个文档`);
  }

  
  async search(query, limit = 20) {

    try {
      const resp = await fetch(
        `${this.apiBase}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`
      );
      if (resp.ok) {
        const results = await resp.json();
        if (results && results.length > 0) {
          return results;
        }
      }
    } catch (err) {
      console.warn('API 搜索不可用，回退到 Lunr：', err.message);
    }

    return this._searchLocal(query, limit);
  }

  
  _searchLocal(query, limit) {
    if (!this.idx) return [];
    if (!query || query.trim().length < 2) return [];
    const results = this.idx.search(query.trim());
    return results.slice(0, limit).map(r => {
      const doc = this.docMap[r.ref];
      return {
        ref: r.ref, score: r.score,
        type: doc ? doc.type : 'unknown',
        node: doc ? doc.node : null,
        matchMetadata: r.matchData,
      };
    });
  }

  
  async searchQuestions(query, limit = 15) {

    try {
      const resp = await fetch(
        `${this.apiBase}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`
      );
      if (resp.ok) {
        const results = await resp.json();
        if (results && results.length > 0) {
          return results;
        }
      }
    } catch (_) {  }

    const results = this._searchLocal(query, 50);
    const questionResults = [];
    const seenQuestions = new Set();

    for (const r of results) {
      if (r.type === 'question' && !seenQuestions.has(r.ref)) {
        seenQuestions.add(r.ref);
        questionResults.push(r);
      }
      if (r.type === 'fact' || r.type === 'document') {
        const neighbors = this.graph.adjacency.get(r.ref) || [];
        for (const { target, edgeType } of neighbors) {
          const targetNode = this.graph.getNode(target);
          if (targetNode && targetNode.type === 'question' && !seenQuestions.has(target)) {
            seenQuestions.add(target);
            questionResults.push({
              ref: target, score: r.score * 0.5,
              type: 'question', node: targetNode,
              matchedVia: r.node ? (r.node.label || '').substring(0, 80) : '',
            });
          }
        }
      }
    }
    return questionResults.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

window.HotpotSearch = HotpotSearch;
