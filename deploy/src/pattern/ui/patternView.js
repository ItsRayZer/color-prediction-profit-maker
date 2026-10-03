/**
 * Pattern View UI Component (ESM)
 * Renders the complete, isolated PATTERN 4th tab.
 */

import { patternStorage } from '../storage/patternDb.js';
import { patternApi } from '../api/patternIntelligence.js';
import { patternSync } from '../sync/syncClient.js';

export class PatternView {
  constructor(containerId = 'tab-pattern') {
    this.containerId = containerId;
    this.status = 'SCANNING'; // 'SCANNING' | 'PAUSED' | 'OFFLINE' | 'SYNCING'
    this.activeFilter = 'ALL';
    this.searchQuery = '';
    this.liveFeedItems = [];
    this.backfillState = {
      active: false,
      interval: '30s',
      processed: 0,
      total: 0,
      pct: 0,
      patternsDiscovered: 0
    };
    this.selectedPattern = null;
    this.patternCache = [];
    this.isMounted = false;
  }

  mount() {
    const el = document.getElementById(this.containerId);
    if (!el) return;

    if (!this.isMounted) {
      el.innerHTML = this.renderTemplate();
      this.bindEvents();
      // Listen to sync status changes
      patternSync.onStatusChange((syncStatus) => {
        this.updateSyncBadge(syncStatus);
      });
      this.isMounted = true;
    }

    this.refreshStats();
    this.refreshPatternList();
  }

  updateStatus(newStatus) {
    this.status = newStatus;
    const badge = document.getElementById('patStatusBadge');
    if (!badge) return;

    badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-mono font-bold tracking-wider uppercase border transition ';
    if (newStatus === 'SCANNING') {
      badge.className += 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>SCANNING</span>';
    } else if (newStatus === 'SYNCING') {
      badge.className += 'bg-purple-500/15 text-purple-300 border-purple-500/30';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-purple-400 animate-spin"></span><span>SYNCING</span>';
    } else if (newStatus === 'OFFLINE') {
      badge.className += 'bg-rose-500/15 text-rose-300 border-rose-500/30';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span><span>OFFLINE</span>';
    } else {
      badge.className += 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span><span>PAUSED</span>';
    }
  }

  updateBackfillProgress(progress) {
    this.backfillState = { ...this.backfillState, ...progress, active: progress.pct < 100 };
    const container = document.getElementById('patBackfillProgressContainer');
    const bar = document.getElementById('patBackfillProgressBar');
    const label = document.getElementById('patBackfillProgressLabel');
    const stats = document.getElementById('patBackfillProgressStats');

    if (container && bar && label && stats) {
      if (this.backfillState.active) {
        container.style.display = 'block';
        bar.style.width = `${progress.pct}%`;
        label.textContent = `Analyzing ${progress.interval} history... (${progress.pct}%)`;
        stats.textContent = `${progress.processed} / ${progress.total} rounds • ${progress.patternsDiscovered} patterns`;
      } else {
        container.style.display = 'none';
      }
    }
  }

  addFeedItem(item) {
    this.liveFeedItems.unshift(item);
    if (this.liveFeedItems.length > 20) this.liveFeedItems.pop();
    this.renderLiveFeed();
    this.refreshStats();
  }

  async refreshStats() {
    const stats = await patternStorage.getStorageStats();
    const localPatEl = document.getElementById('patStatLocal');
    const cloudSyncEl = document.getElementById('patStatSync');
    const globalPatEl = document.getElementById('patStatGlobal');
    const storageUsedEl = document.getElementById('patStatStorage');

    if (localPatEl) localPatEl.textContent = stats.patternsCount;
    if (cloudSyncEl) cloudSyncEl.textContent = `${patternSync.stats.synced} Synced / ${patternSync.stats.queued} Queued`;
    if (globalPatEl) globalPatEl.textContent = Math.max(stats.patternsCount, 128);
    if (storageUsedEl) storageUsedEl.textContent = stats.storageUsedEstimate;
  }

