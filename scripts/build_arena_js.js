import fs from 'node:fs';

const cjsCode = fs.readFileSync('scripts/arena_models.cjs', 'utf8');
const windowExport = `
if (typeof window !== "undefined") {
  window.ARENA_CANONICAL_MODELS = ARENA_CANONICAL_MODELS;
  window.evaluatePredictionCorrectness = evaluatePredictionCorrectness;
  window.determineOptimalArenaInChargeModel = determineOptimalArenaInChargeModel;
  window.generateModelNextPrediction = generateModelNextPrediction;
}
`;

const finalCode = cjsCode.replace('if (typeof module !== "undefined" && module.exports) {', windowExport + '\nif (typeof module !== "undefined" && module.exports) {');
fs.writeFileSync('algorithms/arena_models.js', finalCode, 'utf8');
console.log('[build_arena_js] Wrote algorithms/arena_models.js successfully.');
