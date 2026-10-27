"""Linux native smoke test: real WebView clicks, isolated config, fake browser.

Run after building: python3 tests/checkin_smoke.py [path-to-binary-or-AppImage]
Requires WebKitWebDriver, xvfb-run and dbus-run-session. Never uses live accounts.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def wait_for(check):
    last_error = None
    for _ in range(100):
        try:
            result = check()
            if result:
                return result
        except (OSError, RuntimeError) as error:
            last_error = error
        time.sleep(0.1)
    raise AssertionError(f"native UI did not become ready: {last_error}")


def main():
    project = Path(__file__).resolve().parents[1]
    binary = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else project / "target/release/provider-proxy-desktop"
    assert binary.is_file(), f"build the desktop app first: {binary}"
    with tempfile.TemporaryDirectory(prefix="pp-checkin-") as directory:
        temporary = Path(directory)
        tools = temporary / "bin"
        tools.mkdir()
        capture = temporary / "browser.log"
        config = temporary / "config.json"
        config.write_text(json.dumps({
            "port": 0,
            "providers": {"fixture": {
                "baseURL": "http://127.0.0.1:1/v1", "models": [],
                "checkin": "https://example.test/checkin",
            }},
            "models": {}, "opencodeConfig": str(temporary / "opencode.json"),
        }))
        # Intercept the OS boundary: verify the URL without launching a browser
        # or making an external request. The actual Tauri event path still runs.
        (tools / "xdg-open").write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$PP_BROWSER_CAPTURE"\n')
        (tools / "xdg-open").chmod(0o755)
        wrapper = tools / "app"
        wrapper.write_text('#!/bin/sh\nexec "$PP_TEST_BINARY" "$PP_CONFIG_FILE"\n')
        wrapper.chmod(0o755)
        env = {
            **os.environ, "PATH": f"{tools}:{os.environ['PATH']}",
            "PP_TEST_BINARY": str(binary), "PP_CONFIG_FILE": str(config),
            "PP_BROWSER_CAPTURE": str(capture), "TAURI_WEBVIEW_AUTOMATION": "true",
            "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS": "1",
            "APPIMAGE_EXTRACT_AND_RUN": "1",
            "XDG_CONFIG_HOME": str(temporary / "config"),
            "XDG_CACHE_HOME": str(temporary / "cache"),
            "XDG_DATA_HOME": str(temporary / "data"),
        }
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with (temporary / "driver.log").open("w+") as log:
            driver = subprocess.Popen(
                ["xvfb-run", "-a", "dbus-run-session", "--", "WebKitWebDriver", f"--port={port}"],
                env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )

            def request(method, path, body=None):
                data = json.dumps(body).encode() if body is not None else None
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}{path}", data=data, method=method,
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with urllib.request.urlopen(req, timeout=25) as response:
                        return json.load(response)["value"]
                except urllib.error.HTTPError as error:
                    raise RuntimeError(error.read().decode()) from error

            session = None
            try:
                wait_for(lambda: request("GET", "/status"))
                created = request("POST", "/session", {"capabilities": {"alwaysMatch": {
                    "browserName": "wry", "webkitgtk:browserOptions": {"binary": str(wrapper)},
                }}})
                session = "/session/" + created["sessionId"]

                def click(selector):
                    element = wait_for(lambda: request("POST", session + "/element", {
                        "using": "css selector", "value": selector,
                    }))["element-6066-11e4-a52e-4f735466cecf"]
                    request("POST", session + "/element/" + element + "/click", {})

                for number, selector in enumerate(['#providers button[data-a="checkin"]', "#p-checkins"], 1):
                    click(selector)
                    wait_for(lambda: capture.exists() and len(capture.read_text().splitlines()) == number)
                    assert capture.read_text().splitlines() == ["https://example.test/checkin"] * number
                    assert len(request("GET", session + "/window/handles")) == 1
                    assert request("GET", session + "/url").startswith("http://127.0.0.1:")
                print(f"PASS {binary.name}: checkin and all-checkins open the system browser, keeping the proxy window")
            except Exception:
                log.seek(0)
                print(log.read()[-3000:], file=sys.stderr)
                raise
            finally:
                if session:
                    try:
                        request("DELETE", session)
                    except (OSError, RuntimeError):
                        pass
                try:
                    os.killpg(driver.pid, signal.SIGTERM)
                    driver.wait(timeout=5)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(driver.pid, signal.SIGKILL)
                    driver.wait()


if __name__ == "__main__":
    main()
