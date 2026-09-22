/**
 * TIME_TRAVELLER Historical Replay Engine
 * Implements Section 23:
 * State encoding, historical similarity matching, and candidate replay trajectories.
 */

import type { RoundResult } from '../prediction/predictionTypes.ts';

export interface TrajectoryReplayMatch {
  matchedIndex: number;
  similarity: number;
  historicalSequence: RoundResult[];
  subsequentOutcomes: RoundResult[];
  nextOutcome: 'BIG' | 'SMALL';
}

export interface TimeTravellerEvidence {
  probBig: number;
  probSmall: number;
  confidence: number;
  matchesCount: number;
  topTrajectories: TrajectoryReplayMatch[];
}

export class TimeTraveller {
  public replay(history: RoundResult[], queryWindow = 4, lookahead = 3): TimeTravellerEvidence {
    if (history.length < queryWindow + lookahead + 5) {
      return {
        probBig: 0.5,
        probSmall: 0.5,
        confidence: 0.5,
        matchesCount: 0,
        topTrajectories: []
      };
    }

    const query = history.slice(-queryWindow);
    const matches: TrajectoryReplayMatch[] = [];

    // Search historical memory (excluding current query window)
    const searchLimit = history.length - queryWindow - lookahead;
    for (let i = 0; i <= searchLimit; i++) {
      let simScore = 0;
      for (let j = 0; j < queryWindow; j++) {
        if (history[i + j].size === query[j].size) simScore += 0.5;
        if (history[i + j].number === query[j].number) simScore += 0.5;
      }
      const normSim = simScore / queryWindow;

      if (normSim >= 0.6) {
        matches.push({
          matchedIndex: i,
          similarity: Number(normSim.toFixed(3)),
          historicalSequence: history.slice(i, i + queryWindow),
          subsequentOutcomes: history.slice(i + queryWindow, i + queryWindow + lookahead),
          nextOutcome: history[i + queryWindow].size
        });
      }
    }

    // Sort by similarity descending
    matches.sort((a, b) => b.similarity - a.similarity);
    const topMatches = matches.slice(0, 10);

    let weightedBig = 0;
    let totalWeight = 0;

    for (const m of topMatches) {
      const w = Math.pow(m.similarity, 2);
      totalWeight += w;
      if (m.nextOutcome === 'BIG') weightedBig += w;
    }

    const probBig = totalWeight > 0 ? weightedBig / totalWeight : 0.5;
    const probSmall = Number((1.0 - probBig).toFixed(4));
    const confidence = Number(Math.max(probBig, probSmall).toFixed(4));

    return {
      probBig: Number(probBig.toFixed(4)),
      probSmall,
      confidence,
      matchesCount: matches.length,
      topTrajectories: topMatches
    };
  }
}

export const globalTimeTraveller = new TimeTraveller();
