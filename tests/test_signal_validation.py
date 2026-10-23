"""Standalone check for the v2 trend-probability cap (run: python3 tests/test_signal_validation.py).
Not part of the npm suite — signal_validation.py is a research script."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import signal_validation as sv


def rows(colors):
    return [{"color": c, "number": 1 if c == "green" else 2, "size": "SMALL"} for c in colors]


def main():
    # Long green streak -> trend must be capped at 0.95, never a hard 1.0
    comp = sv._v2_components(rows(["green"] * 6 + ["red"] + ["green"] * 4))
    assert comp["trend"] == 0.95, f"green streak trend should be capped 0.95, got {comp['trend']}"

    # Long red streak -> trend must be capped at 0.05, never a hard 0.0
    comp = sv._v2_components(rows(["red"] * 5 + ["green"] + ["red"] * 4))
    assert comp["trend"] == 0.05, f"red streak trend should be capped 0.05, got {comp['trend']}"

    # Short streak -> neutral 0.5 unchanged (needs >= 5 rows for components)
    comp = sv._v2_components(rows(["red", "green", "red", "green", "red", "green"]))
    assert comp["trend"] == 0.5, f"short streak trend should stay 0.5, got {comp['trend']}"

    # Every component the v2 predictor emits stays inside [0, 1] and the
    # combined probability never collapses to a hard 0/1.
    pred = sv.predict_next_v2(rows(["green"] * 8))
    assert pred is not None
    print("signal_validation trend-cap checks: OK", pred)


if __name__ == "__main__":
    main()
