/**
 * Cloud Engine Master Service Entry Point
 * ========================================
 * Boots:
 * 1. CloudDatabase (Permanent SQLite storage with WAL)
 * 2. ModelRegistry (53+ Canonical Models)
 * 3. DualInchargeController (Session Incharge A vs Service Incharge B)
 * 4. RebuildEngine (Historical replay)
 * 5. IngestionService (24/7 background polling & processing)
 * 6. CloudServer (REST API, SSE Realtime, and Thin Client feeds)
 */

import { CloudDatabase } from './database.js';
import { globalModelRegistry } from './modelRegistry.js';
import { DualInchargeController } from './dualInchargeController.js';
import { RebuildEngine } from './rebuildEngine.js';
import { IngestionService } from './ingestionService.js';
import { CloudServer } from './cloudServer.js';

export async function bootstrapCloudPlatform(options = {}) {
  const dbPath = options.dbPath || 'data/prediction_cloud.db';
  const port = options.port || 3001;

  console.log('========================================================');
  console.log('🌌 24/7 Universal Cloud Prediction Platform (53+ Models)');
  console.log(`Database: ${dbPath}`);
  console.log(`API & Realtime Port: ${port}`);
  console.log('========================================================');

  const db = new CloudDatabase(dbPath);

  // Register canonical models in DB
  const canonicalModels = globalModelRegistry.getAllModelDefinitions();
  for (const m of canonicalModels) {
    db.registerModel(m);
  }
  console.log(`[CloudPlatform] Registered ${canonicalModels.length} models in permanent catalog.`);

  const inchargeController = new DualInchargeController(db);
  const rebuildEngine = new RebuildEngine(db, globalModelRegistry);
  const ingestionService = new IngestionService(db, globalModelRegistry, inchargeController, options);
  const cloudServer = new CloudServer(db, globalModelRegistry, inchargeController, ingestionService, rebuildEngine, { port });

  await cloudServer.start();
  await ingestionService.start();

  return {
    db,
    modelRegistry: globalModelRegistry,
    inchargeController,
    rebuildEngine,
    ingestionService,
    cloudServer
  };
}

// Start immediately if executed directly
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  bootstrapCloudPlatform().catch(err => {
    console.error('[CloudPlatform] Fatal Startup Error:', err);
    process.exit(1);
  });
}
