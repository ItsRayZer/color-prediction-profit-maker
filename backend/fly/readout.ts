/**
 * Trainable Regularized Readout Layer for Fly Brain Reservoir
 */

export class ReadoutLayer {
  public readonly inputDim: number;
  public weights: Float32Array; // (inputDim) weights for BIG logit
  public bias: number;
  public learningRate: number;
  public l2Penalty: number;

  constructor(inputDim: number, learningRate = 0.02, l2Penalty = 0.01) {
    this.inputDim = inputDim;
    this.weights = new Float32Array(inputDim);
    this.bias = 0.0;
    this.learningRate = learningRate;
    this.l2Penalty = l2Penalty;

    // Small random initialization
    for (let i = 0; i < inputDim; i++) {
      this.weights[i] = (Math.random() - 0.5) * 0.05;
    }
  }

  public predictRaw(reservoirState: Float32Array): number {
    let dot = this.bias;
    const len = Math.min(reservoirState.length, this.inputDim);
    for (let i = 0; i < len; i++) {
      dot += reservoirState[i] * this.weights[i];
    }
    return dot;
  }

  public predictProbability(reservoirState: Float32Array): number {
    const logit = this.predictRaw(reservoirState);
    return 1 / (1 + Math.exp(-Math.max(-15, Math.min(15, logit))));
  }

  public update(reservoirState: Float32Array, target: 1 | 0): number {
    const prob = this.predictProbability(reservoirState);
    const error = target - prob; // Gradient of log-loss w.r.t logit is -(target - prob)

    const len = Math.min(reservoirState.length, this.inputDim);
    for (let i = 0; i < len; i++) {
      // Weight update: w <- w + lr * (error * x - l2 * w)
      const grad = error * reservoirState[i] - this.l2Penalty * this.weights[i];
      this.weights[i] += this.learningRate * grad;
    }
    this.bias += this.learningRate * error;

    return Math.abs(error);
  }
}