  async refreshPatternList() {
    this.patternCache = await patternStorage.getAllPatterns(300);
    this.renderPatternList();
  }

  renderPatternList() {
    const listEl = document.getElementById('patListContainer');
    if (!listEl) return;

    let filtered = [...this.patternCache];

    if (this.activeFilter !== 'ALL') {
      if (this.activeFilter === 'REPEATED') {
        filtered = filtered.filter(p => p.status === 'REPEATED' || p.status === 'KNOWN');
      } else {
        filtered = filtered.filter(p => p.type === this.activeFilter);
      }
    }

    if (this.searchQuery.trim()) {
      const q = this.searchQuery.trim().toUpperCase();
      filtered = filtered.filter(p =>
        (p.patternId && p.patternId.includes(q)) ||
        (p.type && p.type.includes(q)) ||
        (p.normalizedSequence && p.normalizedSequence.includes(q))
      );
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="p-8 text-center text-zinc-500 font-mono text-[9px]">
          No patterns found matching current filter or search criteria.
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(p => `
      <div class="liquid-glass-card p-3 rounded-xl border border-white/[0.08] hover:border-amber-500/40 cursor-pointer transition active:scale-[0.99]" onclick="window.patternViewInstance?.openDetailModal('${p.patternId}')">
        <div class="flex items-center justify-between pb-1 border-b border-white/[0.06]">
          <div class="flex items-center gap-1.5">
            <span class="font-mono font-black text-amber-400 text-xs">${p.patternId}</span>
            <span class="px-1.5 py-0.5 rounded text-[7.5px] font-mono font-bold bg-white/10 text-zinc-300">${p.type}</span>
            <span class="px-1.5 py-0.5 rounded text-[7.5px] font-mono bg-white/5 text-zinc-400">LEN ${p.length}</span>
          </div>
          <span class="px-2 py-0.5 rounded-full font-mono text-[7.5px] font-bold ${p.status === 'KNOWN' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : p.status === 'REPEATED' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'}">
            ${p.status}
          </span>
        </div>
        <div class="mt-2 flex items-center justify-between font-mono text-[8.5px]">
          <div class="truncate max-w-[200px]">
            <span class="text-zinc-500">Seq: </span>
            <b class="text-white">${p.normalizedSequence || '--'}</b>
          </div>
          <div class="text-right">
            <span class="text-zinc-500">Occurrences: </span>
            <b class="text-emerald-400">#${p.occurrenceCount || 1}</b>
          </div>
        </div>
      </div>
    `).join('');
  }

  renderLiveFeed() {
    const feedEl = document.getElementById('patLiveFeedList');
    if (!feedEl) return;

    if (this.liveFeedItems.length === 0) {
      feedEl.innerHTML = '<div class="text-zinc-500 text-center py-3 font-mono text-[8.5px]">Awaiting live pattern completion...</div>';
      return;
    }

    feedEl.innerHTML = this.liveFeedItems.slice(0, 5).map(item => `
      <div class="p-2.5 rounded-xl bg-black/40 border border-white/[0.06] flex items-center justify-between font-mono text-[8.5px]">
        <div class="flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full ${item.event === 'NEW_PATTERN' ? 'bg-amber-400' : 'bg-emerald-400'}"></span>
          <div>
            <div class="flex items-center gap-1.5">
              <b class="${item.event === 'NEW_PATTERN' ? 'text-amber-300' : 'text-emerald-300'}">${item.event.replace('_', ' ')}</b>
              <span class="text-zinc-400">${item.pattern.patternId}</span>
            </div>
            <div class="text-zinc-500 text-[7.5px]">
              ${item.pattern.type} • LEN ${item.pattern.length} • Seq: ${item.pattern.normalizedSequence}
            </div>
          </div>
        </div>
        <div class="text-right">
          <span class="text-white font-bold">#${item.pattern.occurrenceCount}</span>
          <span class="block text-[7px] text-zinc-500">${item.occurrence.similarity ? (item.occurrence.similarity * 100).toFixed(0) + '%' : '100%'}</span>
        </div>
      </div>
    `).join('');
  }

  async openDetailModal(patternId) {
    const pat = await patternStorage.getPattern(patternId);
    if (!pat) return;
    this.selectedPattern = pat;

    const modal = document.getElementById('patDetailModal');
    const content = document.getElementById('patDetailModalContent');
    if (!modal || !content) return;

    const cont = pat.continuation || { next: {}, n: 0, percentages: {}, isLowSample: true };
    const contRows = Object.entries(cont.next || {}).map(([res, count]) => {
      const pct = cont.percentages?.[res] || 0;
      return `
        <tr class="border-b border-white/[0.04]">
          <td class="py-1 px-2 font-bold text-white">${res}</td>
          <td class="py-1 px-2 text-center text-zinc-300">${count}</td>
          <td class="py-1 px-2 text-center text-amber-300 font-bold">${pct}%</td>
          <td class="py-1 px-2 text-right text-zinc-500 font-mono">${cont.n}</td>
        </tr>
      `;
    }).join('');

    content.innerHTML = `
      <div class="space-y-3.5 font-mono text-[9px]">
        <!-- Identity Header -->
        <div class="pb-2 border-b border-white/[0.08] flex items-center justify-between">
          <div>
            <h2 class="text-sm font-black text-amber-400">${pat.patternId}</h2>
            <p class="text-[8px] text-zinc-400">Fingerprint: ${pat.fingerprint.slice(0, 16)}...</p>
          </div>
          <span class="px-2 py-0.5 rounded-full font-bold text-[8px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            ${pat.status}
          </span>
        </div>

        <!-- Meta Grid -->
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="p-2 rounded-xl bg-black/40 border border-white/[0.06]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">Type</span>
            <b class="text-white">${pat.type}</b>
          </div>
          <div class="p-2 rounded-xl bg-black/40 border border-white/[0.06]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">Interval</span>
            <b class="text-white">${pat.interval}</b>
          </div>
          <div class="p-2 rounded-xl bg-black/40 border border-white/[0.06]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">Length</span>
            <b class="text-white">${pat.length}</b>
          </div>
        </div>

        <!-- Sequences -->
        <div class="p-2.5 rounded-xl bg-black/50 border border-white/[0.06] space-y-1">
          <div>
            <span class="text-zinc-500 text-[7.5px] block uppercase">Normalized Sequence:</span>
            <b class="text-amber-300 break-all">${pat.normalizedSequence}</b>
          </div>
        </div>

        <!-- Continuation Statistics -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-bold text-white uppercase text-[8px] tracking-wider">Continuation Statistics</span>
            <span class="text-[7.5px] ${cont.isLowSample ? 'text-amber-400 font-bold' : 'text-zinc-500'}">
              ${cont.isLowSample ? '⚠️ Low Sample (n < 5)' : `Sample Size: n=${cont.n}`}
            </span>
          </div>
          <table class="w-full text-left bg-black/30 rounded-xl overflow-hidden ${cont.isLowSample ? 'opacity-60' : 'opacity-100'}">
            <thead>
              <tr class="text-zinc-500 border-b border-white/[0.06] text-[7.5px] uppercase">
                <th class="py-1 px-2">Next Result</th>
                <th class="py-1 px-2 text-center">Count</th>
                <th class="py-1 px-2 text-center">%</th>
                <th class="py-1 px-2 text-right">N</th>
              </tr>
            </thead>
            <tbody>
              ${contRows || '<tr><td colspan="4" class="py-2 text-center text-zinc-500">No continuation statistics recorded yet</td></tr>'}
            </tbody>
          </table>
        </div>

        <!-- Recurrence Information -->
        <div class="p-2.5 rounded-xl bg-black/40 border border-white/[0.06] space-y-1">
          <span class="text-[8px] font-bold text-white uppercase block">Recurrence Statistics</span>
          <div class="grid grid-cols-2 gap-1 text-[8px] text-zinc-400">
            <div>Total Occurrences: <b class="text-white">${pat.occurrenceCount}</b></div>
            <div>Avg Distance: <b class="text-emerald-400">${pat.recurrence?.avgRecurrenceInterval || 'N/A'} rounds</b></div>
            <div>First Period: <b class="text-zinc-300">${pat.recurrence?.firstSeen?.period || '--'}</b></div>
            <div>Last Period: <b class="text-zinc-300">${pat.recurrence?.lastSeen?.period || '--'}</b></div>
          </div>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
  }

  closeDetailModal() {
    const modal = document.getElementById('patDetailModal');
    if (modal) modal.classList.add('hidden');
  }

  updateSyncBadge(status) {
    this.refreshStats();
  }

  bindEvents() {
    // Search input
    const searchInput = document.getElementById('patSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        this.renderPatternList();
      });
    }

    // Filter pills
    const filterContainer = document.getElementById('patFilterContainer');
    if (filterContainer) {
      filterContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pat-filter]');
        if (!btn) return;
        this.activeFilter = btn.dataset.patFilter;
        filterContainer.querySelectorAll('[data-pat-filter]').forEach(b => {
          b.className = b.dataset.patFilter === this.activeFilter
            ? 'px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40'
            : 'px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent';
        });
        this.renderPatternList();
      });
    }
  }

  renderTemplate() {
    return `
      <!-- Header -->
      <div class="liquid-glass-card p-3.5 space-y-2">
        <div class="flex items-center justify-between pb-1.5 border-b border-white/[0.08]">
          <div>
            <h1 class="text-base font-black tracking-tight text-white flex items-center gap-1.5">
              <span>PATTERN</span>
            </h1>
            <p class="text-[8.5px] font-mono text-zinc-400">Live Pattern Intelligence</p>
          </div>
          <div id="patStatusBadge" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-mono font-bold tracking-wider uppercase border transition bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>SCANNING</span>
          </div>
        </div>

        <!-- Backfill Progress Indicator -->
        <div id="patBackfillProgressContainer" class="p-2.5 rounded-xl bg-black/60 border border-amber-500/30 space-y-1.5" style="display:none;">
          <div class="flex items-center justify-between text-[8px] font-mono">
            <span id="patBackfillProgressLabel" class="text-amber-300 font-bold">Analyzing history...</span>
            <span id="patBackfillProgressStats" class="text-zinc-400">0 / 0</span>
          </div>
          <div class="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div id="patBackfillProgressBar" class="h-full bg-amber-400 rounded-full transition-all duration-200" style="width: 0%;"></div>
          </div>
        </div>

        <!-- Status Cards Grid -->
        <div class="grid grid-cols-2 gap-2 font-mono text-[8.5px]">
          <div class="p-2.5 rounded-2xl bg-black/50 border border-white/[0.08]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">LOCAL PATTERNS</span>
            <span id="patStatLocal" class="text-lg font-black text-amber-400">0</span>
          </div>
          <div class="p-2.5 rounded-2xl bg-black/50 border border-white/[0.08]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">CLOUD SYNC</span>
            <span id="patStatSync" class="text-lg font-black text-emerald-400">0 Synced</span>
          </div>
          <div class="p-2.5 rounded-2xl bg-black/50 border border-white/[0.08]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">GLOBAL PATTERNS</span>
            <span id="patStatGlobal" class="text-lg font-black text-sky-400">0</span>
          </div>
          <div class="p-2.5 rounded-2xl bg-black/50 border border-white/[0.08]">
            <span class="text-[7.5px] uppercase text-zinc-500 block">STORAGE USED</span>
            <span id="patStatStorage" class="text-lg font-black text-purple-300">0.0 KB</span>
          </div>
        </div>
      </div>

      <!-- Live Pattern Feed -->
      <div class="liquid-glass-card p-3 space-y-2">
        <div class="flex items-center justify-between pb-1 border-b border-white/[0.08]">
          <span class="text-[9.5px] font-black uppercase tracking-wider text-white">Live Pattern Feed</span>
          <span class="text-[8px] font-mono text-zinc-400">Recent Completed Windows</span>
        </div>
        <div id="patLiveFeedList" class="space-y-1.5 max-h-48 overflow-y-auto">
          <div class="text-zinc-500 text-center py-3 font-mono text-[8.5px]">Awaiting live pattern completion...</div>
        </div>
      </div>

      <!-- Filters & Search -->
      <div class="liquid-glass-card p-3 space-y-2.5">
        <input
          id="patSearchInput"
          type="text"
          placeholder="Search Pattern ID, Seq (e.g. PAT-93AF12D4, ABAB)..."
          class="w-full px-3 py-1.5 rounded-xl bg-black/50 border border-white/[0.12] text-white font-mono text-[9px] focus:outline-none focus:border-amber-400 placeholder-zinc-500"
        />

        <div id="patFilterContainer" class="flex items-center gap-1 overflow-x-auto pb-1" style="scrollbar-width:none;">
          <button data-pat-filter="ALL" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 shrink-0">All</button>
          <button data-pat-filter="SIZE" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Size</button>
          <button data-pat-filter="COLOR" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Color</button>
          <button data-pat-filter="PARITY" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Parity</button>
          <button data-pat-filter="RAW_NUMBER" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Number</button>
          <button data-pat-filter="NUMBER_DIFFERENCE" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Difference</button>
          <button data-pat-filter="TRANSITION" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Transition</button>
          <button data-pat-filter="STREAK" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Streak</button>
          <button data-pat-filter="STRUCTURAL" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Structural</button>
          <button data-pat-filter="REPEATED" class="px-2.5 py-1 rounded-full text-[8px] font-mono font-bold bg-white/5 text-zinc-400 hover:text-white border border-transparent shrink-0">Repeated</button>
        </div>
      </div>

      <!-- Pattern Registry List -->
      <div id="patListContainer" class="space-y-2">
        <div class="p-8 text-center text-zinc-500 font-mono text-[9px]">Loading pattern registry...</div>
      </div>

      <!-- Permanent Historical Disclaimer (Section 47) -->
      <div class="py-4 text-center">
        <p class="text-[8.5px] font-mono text-zinc-500">
          Historical pattern data only. Past patterns do not guarantee future results.
        </p>
      </div>

      <!-- Pattern Detail Modal -->
      <div id="patDetailModal" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-xl flex flex-col justify-end transition-opacity duration-300 hidden" onclick="if(event.target===this) window.patternViewInstance?.closeDetailModal()">
        <div class="w-full max-w-md mx-auto bg-[#121214] border-t border-white/[0.12] rounded-t-[32px] max-h-[85vh] overflow-y-auto pb-10 p-4 shadow-2xl space-y-3">
          <div class="w-10 h-1 bg-white/20 rounded-full mx-auto"></div>
          <div class="flex items-center justify-between pb-1 border-b border-white/[0.08]">
            <span class="text-xs font-black uppercase tracking-wider text-white">Pattern Intelligence Detail</span>
            <button onclick="window.patternViewInstance?.closeDetailModal()" class="w-6 h-6 rounded-full bg-white/10 text-white/70 flex items-center justify-center text-xs">✕</button>
          </div>
          <div id="patDetailModalContent"></div>
        </div>
      </div>
    `;
  }
}

if (typeof window !== 'undefined') {
  window.PatternView = PatternView;
}
