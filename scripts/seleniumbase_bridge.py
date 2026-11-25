"""Local Chrome owner plus a bounded, separate challenge worker.

stdout is JSON-lines control data only. Neither process receives applicant data.
"""
import contextlib
import json
import subprocess
import sys
from urllib.parse import urlparse


def emit(message):
    print(json.dumps(message), flush=True)


def solve_worker(endpoint, target_id):
    """Attach to exactly one existing target without navigating any page."""
    import asyncio
    import mycdp as cdp
    from seleniumbase.core.sb_cdp import CDPMethods
    from seleniumbase.undetected.cdp_driver import cdp_util
    from seleniumbase.undetected.cdp_driver.tab import Tab

    address = urlparse(endpoint)
    if address.hostname not in ("127.0.0.1", "localhost", "::1") or not address.port:
        return 1
    loop = asyncio.new_event_loop()
    driver = None
    try:
        driver = cdp_util.start_sync(host=address.hostname, port=address.port, loop=loop)
        info = loop.run_until_complete(driver.connection.send(
            cdp.target.get_target_info(cdp.target.TargetID(target_id))))
        target = Tab(
            websocket_url=f"ws://{address.hostname}:{address.port}/devtools/page/{target_id}",
            target=info, browser=driver)
        methods = CDPMethods(loop, target, driver)
        methods.headless = False
        methods.headed = True
        methods.bring_active_window_to_front()
        methods.solve_captcha()
        return 0
    except Exception:
        return 1
    finally:
        if driver is not None:
            # This connection did not launch Chrome; stop disconnects only it.
            with contextlib.suppress(Exception):
                driver.stop()


def run_challenge(endpoint, target_id):
    try:
        result = subprocess.run(
            [sys.executable, __file__, "--worker", endpoint, target_id],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=55,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        # subprocess.run kills and waits for the worker before returning.
        # No challenge automation can continue after the human handoff.
        return False


def main():
    sb = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from seleniumbase import sb_cdp
            sb = sb_cdp.Chrome(host="127.0.0.1", headless=False, sandbox=True, incognito=True)
            endpoint = sb.get_endpoint_url()
        emit({"event": "ready", "endpoint": endpoint})
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                command = request.get("command")
                if command == "quit":
                    break
                if command != "challenge" or not isinstance(request.get("targetId"), str):
                    raise ValueError()
                ok = run_challenge(endpoint, request["targetId"])
                emit({"id": request["id"], "ok": ok})
            except Exception:
                emit({"id": request.get("id"), "ok": False})
    except Exception:
        emit({"event": "error", "error": "seleniumbase_start_failed"})
        return 1
    finally:
        if sb is not None:
            with contextlib.redirect_stdout(sys.stderr):
                with contextlib.suppress(Exception):
                    sb.quit()
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        with contextlib.redirect_stdout(sys.stderr):
            status = solve_worker(sys.argv[2], sys.argv[3])
        sys.exit(status)
    sys.exit(main())
