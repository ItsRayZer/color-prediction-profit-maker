/**
 * Probability Calibrator for Fly Reservoir Predictions
 * Implements Platt Scaling / Temperature Scaling
 */

export class ProbabilityCalibrator {
  private temperature: number = 1.0;
  private plattA: number = 1.0;
  private plattB: number = 0.0;

  public calibrate(rawProb: number): number {
    // Platt transform: logit -> scale -> sigmoid
    const p = Math.max(0.001, Math.min(0.999, rawProb));
    const logit = Math.log(p / (1 - p));
    const calibratedLogit = (this.plattA * logit + this.plattB) / this.temperature;
    const calibratedProb = 1 / (1 + Math.exp(-calibratedLogit));
    return Number(Math.max(0.01, Math.min(0.99, calibratedProb)).toFixed(4));
  }

  public updateCalibration(observations: Array<{ predicted: number; actual: 1 | 0 }>): void {
    if (observations.length < 20) return;

    // Estimate Brier score before and tune temperature towards minimum Brier
    let bestTemp = this.temperature;
    let minBrier = Infinity;

    for (let t = 0.7; t <= 1.5; t += 0.1) {
      let brier = 0;
      for (const obs of observations) {
        const p = Math.max(0.001, Math.min(0.999, obs.predicted));
        const logit = Math.log(p / (1 - p));
        const calP = 1 / (1 + Math.exp(-logit / t));
        brier += Math.pow(calP - obs.actual, 2);
      }
      if (brier < minBrier) {
        minBrier = brier;
        bestTemp = t;
      }
    }

    this.temperature = bestTemp;
  }
}
