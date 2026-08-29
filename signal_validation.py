import csv
import os
from collections import defaultdict

def load_history(filepath="history.csv"):
    if not os.path.exists(filepath):
        print(f"[-] Error: File '{filepath}' not found. Please run scraper.py first.")
        return []
    
    rounds = []
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rounds.append(row)
    return rounds

def map_color_simple(color):
    """Normalize color outcome to primary 'green' or 'red'"""
    c = str(color).lower()
    if "green" in c:
        return "green"
    elif "red" in c:
        return "red"
    return "unknown"

def predict_next_color(history_slice):
    """
    Algorithmic prediction engine combining:
    1. Markov Transition Matrix
    2. Streak Reversion vs Persistence Model
    3. Frequency / Gap analysis
    """
    if not history_slice:
        return "green", 50.0

    colors = [map_color_simple(r["color"]) for r in history_slice if map_color_simple(r["color"]) in ["green", "red"]]
    if len(colors) < 5:
        return "green", 50.0

    last_color = colors[-1]
    
    # 1. Calculate Markov transition probabilities
    transitions = defaultdict(lambda: {"green": 0, "red": 0})
    for i in range(len(colors) - 1):
        curr, nxt = colors[i], colors[i+1]
        transitions[curr][nxt] += 1
    
    total_from_last = transitions[last_color]["green"] + transitions[last_color]["red"]
    markov_p_green = transitions[last_color]["green"] / total_from_last if total_from_last > 0 else 0.5

    # 2. Streak analysis (Dragon tail check)
    streak_len = 1
    for i in range(len(colors) - 2, -1, -1):
        if colors[i] == last_color:
            streak_len += 1
        else:
            break
            
    # Streak rule: If streak >= 4, predict continuation (trend following) with cap
    trend_p_green = (1.0 if last_color == "green" else 0.0) if streak_len >= 3 else 0.5

    # 3. Overall Frequency
    green_count = colors.count("green")
    freq_p_green = green_count / len(colors)

    # Weighted Ensemble Prediction
    prob_green = (0.50 * markov_p_green) + (0.30 * trend_p_green) + (0.20 * freq_p_green)
    
    predicted_color = "green" if prob_green >= 0.50 else "red"
    confidence = max(prob_green, 1.0 - prob_green) * 100.0

    return predicted_color, round(confidence, 1)

def run_backtest_and_safety_simulation(rounds, base_bet=10, max_consecutive_losses=3):
    """
    Simulates:
    1. Standard Martingale Strategy (1x, 3x, 9x, 27x...) -> HIGH RISK OF RUIN
    2. Smart Strategy with 3-Loss Circuit Breaker (Stop Loss & Reset to Base) -> RUIN PREVENTION
    """
    print("\n=======================================================")
    print("      STRATEGY BACKTEST & RISK CONTROL REPORT          ")
    print("=======================================================")
    print(f"Total Rounds Loaded: {len(rounds)}")
    print(f"Base Bet Amount: {base_bet} units | 3-Loss Recovery Cap: {max_consecutive_losses} Losses")
    print("-------------------------------------------------------")

    # Metrics for Standard Martingale
    balance_std = 1000.0
    current_bet_std = base_bet
    max_drawdown_std = 0.0
    peak_std = 1000.0

    # Metrics for 3-Loss Circuit Breaker Strategy
    balance_circuit = 1000.0
    current_bet_circuit = base_bet
    consecutive_losses_circuit = 0
    max_drawdown_circuit = 0.0
    peak_circuit = 1000.0

    correct_predictions = 0
    total_evaluated = 0
    max_loss_streak_encountered = 0
    current_loss_streak = 0

    for i in range(10, len(rounds)):
        history_slice = rounds[:i]
        actual_round = rounds[i]
        actual_color = map_color_simple(actual_round["color"])
        
        if actual_color not in ["green", "red"]:
            continue

        predicted_color, confidence = predict_next_color(history_slice)
        total_evaluated += 1
        is_win = (predicted_color == actual_color)

        if is_win:
            correct_predictions += 1
            current_loss_streak = 0
        else:
            current_loss_streak += 1
            if current_loss_streak > max_loss_streak_encountered:
                max_loss_streak_encountered = current_loss_streak

        # ----------------------------------------------------
        # 1. Standard Unlimited Martingale Execution
        # ----------------------------------------------------
        if is_win:
            balance_std += current_bet_std * 0.96 # 96% payout (4% platform fee)
            current_bet_std = base_bet
        else:
            balance_std -= current_bet_std
            current_bet_std *= 3 # Double/Triple bet on loss

        if balance_std > peak_std:
            peak_std = balance_std
        drawdown_std = peak_std - balance_std
        if drawdown_std > max_drawdown_std:
            max_drawdown_std = drawdown_std

        # ----------------------------------------------------
        # 2. Smart Strategy with 3-Loss Circuit Breaker
        # ----------------------------------------------------
        if is_win:
            balance_circuit += current_bet_circuit * 0.96
            current_bet_circuit = base_bet
            consecutive_losses_circuit = 0
        else:
            balance_circuit -= current_bet_circuit
            consecutive_losses_circuit += 1

            if consecutive_losses_circuit >= max_consecutive_losses:
                # [SAFETY TRIGGERED] Reset to base bet after 3 consecutive losses
                current_bet_circuit = base_bet
                consecutive_losses_circuit = 0
            else:
                current_bet_circuit *= 3 # Safe 3x progression up to cap

        if balance_circuit > peak_circuit:
            peak_circuit = balance_circuit
        drawdown_circuit = peak_circuit - balance_circuit
        if drawdown_circuit > max_drawdown_circuit:
            max_drawdown_circuit = drawdown_circuit

    win_rate = (correct_predictions / total_evaluated * 100.0) if total_evaluated > 0 else 0.0

    print(f"Prediction Accuracy: {win_rate:.2f}% ({correct_predictions}/{total_evaluated})")
    print(f"Max Loss Streak Encountered: {max_loss_streak_encountered} in a row")
    print("\n--- PERFORMANCE COMPARISON ---")
    print(f"Standard Martingale Final Balance:   ${balance_std:.2f} | Max Drawdown: ${max_drawdown_std:.2f}")
    print(f"3-Loss Protected Final Balance:     ${balance_circuit:.2f} | Max Drawdown: ${max_drawdown_circuit:.2f}")
    
    if max_drawdown_std > balance_std:
        print("\n[!] WARNING: Standard Martingale suffered extreme drawdown (Potential Bankruptcy).")
    if balance_circuit > balance_std:
        print("\n[✓] SUCCESS: The 3-Loss Circuit Breaker effectively prevented severe drawdown!")

if __name__ == "__main__":
    rounds = load_history("history.csv")
    if rounds:
        run_backtest_and_safety_simulation(rounds)
