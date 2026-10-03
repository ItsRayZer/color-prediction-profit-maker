import { GameRound, GameColor, GameSize } from '../types/game';

export interface FeedSubscription {
  unsubscribe: () => void;
}

/**
 * WebSocket & Real-Time Simulation Adapter
 * Connects to live websocket endpoint if provided, or automatically simulates
 * live incoming rounds every 5 seconds (or specified interval).
 */
export class LiveFeedAdapter {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private isSimulating: boolean = false;
  private lastRoundId: number = 202609201000;
  private listeners: ((round: GameRound) => void)[] = [];

  constructor(private url?: string) {}

  /**
   * Starts listening to live data or simulation
   */
  start(onRound: (round: GameRound) => void, intervalMs: number = 5000): FeedSubscription {
    this.listeners.push(onRound);

    if (this.url) {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.roundId && data.size) {
              this.notify(data);
            }
          } catch {
            // fallback
          }
        };
        this.ws.onerror = () => {
          this.startSimulation(intervalMs);
        };
        this.ws.onclose = () => {
          this.startSimulation(intervalMs);
        };
      } catch {
        this.startSimulation(intervalMs);
      }
    } else {
      this.startSimulation(intervalMs);
    }

    return {
      unsubscribe: () => {
        this.stop();
        this.listeners = this.listeners.filter(l => l !== onRound);
      }
    };
  }

  private startSimulation(intervalMs: number) {
    if (this.isSimulating) return;
    this.isSimulating = true;

    this.timer = window.setInterval(() => {
      this.lastRoundId++;
      const roll = Math.random();
      let color: GameColor = 'green';
      let num = 7;

      if (roll < 0.10) {
        color = 'violet';
        num = Math.random() < 0.5 ? 0 : 5;
      } else if (roll < 0.55) {
        color = 'green';
        const greens = [1, 3, 7, 9];
        num = greens[Math.floor(Math.random() * greens.length)];
      } else {
        color = 'red';
        const reds = [2, 4, 6, 8];
        num = reds[Math.floor(Math.random() * reds.length)];
      }

      const size: GameSize = num >= 5 ? 'big' : 'small';
      const newRound: GameRound = {
        roundId: this.lastRoundId,
        timestamp: Date.now(),
        number: num,
        color,
        size
      };

      this.notify(newRound);
    }, intervalMs);
  }

  private notify(round: GameRound) {
    this.listeners.forEach(fn => fn(round));
  }

  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isSimulating = false;
  }
}
