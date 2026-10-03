/**
 * Isolated IndexedDB Storage Layer for Pattern Intelligence
 * Database: PatternIntelligenceDB
 * Version: 1
 */

export const DB_NAME = 'PatternIntelligenceDB';
export const DB_VERSION = 1;
export const ENGINE_VERSION = '1.0.0';

export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_DETAILED_OCCURRENCES_PER_PATTERN = 500;

class MemoryStore {
  constructor(keyPath = 'id', autoIncrement = false) {
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    this.data = new Map();
    this.nextId = 1;
  }

  put(item) {
    let key;
    if (this.autoIncrement) {
      if (!item[this.keyPath]) {
        item[this.keyPath] = this.nextId++;
      }
      key = item[this.keyPath];
    } else {
      key = item[this.keyPath];
    }
    this.data.set(key, JSON.parse(JSON.stringify(item)));
    return Promise.resolve(key);
  }

  get(key) {
    const val = this.data.get(key);
    return Promise.resolve(val ? JSON.parse(JSON.stringify(val)) : null);
  }

  getAll() {
    return Promise.resolve(Array.from(this.data.values()).map(v => JSON.parse(JSON.stringify(v))));
  }

  delete(key) {
    this.data.delete(key);
    return Promise.resolve();
  }

  count() {
    return Promise.resolve(this.data.size);
  }

  clear() {
    this.data.clear();
    return Promise.resolve();
  }
}

class InvertedMemoryDb {
  constructor() {
    this.stores = {
      patterns: new MemoryStore('patternId', false),
      occurrences: new MemoryStore('id', true),
      modelSnapshots: new MemoryStore('id', true),
      syncQueue: new MemoryStore('id', true),
      meta: new MemoryStore('key', false)
    };
  }

  async init() {
    await this.stores.meta.put({ key: 'schemaVersion', value: DB_VERSION });
    await this.stores.meta.put({ key: 'engineVersion', value: ENGINE_VERSION });
    return this;
  }
}

class BrowserIndexedDb {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this;
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Patterns store
        if (!db.objectStoreNames.contains('patterns')) {
          const store = db.createObjectStore('patterns', { keyPath: 'patternId' });
          store.createIndex('fingerprint', 'fingerprint', { unique: true });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('interval', 'interval', { unique: false });
          store.createIndex('length', 'length', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }

        // 2. Occurrences store
        if (!db.objectStoreNames.contains('occurrences')) {
          const store = db.createObjectStore('occurrences', { keyPath: 'id', autoIncrement: true });
          store.createIndex('patternId', 'patternId', { unique: false });
          store.createIndex('period', 'period', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('interval', 'interval', { unique: false });
        }

        // 3. Model Snapshots store
        if (!db.objectStoreNames.contains('modelSnapshots')) {
          const store = db.createObjectStore('modelSnapshots', { keyPath: 'id', autoIncrement: true });
          store.createIndex('patternId', 'patternId', { unique: false });
          store.createIndex('modelId', 'modelId', { unique: false });
          store.createIndex('period', 'period', { unique: false });
        }

        // 4. Sync Queue store
        if (!db.objectStoreNames.contains('syncQueue')) {
          const store = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('retryAt', 'retryAt', { unique: false });
        }

        // 5. Meta store
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  _tx(storeNames, mode = 'readonly') {
    return this.db.transaction(storeNames, mode);
  }

  put(storeName, item) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getAll(storeName, query = null, count = 1000) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = query ? store.getAll(query, count) : store.getAll(null, count);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  count(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

export class PatternStorageManager {
  constructor() {
    this.driver = (typeof indexedDB !== 'undefined') ? new BrowserIndexedDb() : new InvertedMemoryDb();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    try {
      await this.driver.init();
    } catch (err) {
      console.warn('[PatternStorage] IndexedDB initialization failed, falling back to InvertedMemoryDb:', err);
      this.driver = new InvertedMemoryDb();
      await this.driver.init();
    }
    this.initialized = true;
  }

  async savePattern(pattern) {
    await this.init();
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.put('patterns', pattern);
    }
    return this.driver.stores.patterns.put(pattern);
  }

  async getPattern(patternId) {
    await this.init();
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.get('patterns', patternId);
    }
    return this.driver.stores.patterns.get(patternId);
  }

  async getAllPatterns(limit = 1000) {
    await this.init();
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.getAll('patterns', null, limit);
    }
    const all = await this.driver.stores.patterns.getAll();
    return all.slice(0, limit);
  }

  async saveOccurrence(occurrence) {
    await this.init();
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.put('occurrences', occurrence);
    }
    return this.driver.stores.occurrences.put(occurrence);
  }

  async getOccurrencesByPattern(patternId, page = 1, pageSize = 20) {
    await this.init();
    let all = [];
    if (this.driver instanceof BrowserIndexedDb) {
      all = await this.driver.getAll('occurrences');
    } else {
      all = await this.driver.stores.occurrences.getAll();
    }
    const filtered = all.filter(o => o.patternId === patternId);
    const start = (page - 1) * pageSize;
    return {
      occurrences: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize
    };
  }

  async enqueueSyncDelta(delta) {
    await this.init();
    const item = {
      ...delta,
      status: 'QUEUED',
      createdAt: Date.now(),
      retryCount: 0
    };
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.put('syncQueue', item);
    }
    return this.driver.stores.syncQueue.put(item);
  }

  async getQueuedSyncItems() {
    await this.init();
    let all = [];
    if (this.driver instanceof BrowserIndexedDb) {
      all = await this.driver.getAll('syncQueue');
    } else {
      all = await this.driver.stores.syncQueue.getAll();
    }
    return all.filter(i => i.status === 'QUEUED');
  }

  async saveModelSnapshot(snapshot) {
    await this.init();
    if (this.driver instanceof BrowserIndexedDb) {
      return this.driver.put('modelSnapshots', snapshot);
    }
    return this.driver.stores.modelSnapshots.put(snapshot);
  }

  async getModelSnapshots(patternId, modelId = null) {
    await this.init();
    let all = [];
    if (this.driver instanceof BrowserIndexedDb) {
      all = await this.driver.getAll('modelSnapshots');
    } else {
      all = await this.driver.stores.modelSnapshots.getAll();
    }
    return all.filter(s => s.patternId === patternId && (!modelId || s.modelId === modelId));
  }

  async getStorageStats() {
    await this.init();
    let patCount = 0;
    let occCount = 0;
    let queueCount = 0;

    if (this.driver instanceof BrowserIndexedDb) {
      patCount = await this.driver.count('patterns');
      occCount = await this.driver.count('occurrences');
      queueCount = await this.driver.count('syncQueue');
    } else {
      patCount = await this.driver.stores.patterns.count();
      occCount = await this.driver.stores.occurrences.count();
      queueCount = await this.driver.stores.syncQueue.count();
    }

    return {
      patternsCount: patCount,
      occurrencesCount: occCount,
      queuedSyncCount: queueCount,
      dbName: DB_NAME,
      version: DB_VERSION,
      storageUsedEstimate: `${((patCount * 250 + occCount * 150) / 1024).toFixed(1)} KB`
    };
  }
}

export const patternStorage = new PatternStorageManager();

if (typeof globalThis !== 'undefined') {
  globalThis.PatternStorage = {
    DB_NAME,
    DB_VERSION,
    PatternStorageManager,
    patternStorage
  };
}
