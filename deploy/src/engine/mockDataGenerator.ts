import { GameRound, GameColor, GameSize } from '../types/game';

/**
 * Generates realistic mock rounds for WinGo / Color Prediction game.
 *
 * Rules:
 * - Red: ~45%
 * - Green: ~45%
 * - Violet: ~10% (balls 0 and 5)
 * - Small: balls 0, 1, 2, 3, 4
 * - Big: balls 5, 6, 7, 8, 9
 * - Valid connected timestamps at step intervals (e.g. 30s)
 */
export function generateMockRounds(count: number = 1000, stepSeconds: number = 30): GameRound[] {
  const rounds: GameRound[] = [];
  const now = Date.now();
  const startTime = now - (count * stepSeconds * 1000);

  // Ball number mapping
  // 0: violet (small)
  // 5: violet (big)
  // 1, 3, 7, 9: green (1,3 small; 7,9 big)
  // 2, 4, 6, 8: red (2,4 small; 6,8 big)

  const redBalls = [2, 4, 6, 8];
  const greenBalls = [1, 3, 7, 9];

  let currentRoundId = 202609010000;

  for (let i = 0; i < count; i++) {
    const timestamp = startTime + (i * stepSeconds * 1000);
    currentRoundId++;

    const roll = Math.random();
    let color: GameColor;
    let ballNumber: number;

    if (roll < 0.10) {
      // 10% Violet (0 or 5)
      color = 'violet';
      ballNumber = Math.random() < 0.5 ? 0 : 5;
    } else if (roll < 0.55) {
      // 45% Green
      color = 'green';
      ballNumber = greenBalls[Math.floor(Math.random() * greenBalls.length)];
    } else {
      // 45% Red
      color = 'red';
      ballNumber = redBalls[Math.floor(Math.random() * redBalls.length)];
    }

    const size: GameSize = ballNumber >= 5 ? 'big' : 'small';

    rounds.push({
      roundId: currentRoundId,
      timestamp,
      number: ballNumber,
      color,
      size
    });
  }

  return rounds;
}

/**
 * Parses user manual entry format:
 * One result per line:
 * red-big
 * green-small
 * violet-big
 * red-small
 * or with ball number:
 * 7 green big
 * 3 red small
 */
export function parseManualInput(text: string, baseTimestamp: number = Date.now()): GameRound[] {
  const lines = text.split('\n').map(l => l.trim().toLowerCase()).filter(l => l.length > 0);
  const rounds: GameRound[] = [];

  let roundId = 202609200001;
  const stepSeconds = 30;

  lines.forEach((line, index) => {
    const timestamp = baseTimestamp + (index * stepSeconds * 1000);

    let color: GameColor = 'green';
    let size: GameSize = 'big';
    let ballNumber = 7;

    // Detect format: e.g. "red-big", "green-small", "violet-big"
    const isRed = line.includes('red');
    const isGreen = line.includes('green');
    const isViolet = line.includes('violet') || line.includes('purple');

    if (isViolet) color = 'violet';
    else if (isRed) color = 'red';
    else color = 'green';

    const isSmall = line.includes('small') || line.includes('sml');
    size = isSmall ? 'small' : 'big';

    // Extract number if present
    const numMatch = line.match(/\b([0-9])\b/);
    if (numMatch) {
      ballNumber = parseInt(numMatch[1], 10);
      size = ballNumber >= 5 ? 'big' : 'small';
      if (ballNumber === 0 || ballNumber === 5) color = 'violet';
      else if ([1, 3, 7, 9].includes(ballNumber)) color = 'green';
      else color = 'red';
    } else {
      // Assign default realistic number for color/size
      if (color === 'violet') ballNumber = size === 'big' ? 5 : 0;
      else if (color === 'red') ballNumber = size === 'big' ? 6 : 2;
      else ballNumber = size === 'big' ? 7 : 3;
    }

    rounds.push({
      roundId: roundId + index,
      timestamp,
      number: ballNumber,
      color,
      size
    });
  });

  return rounds;
}
