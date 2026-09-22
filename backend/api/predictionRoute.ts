/**
 * Prediction API Route: GET /api/prediction
 * Implements Sections 42 & 55:
 * Strictly backward-compatible with existing consumers.
 * Returns active champion prediction and optional arena metadata.
 */

import { globalPredictionArena } from '../arena/predictionArena.ts';
import type { PredictionContext } from '../prediction/predictionTypes.ts';

export async function handleGetPrediction(query: Record<string, string>, history: any[] = []): Promise<any> {
  const roundId = query.roundId || `round_${Date.now()}`;
  const timeframe = query.timeframe || '30s';

  const context: PredictionContext = {
    roundId,
    timeframe,
    history: history.length > 0 ? history : [],
    lossStreak: parseInt(query.lossStreak || '0', 10),
    winStreak: parseInt(query.winStreak || '0', 10)
  };

  const arenaResponse = await globalPredictionArena.onNewRound(context);

  // Return payload: existing clients receive { prediction: 'BIG' } directly
  // and arena metadata is accessible for new clients.
  return {
    prediction: arenaResponse.prediction,
    target: arenaResponse.prediction,
    prob: arenaResponse.probabilities[arenaResponse.prediction] ?? 0.6,
    probabilities: arenaResponse.probabilities,
    confidence: arenaResponse.confidence,
    activeExpert: arenaResponse.activeExpert,
    metadata: arenaResponse.metadata
  };
}
