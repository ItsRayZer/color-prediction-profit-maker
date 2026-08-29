import os
import json
import csv
import time
import requests
from datetime import datetime

# ==========================================
# CONFIGURATION
# ==========================================
# Replace API_URL and HEADERS with your DevTools findings:
API_URL = os.environ.get("WIN_GAME_API_URL", "https://api.example-game.com/api/webapi/GetNoheaderList")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/json;charset=UTF-8",
    "Authorization": os.environ.get("WIN_GAME_TOKEN", "Bearer <YOUR_TOKEN_HERE>"),
    # Add any extra headers from DevTools here (e.g., "X-Token": "...")
}

# Payload format for standard WinGo APIs
PAYLOAD = {
    "typeId": 1,        # 1 = WinGo 30s / 1m, 2 = 3m, 3 = 5m
    "pageNo": 1,
    "pageSize": 50
}

OUTPUT_CSV = "history.csv"

def determine_color(number):
    """Derive outcome color from drawn number (0-9)"""
    try:
        num = int(number)
        if num == 0:
            return "red-violet"  # 0 is Red + Violet
        elif num == 5:
            return "green-violet" # 5 is Green + Violet
        elif num in [1, 3, 7, 9]:
            return "green"
        elif num in [2, 4, 6, 8]:
            return "red"
    except (ValueError, TypeError):
        pass
    return "unknown"

def determine_size(number):
    """Derive Big / Small from number (0-4 Small, 5-9 Big)"""
    try:
        num = int(number)
        return "big" if num >= 5 else "small"
    except (ValueError, TypeError):
        return "unknown"

def parse_api_response(data):
    """
    Parses various JSON API schemas common in WinGo / Color Prediction platforms.
    Extracts period (issue number), number (result), color, and size.
    """
    rounds = []
    
    # Try finding the list in common JSON structures
    raw_list = []
    if isinstance(data, dict):
        if "data" in data and isinstance(data["data"], dict) and "list" in data["data"]:
            raw_list = data["data"]["list"]
        elif "data" in data and isinstance(data["data"], list):
            raw_list = data["data"]
        elif "list" in data and isinstance(data["list"], list):
            raw_list = data["list"]
        elif "rows" in data and isinstance(data["rows"], list):
            raw_list = data["rows"]
    elif isinstance(data, list):
        raw_list = data

    for item in raw_list:
        if not isinstance(item, dict):
            continue

        # Extract period / issue
        period = str(item.get("issueNumber") or item.get("period") or item.get("issue") or item.get("id") or "")
        
        # Extract number / result
        number = str(item.get("number") or item.get("result") or item.get("winningNumber") or "")
        
        # Extract color if provided, else calculate
        color = str(item.get("colour") or item.get("color") or "").lower()
        if not color or color == "none":
            color = determine_color(number)

        size = str(item.get("size") or item.get("bigSmall") or "").lower()
        if not size or size == "none":
            size = determine_size(number)

        timestamp = item.get("createTime") or item.get("time") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if period and number:
            rounds.append({
                "period": period,
                "number": number,
                "color": color,
                "size": size,
                "timestamp": timestamp
            })

    return rounds

def fetch_from_api(url, headers, payload):
    """Send request to the platform API endpoint"""
    try:
        print(f"[*] Requesting data from {url}...")
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        
        # Fallback to GET if POST is rejected with 405
        if response.status_code == 405:
            response = requests.get(url, headers=headers, timeout=10)

        response.raise_for_status()
        json_data = response.json()
        print(f"[+] Received valid JSON response with {len(json_data)} bytes.")
        return json_data
    except Exception as e:
        print(f"[-] API Fetch error: {e}")
        return None

def generate_sample_history(count=100):
    """Fallback generator for mock testing when offline or setting up"""
    import random
    rounds = []
    base_period = int(time.time() // 30)
    for i in range(count):
        num = random.randint(0, 9)
        rounds.append({
            "period": str(base_period - i),
            "number": str(num),
            "color": determine_color(num),
            "size": determine_size(num),
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })
    return rounds

def save_to_csv(rounds, filename=OUTPUT_CSV):
    """Save parsed rounds into history.csv"""
    if not rounds:
        print("[-] No rounds to save.")
        return

    fieldnames = ["period", "number", "color", "size", "timestamp"]
    
    # Sort chronologically (oldest first, newest last)
    rounds.sort(key=lambda x: x["period"])

    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rounds)

    print(f"[✓] Saved {len(rounds)} records to '{filename}'.")

if __name__ == "__main__":
    print("=== Color Prediction Scraper & Data Ingestion Tool ===")
    
    # Try fetching real API data first if configured
    data = None
    if API_URL and "example-game.com" not in API_URL:
        data = fetch_from_api(API_URL, HEADERS, PAYLOAD)

    if data:
        parsed_rounds = parse_api_response(data)
    else:
        print("[!] No live API URL specified or fetch failed. Generating sample history for validation...")
        parsed_rounds = generate_sample_history(100)

    save_to_csv(parsed_rounds)
