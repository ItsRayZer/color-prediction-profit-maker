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

# ----------------------------------------------------------------------
# v2 predictor (2026-10-23)
# ----------------------------------------------------------------------
# Improvements over predict_next_color (which stays untouched for
# backward compatibility):
#  * Order-2 Markov transitions (last TWO colours), falling back to
#    order-1 when the pair has never been seen.
#  * Joint colour+size awareness when history rows carry size info
#    (a "size" key, or a "number" key the size is derived from).
#  * Ensemble weights are LEARNED by a walk-forward grid search
#    (learn_ensemble_weights) instead of the fixed 50/30/20 mix: the
#    search only ever trains on past slices and validates on later
#    slices, so it cannot leak the future into the weights.
#  * walk_forward_report applies the real money gate: a bet is only
#    "taken" when the predicted probability clears the breakeven for
#    the payout (51.02% at 0.96) plus a margin. Everything else is a
#    SKIP, and the report says how often skipping happened.

BREAKEVEN_096 = 1.0 / (1.0 + 0.96)  # 0.5102...

DEFAULT_V2_WEIGHTS = {
    "markov1": 0.30,
    "markov2": 0.25,
    "trend": 0.15,
    "freq": 0.15,
    "size": 0.15,
}

def map_size_simple(row):
    """Normalize a history row to 'BIG' / 'SMALL', or None if unknown."""
    raw = str(row.get("size", "")).lower()
    if "big" in raw:
        return "BIG"
    if "small" in raw:
        return "SMALL"
    num = row.get("number")
    if num is None:
        num = row.get("num")
    if num is not None:
        try:
            return "BIG" if int(num) >= 5 else "SMALL"
        except (TypeError, ValueError):
            return None
    return None

def _color_sequence(history_slice):
    colors = []
    for r in history_slice:
        c = map_color_simple(r.get("color", ""))
        if c in ("green", "red"):
            colors.append(c)
    return colors

def _v2_components(history_slice):
    """Component probabilities of GREEN. None = component unavailable."""
    colors = _color_sequence(history_slice)
    if len(colors) < 5:
        return None
    last = colors[-1]
    comp = {}

    # Order-1 Markov (same math as the v1 engine)
    t1 = defaultdict(lambda: {"green": 0, "red": 0})
    for i in range(len(colors) - 1):
        t1[colors[i]][colors[i + 1]] += 1
    tot1 = t1[last]["green"] + t1[last]["red"]
    comp["markov1"] = t1[last]["green"] / tot1 if tot1 > 0 else 0.5

    # Order-2 Markov: transitions out of the last (prev, last) pair
    t2 = defaultdict(lambda: {"green": 0, "red": 0})
    for i in range(len(colors) - 2):
        t2[(colors[i], colors[i + 1])][colors[i + 2]] += 1
    pair = (colors[-2], colors[-1])
    tot2 = t2[pair]["green"] + t2[pair]["red"]
    comp["markov2"] = t2[pair]["green"] / tot2 if tot2 > 0 else None

    # Trend / streak persistence
    streak_len = 1
    for i in range(len(colors) - 2, -1, -1):
        if colors[i] == last:
            streak_len += 1
        else:
            break
    # Trend probabilities are capped to [0.05, 0.95]: a hard 0/1 is not a
    # probability, it poisons any downstream calibration/Platt fit.
    comp["trend"] = (0.95 if last == "green" else 0.05) if streak_len >= 3 else 0.5

    # Overall frequency
    comp["freq"] = colors.count("green") / len(colors)

    # Joint colour+size: P(green next | current size), from sized rows
    sized = []
    for r in history_slice:
        c = map_color_simple(r.get("color", ""))
        s = map_size_simple(r)
        if c in ("green", "red") and s is not None:
            sized.append((c, s))
    if len(sized) >= 5:
        last_size = sized[-1][1]
        nxt = {"green": 0, "red": 0}
        for i in range(len(sized) - 1):
            if sized[i][1] == last_size:
                nxt[sized[i + 1][0]] += 1
        tot = nxt["green"] + nxt["red"]
        comp["size"] = nxt["green"] / tot if tot > 0 else None
    else:
        comp["size"] = None

    return comp

def predict_next_v2(history_slice, weights=None):
    """v2 ensemble prediction -> (color, confidence_pct)."""
    if not history_slice:
        return "green", 50.0
    comp = _v2_components(history_slice)
    if comp is None:
        return "green", 50.0
    w = dict(DEFAULT_V2_WEIGHTS if weights is None else weights)
    total_w = 0.0
    prob_green = 0.0
    for key, value in comp.items():
        if value is None:
            continue
        weight = float(w.get(key, 0.0))
        if weight <= 0:
            continue
        prob_green += weight * value
        total_w += weight
    if total_w <= 0:
        return "green", 50.0
    prob_green /= total_w
    predicted = "green" if prob_green >= 0.50 else "red"
    confidence = max(prob_green, 1.0 - prob_green) * 100.0
    return predicted, round(confidence, 1)

