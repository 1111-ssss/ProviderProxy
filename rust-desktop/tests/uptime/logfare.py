# Uptime for logfare: three endpoints, two windows.
#
#   GET /v1/status?hours=N          -> one row per model: uptime_percent,
#                                      avg_tps, avg_ttft_ms, avg_latency_ms
#   GET /v1/status/history?hours=N  -> the same models as time buckets
#
# Both windows (1 h and 24 h) are fetched on one run: the dialog offers a
# window switch only when every bar carries both percentages. History gives the
# strip of boxes a status page draws under the bar, each bucket with its time.
#
# `checks` is 0 even for a model with traffic, so uptime_percent (not that
# counter) is the number to show; real_traffic_success_rate is the same share
# for measured traffic and is used as a fallback.
import json, os, urllib.request

BASE = "https://logfare.ai"
FIXTURE = os.environ.get("PP_UPTIME_FIXTURE")
PROVIDER = "logfare"
WINDOWS = (1, 24)


def open_url(url):
    # The proxy's models API needs the token from the environment when one is
    # configured; logfare itself ignores both headers.
    request = urllib.request.Request(url)
    request.add_header("User-Agent", "Mozilla/5.0 (compatible; provider-proxy uptime)")
    request.add_header("Accept", "application/json")
    token = os.environ.get("PP_PROXY_TOKEN", "")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(request, timeout=20)


def fetch(name, hours):
    if FIXTURE:
        with open(os.path.join(FIXTURE, f"{name}-{hours}.json"), encoding="utf-8") as handle:
            return json.load(handle)
    with open_url(f"{BASE}/v1/status{'/history' if name == 'lf-hist' else ''}?hours={hours}") as response:
        return json.load(response)


def number(value):
    return value if isinstance(value, (int, float)) and value >= 0 else None


def percent_of(row):
    percent = number(row.get("uptime_percent"))
    if percent is not None:
        return round(percent, 1)
    rate = number(row.get("real_traffic_success_rate"))
    return round(rate * 100, 1) if rate is not None else 0


def cells(history, model):
    # A bucket without an uptime reading (status "unknown") keeps its slot but no
    # percent: the GUI draws it grey. Dropping it left a hole in the middle of
    # the strip, and the strip then read as a shorter window.
    row = history.get(model) or {}
    cells = []
    for bucket in row.get("buckets", []):
        if not bucket.get("t"):
            continue
        uptime = number(bucket.get("uptime"))
        cell = {"t": bucket["t"]}
        if uptime is not None:
            cell["percent"] = round(uptime, 1)
        cells.append(cell)
    return cells


def main():
    if FIXTURE:
        with open(os.path.join(FIXTURE, f"models-{PROVIDER}.json"), encoding="utf-8") as handle:
            wanted = json.load(handle)["models"]
    else:
        with open_url(os.environ["PP_MODELS_API"]) as response:
            wanted = json.load(response)["models"]

    # The day summary is the base: speed and latency describe the whole day.
    rows = {hours: {row["model_id"]: row for row in fetch("lf", hours).get("data", [])} for hours in WINDOWS}
    history = {
        hours: {row["model_id"]: row for row in fetch("lf-hist", hours).get("data", [])} for hours in WINDOWS
    }

    bars = []
    for model in wanted:
        day = rows[24].get(model) or {}
        bar = {
            "label": model,
            "percent": percent_of(day),
            "percent24h": percent_of(day),
            "percent1h": percent_of(rows[1].get(model) or {}),
            "cells24h": cells(history[24], model),
            "cells1h": cells(history[1], model),
        }
        if (tps := number(day.get("avg_tps"))) is not None:
            bar["tps"] = round(tps, 1)
        if (ttft := number(day.get("avg_ttft_ms"))) is not None:
            bar["ttftMs"] = round(ttft)
        if (latency := number(day.get("avg_latency_ms"))) is not None:
            bar["latencyMs"] = round(latency)
        bars.append(bar)

    print(json.dumps({"title": "Аптайм logfare", "window": "24h", "bars": bars}, ensure_ascii=False))


if __name__ == "__main__":
    main()
