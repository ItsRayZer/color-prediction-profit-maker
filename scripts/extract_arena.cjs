const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');

// Extract ARENA_CANONICAL_MODELS
const startModels = content.indexOf('const ARENA_CANONICAL_MODELS = [');
const endModels = content.indexOf('];\n\nlet lastLiveArenaRanking', startModels) + 2;
const modelsCode = content.slice(startModels, endModels);

// Extract determineOptimalArenaInChargeModel
const startOpt = content.indexOf('function determineOptimalArenaInChargeModel(');
const endOpt = content.indexOf('// Retrieve active in-charge algorithm', startOpt);
const optCode = content.slice(startOpt, endOpt);

// Extract generateModelNextPrediction
const startPred = content.indexOf('function generateModelNextPrediction(');
const endPred = content.indexOf('\n}\n\nfunction evaluateArenaModelsOnSettledRound(', startPred) + 2;
const predCode = content.slice(startPred, endPred);

// Extract evaluatePredictionCorrectness
const startEval = content.indexOf('function evaluatePredictionCorrectness(');
const endEval = content.indexOf('\n}\n\nif (typeof window !==', startEval) + 2;
const evalCode = content.slice(startEval, endEval);

const fullModule = [
  '// Auto-extracted Canonical Arena Models and Algorithms for Server-Side Execution',
  modelsCode,
  '',
  evalCode,
  '',
  optCode,
  '',
  predCode,
  '',
  'if (typeof module !== "undefined" && module.exports) {',
  '  module.exports = {',
  '    ARENA_CANONICAL_MODELS,',
  '    evaluatePredictionCorrectness,',
  '    determineOptimalArenaInChargeModel,',
  '    generateModelNextPrediction',
  '  };',
  '}'
].join('\n');

fs.writeFileSync('scripts/arena_models.cjs', fullModule, 'utf8');
console.log('Successfully generated scripts/arena_models.cjs. Size:', fullModule.length);