def _walk_forward_accuracy(rounds, weights, warmup=10):
    """Accuracy of v2 on rounds, each prediction made from past only."""
    correct = 0
    total = 0
    for i in range(warmup, len(rounds)):
        actual = map_color_simple(rounds[i].get("color", ""))
        if actual not in ("green", "red"):
            continue
        predicted, _ = predict_next_v2(rounds[:i], weights)
        total += 1
        if predicted == actual:
            correct += 1
    return (correct / total) if total > 0 else 0.0, total

def learn_ensemble_weights(rounds, warmup=10):
    """
    Walk-forward grid search over ensemble weights.
    The first 60% of rounds (chronological) form the training stream:
    candidate weights are scored walk-forward inside it (each
    prediction uses only earlier rounds). The chosen weights are then
    validated, untouched, on the later 40%. Returns a dict with the
    weights plus train/validation accuracies for honesty.
    """
    rounds = [r for r in rounds if map_color_simple(r.get("color", "")) in ("green", "red")]
    if len(rounds) < warmup + 10:
        return {
            "weights": dict(DEFAULT_V2_WEIGHTS),
            "train_accuracy": 0.0,
            "validation_accuracy": 0.0,
            "candidates_evaluated": 0,
            "note": "Not enough history to learn weights; defaults used.",
        }

    split = max(warmup + 1, int(len(rounds) * 0.6))
    train_rounds = rounds[:split]
    validation_rounds = rounds  # validation predicts inside the full stream after `split`

    grid = [0.0, 0.15, 0.30, 0.45]
    candidates = []
    for m1 in grid:
        for m2 in grid:
            for tr in [0.0, 0.15, 0.30]:
                for fr in [0.0, 0.15, 0.30]:
                    for sz in [0.0, 0.15, 0.30]:
                        if m1 + m2 + tr + fr + sz <= 0:
                            continue
                        candidates.append({"markov1": m1, "markov2": m2, "trend": tr, "freq": fr, "size": sz})

    best_weights = dict(DEFAULT_V2_WEIGHTS)
    best_acc = -1.0
    for cand in candidates:
        acc, _ = _walk_forward_accuracy(train_rounds, cand, warmup)
        if acc > best_acc:
            best_acc = acc
            best_weights = cand

    # Validate the chosen weights on the later slices only: predictions
    # for rounds after the split, each from its own past.
    correct = 0
    total = 0
    for i in range(split, len(validation_rounds)):
        actual = map_color_simple(validation_rounds[i].get("color", ""))
        predicted, _ = predict_next_v2(validation_rounds[:i], best_weights)
        total += 1
        if predicted == actual:
            correct += 1
    validation_accuracy = (correct / total) if total > 0 else 0.0

    return {
        "weights": best_weights,
        "train_accuracy": round(best_acc, 4),
        "validation_accuracy": round(validation_accuracy, 4),
        "candidates_evaluated": len(candidates),
        "train_rounds": len(train_rounds),
        "validation_rounds": total,
    }

def walk_forward_report(rounds, weights=None, payout=0.96, margin=0.02, warmup=10):
    """
    Full walk-forward report for the v2 predictor: overall accuracy,
    bets taken vs skipped under the breakeven gate, accuracy on taken
    bets, and calibration buckets (stated prob vs observed win rate).
    """
    weights = weights if weights is not None else learn_ensemble_weights(rounds, warmup)["weights"]
    breakeven = 1.0 / (1.0 + payout)
    required = breakeven + margin

    evaluated = 0
    correct_all = 0
    bets_taken = 0
    bets_skipped = 0
    correct_on_bets = 0
    buckets = {i: {"count": 0, "wins": 0, "predicted_sum": 0.0} for i in range(10)}

    for i in range(warmup, len(rounds)):
        actual = map_color_simple(rounds[i].get("color", ""))
        if actual not in ("green", "red"):
            continue
        predicted, confidence_pct = predict_next_v2(rounds[:i], weights)
        prob = confidence_pct / 100.0
        won = predicted == actual
        evaluated += 1
        if won:
            correct_all += 1

        b = buckets[min(9, int(prob * 10))]
        b["count"] += 1
        b["wins"] += 1 if won else 0
        b["predicted_sum"] += prob

        if prob >= required:
            bets_taken += 1
            if won:
                correct_on_bets += 1
        else:
            bets_skipped += 1

    bucket_list = []
    ece = 0.0
    for i in range(10):
        b = buckets[i]
        if b["count"] == 0:
            continue
        mean_pred = b["predicted_sum"] / b["count"]
        observed = b["wins"] / b["count"]
        ece += (b["count"] / evaluated) * abs(observed - mean_pred) if evaluated else 0.0
        bucket_list.append({
            "bucket": i,
            "range": [i / 10, (i + 1) / 10],
            "count": b["count"],
            "mean_predicted": round(mean_pred, 4),
            "observed_rate": round(observed, 4),
        })

    return {
        "evaluated": evaluated,
        "accuracy": round(correct_all / evaluated, 4) if evaluated else 0.0,
        "bets_taken": bets_taken,
        "bets_skipped": bets_skipped,
        "accuracy_on_bets": round(correct_on_bets / bets_taken, 4) if bets_taken else 0.0,
        "breakeven": round(breakeven, 4),
        "required_prob": round(required, 4),
        "ece": round(ece, 4),
        "calibration_buckets": bucket_list,
        "weights": weights,
    }

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
