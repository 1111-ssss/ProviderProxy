# Uptime for aquadevs: the status page keeps two endpoints apart.
#
#   GET /api/status-page/monitor-test          -> monitor ids and names, by group
#   GET /api/status-page/heartbeat/monitor-test -> uptimeList["<id>_24"] (0..1)
#                                                 heartbeatList["<id>"][].ping
#
# The 24h figure comes straight from uptimeList. The hour window is not exposed,
# so it is counted from the last two heartbeats. Every heartbeat of the last
# 24 hours is one box of the day strip; the hour strip is the last box.
#
# The status page speaks monitor names, the proxy speaks model ids, so names are
# matched case-insensitively with punctuation and the "(Vendouple)"-style
# suffixes ignored.
import datetime, json, os, re, sys, urllib.request

BASE = "https://status.aquadevs.com"
FIXTURE = os.environ.get("PP_UPTIME_FIXTURE")
PROVIDER = "aquadevs"


def open_url(url):
    # The status page answers 403 to a bare urllib request, so it is asked with
    # a browser User-Agent. The proxy's own API needs the token from the
    # environment when one is configured.
    request = urllib.request.Request(url)
    request.add_header("User-Agent", "Mozilla/5.0 (compatible; provider-proxy uptime)")
    request.add_header("Accept", "application/json")
    token = os.environ.get("PP_PROXY_TOKEN", "")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(request, timeout=20)


def fetch(path):
    # A fixture folder makes the script testable offline: the proxy never needs
    # the network to check the parsing.
    if FIXTURE:
        name = "aq-monitors.json" if "monitor-test" in path and "heartbeat" not in path else "aq-heartbeat.json"
        with open(os.path.join(FIXTURE, name), encoding="utf-8") as handle:
            return json.load(handle)
    with open_url(BASE + path) as response:
        return json.load(response)


def stamp(value):
    # The page prints "2026-11-26 08:28:07.946" in its own timezone; the GUI
    # parses ISO, so the space becomes a T. The zone stays unknown.
    return str(value).replace(" ", "T", 1)


def models():
    # In a fixture run the model list comes from the folder too, so the whole
    # script is offline; a real run asks the proxy for it.
    if FIXTURE:
        with open(os.path.join(FIXTURE, f"models-{PROVIDER}.json"), encoding="utf-8") as handle:
            return json.load(handle)["models"]
    with open_url(os.environ["PP_MODELS_API"]) as response:
        return json.load(response)["models"]


def words(name):
    """Name as lowercase words, so "DeepSeek V4 Pro" and "deepseek-v4-pro" meet.

    A trailing "32B"/"1017" is a variant size and stays a word: it is what tells
    "Gemma 4 31B" from a bare "Gemma 4".
    """
    return [re.sub(r"^v(?=\d)", "", word) for word in re.sub(r"[^a-z0-9]+", " ", name.lower()).split()]


def pick(model, monitors):
    """The monitor for a model id, or None when the page has nothing for it.

    The status page writes names in prose ("Claude Opus 5.5", "Mistral Large
    4", "GPT Image 2") while the proxy uses ids ("opus-5.5", "mistral-4",
    "gptimage-2"), so equality almost never holds. Every word of the id must
    appear in the name: "glm-5.3-flash" keeps "GLM 5.3 Flash" and drops
    "GLM 5.3 Flash (M)" is not needed, since the exact match wins first. The
    vendor prefix ("Claude", "Perplexity") is allowed to be extra, which is
    the whole point.

    Ties are broken by the fewest extra words, then by monitor id: the page
    lists the base variant before its twin, so "deepseek-v4" lands on Flash,
    not on the "Pro" that has its own id in the catalog.
    """
    wanted = model.split(":", 1)[0]  # "deepseek-v3.2:vendouple" is the same model
    tokens = set(words(wanted))
    compact = re.sub(r"[^a-z0-9]+", "", wanted.lower())
    best = None
    for monitor in monitors:
        monitor_words = set(words(monitor["name"]))
        monitor_compact = re.sub(r"[^a-z0-9]+", "", monitor["name"].lower())
        if not (tokens <= monitor_words or compact in monitor_compact):
            continue
        extra = len(monitor_words - tokens)
        # An exact key still wins over any shorter name that happens to fit.
        rank = (extra, 0 if monitor_compact == compact else 1, monitor["id"])
        if best is None or rank < best[0]:
            best = (rank, monitor["id"])
    return best[1] if best else None


def recent_beats(beats):
    """The beats of the last 24 hours, on the page's own clock.

    The page returns a fixed count (about fifty beats, one every four hours,
    eight days), so all fifty are not a day. Anchoring to the newest beat keeps
    the strip the same length for every monitor even when the page lags.
    """
    stamps = [b["time"] for b in beats if b.get("time")]
    if not stamps:
        return []
    latest = max(stamps)
    cutoff = datetime.datetime.fromisoformat(stamp(latest)) - datetime.timedelta(hours=24)
    return [
        b for b in beats
        if b.get("time") and datetime.datetime.fromisoformat(stamp(b["time"])) >= cutoff
    ]


def main():
    monitors = fetch("/api/status-page/monitor-test")
    heartbeat = fetch("/api/status-page/heartbeat/monitor-test")
    # Every group: the page files text models and image models apart, and the
    # catalog mixes both.
    listed = [monitor for group in monitors.get("publicGroupList", []) for monitor in group.get("monitorList", [])]

    bars = []
    for model in models():
        monitor_id = pick(model, listed)
        if monitor_id is None:
            # No monitor, no number: a zero would read as "100 % down" for a
            # model the page simply does not track.
            bars.append({"label": model})
            continue
        uid = str(monitor_id)
        percent24 = float(heartbeat.get("uptimeList", {}).get(f"{uid}_24") or 0) * 100
        beats = heartbeat.get("heartbeatList", {}).get(uid, [])
        day = recent_beats(beats)
        # The hour window is one box, the last beat: beats can sit hours apart
        # when a monitor skips checks, so "the last two" was really an 8-hour
        # share. The number follows the box instead of disagreeing with it.
        last = beats[-1] if beats else None
        percent1 = 100.0 if last and last.get("status") == 1 else 0.0
        pings = [b["ping"] for b in beats if isinstance(b.get("ping"), (int, float)) and b["ping"] > 0]
        # status 1 is up, 2 is "pending" and 0 is down, so only 1 counts as a box
        # at 100%: a pending beat is not a good one.
        cell = lambda b: {"percent": 100.0 if b.get("status") == 1 else 0.0, "t": stamp(b["time"])}
        bar = {
            "label": model,
            "percent": round(percent24, 1),
            "percent24h": round(percent24, 1),
            "percent1h": round(percent1, 1),
            "cells24h": [cell(b) for b in day],
            "cells1h": [cell(last)] if last and last.get("time") else [],
        }
        if pings:
            bar["latencyMs"] = round(sum(pings) / len(pings))
        bars.append(bar)

    print(json.dumps({"title": "Аптайм aquadevs", "window": "24h", "bars": bars}, ensure_ascii=False))


if __name__ == "__main__":
    main()
