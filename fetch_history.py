"""
Multi-Page WinGo Historical Data Exporter
=======================================
Fetches multiple pages of PAST resolved rounds from the public history API:
https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?page=N
Saves them into wingo_30s_history.csv (oldest-first) for pattern analysis.
"""

import requests
import csv
import json
import sys
import time

BASE_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://dhaniwin0.com/",
    "Origin": "https://dhaniwin0.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
}


def fetch_page(page_num=1):
    url = f"{BASE_URL}?page={page_num}"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json()


def find_row_list(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("list", "data", "rows", "records", "issueList"):
            if key in data:
                found = find_row_list(data[key])
                if found:
                    return found
        for v in data.values():
            found = find_row_list(v)
            if found:
                return found
    return None


def normalize_row(row):
    period = (row.get("issueNumber") or row.get("issue") or
              row.get("period") or row.get("expect") or row.get("id"))
    number = (row.get("number") or row.get("openNumber") or
              row.get("code") or row.get("result"))
    size = row.get("size") or row.get("bigSmall")

    if number is not None:
        try:
            num_val = int(str(number)[-1]) if len(str(number)) > 1 and size is None else int(number)
        except ValueError:
            num_val = 0
    else:
        num_val = 0

    if size is None:
        size = "BIG" if num_val >= 5 else "SMALL"

    return {"period": str(period), "number": num_val, "size": str(size)}


def main(max_pages=10):
    print(f"Fetching WinGo 30S history up to {max_pages} pages from: {BASE_URL}\n")
    all_rows = []
    seen_periods = set()

    for p in range(1, max_pages + 1):
        try:
            print(f"--> Fetching Page {p}...")
            data = fetch_page(p)
            rows = find_row_list(data)
            if not rows:
                print(f"    No rows found on page {p}. Stopping.")
                break

            added_count = 0
            for r in rows:
                norm = normalize_row(r)
                if norm["period"] and norm["period"] not in seen_periods:
                    seen_periods.add(norm["period"])
                    all_rows.append(norm)
                    added_count += 1

            print(f"    Page {p}: Got {len(rows)} raw rows, {added_count} new unique records.")
            if len(rows) == 0:
                break
            time.sleep(0.3)
        except Exception as e:
            print(f"    Page {p} failed: {e}")
            break

    if not all_rows:
        print("No historical records retrieved.")
        sys.exit(1)

    # Sort oldest-first by period
    all_rows.sort(key=lambda r: r["period"])

    out_path = "wingo_30s_history.csv"
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["period", "number", "size"])
        writer.writeheader()
        for r in all_rows:
            writer.writerow(r)

    print(f"\n[SUCCESS] Successfully saved {len(all_rows)} historical rounds to {out_path}")


if __name__ == "__main__":
    main()
