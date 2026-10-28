import os
import sys
import json
import time
import shutil
import datetime
import threading
import subprocess
import webbrowser
import urllib.request
import ctypes
from ctypes import wintypes
from http.server import HTTPServer, BaseHTTPRequestHandler
import tkinter as tk
from tkinter import font as tkfont

# --- config ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 5005
TARGET_URL = "https://elearning.pnb.ac.id/mahasiswa/list-class"
LOGIN_URL = "https://elearning.pnb.ac.id/login"
TOKEN_STORAGE_KEYS = ("tokenscr", "tokensrc")
CLOAKED_HWNDS = set()
STOP_CLOAKING_EVENT = threading.Event()
WINDOW_TITLE = "read me for a sec"
FLAG_FILE = os.path.join(SCRIPT_DIR, ".hw_notifier_scheduled")
LAST_RUN_FILE = os.path.join(SCRIPT_DIR, ".hw_notifier_last_run")
HEADLESS_PROFILE_DIR = os.path.join(SCRIPT_DIR, ".headless_profile")
HEADLESS_DEBUG_PORT = 9229
TASK_SCHEDULER_GUIDE_URL = "https://www.windowscentral.com/how-create-automated-task-using-task-scheduler-windows-10"
TIMEOUT_SECONDS = 300  # 5 minutes wait for browser to finish
IGNORE_LAST_RUN_DATE = (
    True  # Set to True (or pass --ignore-date) for debugging to bypass daily run check
)
IGNORE_HW_TOKENS = (
    False  # Set to True (or pass --ignore-hw-tokens) to ignore all __HW_* tokens
)
DISABLE_AUTO_CLOSE_ON_REPEAT = False  # Set to True (or pass --no-auto-close) to disable auto-close when already ran today
RUN_IN_BACKGROUND_DAEMON = False  # Set to True (or pass --daemon) to detach automaton.py itself with no console window
HEADLESS_MODE = False  # Set to True (or --headless / --no-headless) to toggle headless vs non-headless browser
TIMEOUT_ALERT_MESSAGE = (
    "[!] Scraper Loss Mid resp. Target URL decides to bounce the token storage (cookie). "
    "Re-log now to prep. fresh token auth."
)
RELOG_FAIL_ALERT_MESSAGE = (
    "[!] Relog in fail. After bouncing of token auth, user does not give any proper inputs of log-in auth. "
    "Force stop."
)

REMINDER_TEXT = (
    "Hey! It looks like you haven't set up Task Scheduler yet.\n\n"
    "To make this script run automatically every day, as long as this PC open\n"
    "you need to add it to Windows Task Scheduler.\n"
    "Have you already done this before?\n\n"
    "If you have, please set this python file to be open as long as PC opened, and then click this green button so this message won't appear next time it ran.\n"
    "If you haven't, click the red button\n"
)


# --- HTTP Server for receiving HW_Fetcher output ---
class HWReceiverHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors_headers()
        self.end_headers()
        resp = {"status": "listening", "port": SERVER_PORT}
        self.wfile.write(json.dumps(resp).encode("utf-8"))

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)

        try:
            payload = json.loads(post_data.decode("utf-8"))
            status = payload.get("status", "unknown")
            print(
                f"\n[automaton] Successfully received payload on port {SERVER_PORT} (status={status})!"
            )
            count = payload.get("count", len(payload.get("items", [])))
            print(
                f"[automaton] Payload contains {count} item(s) from source '{payload.get('source', 'unknown')}'."
            )

            if status == "login_required":
                resume_url = payload.get("resumeUrl", TARGET_URL)
                wait_sec = payload.get("waitSeconds", 30)
                print(
                    f"[automaton] Browser routed to /login! Requesting user login (waiting {wait_sec}s before resuming {resume_url})..."
                )
                UTILS_uncloak_browser_windows_for_relog()
            elif status == "relog_verified":
                print(
                    f"[automaton] Relog verified (<div> appeared on {payload.get('url', 'target page')})! Continuing loop..."
                )
                self.server.relog_verified = True
                self.server.relog_verify_event.set()
                if UTILS_is_headless_mode():
                    UTILS_recloak_browser_windows()
            elif status == "relog_failed":
                self.server.relog_verified = False
                self.server.relog_verify_event.set()
                self.server.received_payload = payload
                self.server.received_event.set()
            else:
                self.server.received_payload = payload
                self.server.received_event.set()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.end_headers()
            resp = {"status": "success", "message": "Payload received by automaton.py"}
            self.wfile.write(json.dumps(resp).encode("utf-8"))
        except Exception as e:
            print(f"[automaton] Error processing POST payload: {e}")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.end_headers()
            resp = {"status": "error", "message": str(e)}
            self.wfile.write(json.dumps(resp).encode("utf-8"))

    def log_message(self, format, *args):
        # Concise logging for HTTP requests
        print(
            f"[automaton-port-{SERVER_PORT}] {self.address_string()} - {format % args}"
        )


class HWReceiverServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass):
        super().__init__(server_address, RequestHandlerClass)
        self.received_payload = None
        self.received_event = threading.Event()
        self.relog_closed_event = threading.Event()
        self.relog_verify_event = threading.Event()
        self.relog_verified = False


def UTILS_center_window(window, width, height):
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width // 2) - (width // 2)
    y = (screen_height // 2) - (height // 2)
    window.geometry(f"{width}x{height}+{x}+{y}")


def UTILS_has_been_scheduled():
    return os.path.exists(FLAG_FILE)


def UTILS_mark_as_scheduled():
    with open(FLAG_FILE, "w", encoding="utf-8") as f:
        f.write("scheduled")


def UTILS_is_headless_mode():
    if "--no-headless" in sys.argv:
        return False
    if "--headless" in sys.argv:
        return True
    return bool(HEADLESS_MODE)


def UTILS_should_ignore_date():
    return (
        IGNORE_LAST_RUN_DATE
        or IGNORE_HW_TOKENS
        or ("--ignore-date" in sys.argv)
        or ("--ignore-hw-tokens" in sys.argv)
        or ("--force" in sys.argv)
    )


def UTILS_should_ignore_hw_tokens():
    return (
        IGNORE_HW_TOKENS
        or ("--ignore-hw-tokens" in sys.argv)
        or UTILS_should_ignore_date()
    )


def UTILS_should_disable_auto_close():
    return DISABLE_AUTO_CLOSE_ON_REPEAT or ("--no-auto-close" in sys.argv)


def UTILS_has_already_run_today():
    if UTILS_should_ignore_date():
        print("[automaton] Debug mode: ignoring last run date in memory.")
        return False

    today_str = datetime.date.today().isoformat()
    if os.path.exists(LAST_RUN_FILE):
        try:
            with open(LAST_RUN_FILE, "r", encoding="utf-8") as f:
                if f.read().strip() == today_str:
                    return True
        except Exception:
            pass

    # Fallback check against existing hw_payload.json if already generated today
    payload_file = os.path.join(SCRIPT_DIR, "hw_payload.json")
    if os.path.exists(payload_file):
        try:
            mtime_date = datetime.date.fromtimestamp(
                os.path.getmtime(payload_file)
            ).isoformat()
            if mtime_date == today_str:
                with open(payload_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("status") in ("success", "skipped"):
                    return True
        except Exception:
            pass

    return False


def UTILS_mark_ran_today():
    today_str = datetime.date.today().isoformat()
    try:
        with open(LAST_RUN_FILE, "w", encoding="utf-8") as f:
            f.write(today_str)
    except Exception as e:
        print(f"[automaton] Could not write last run file: {e}")


def UTILS_find_vivaldi_path():
    # 1. Check Windows Registry App Paths
    if sys.platform == "win32":
        import winreg

        for root_key in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(
                    root_key,
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\vivaldi.exe",
                ) as key:
                    val, _ = winreg.QueryValueEx(key, "")
                    if val and os.path.exists(val):
                        return val
            except OSError:
                pass

    # 2. Check common installation paths
    candidates = [
        r"D:\x\App\Vivaldi\Application\vivaldi.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe"),
        os.path.expandvars(r"%PROGRAMFILES%\Vivaldi\Application\vivaldi.exe"),
        os.path.expandvars(r"%PROGRAMFILES(X86)%\Vivaldi\Application\vivaldi.exe"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path

    return None


def UTILS_open_browser_unobtrusive(url, force_visible=False):
    """
    Spawns the browser in the background without any visible UI or focus interruption
    when headless mode is enabled (unless force_visible=True).
    Uses Win32 window cloaking on the user's live Vivaldi profile so that:
    - Live Tampermonkey userscripts and sessionStorage queue [a, b, c, d, e] are preserved.
    - If routed to /login mid-loop, the exact window can be uncloaked for user re-login
      and re-cloaked once the loop resumes at the current class URL.
    """
    use_headless = UTILS_is_headless_mode() and not force_visible
    vivaldi_exe = UTILS_find_vivaldi_path()

    if sys.platform == "win32" and vivaldi_exe:
        user32 = ctypes.windll.user32
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def _get_chrome_windows():
            hwnds = set()

            def _cb(hwnd, lparam):
                if user32.IsWindowVisible(hwnd):
                    cls = ctypes.create_unicode_buffer(256)
                    user32.GetClassNameW(hwnd, cls, 256)
                    if "Chrome_WidgetWin" in cls.value:
                        hwnds.add(hwnd)
                return True

            user32.EnumWindows(WNDENUMPROC(_cb), 0)
            return hwnds

        existing_hwnds = _get_chrome_windows()
        prev_fg_hwnd = user32.GetForegroundWindow()

        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        SW_HIDE = 0
        SW_SHOWNORMAL = 1
        SW_SHOWMINNOACTIVE = 7
        startupinfo.wShowWindow = (
            SW_HIDE
            if use_headless
            else (SW_SHOWNORMAL if force_visible else SW_SHOWMINNOACTIVE)
        )

        cmd = [
            vivaldi_exe,
            "--new-window",
        ]
        if use_headless:
            cmd.extend(
                [
                    "--window-position=-32000,-32000",
                    "--window-size=800,600",
                    "--mute-audio",
                ]
            )
        cmd.append(url)

        mode_label = "hidden background" if use_headless else "non-headless"
        print(f"[automaton] Spawning {mode_label} Vivaldi instance...")
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        proc = subprocess.Popen(
            cmd,
            startupinfo=startupinfo,
            creationflags=creation_flags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        if not force_visible:
            STOP_CLOAKING_EVENT.clear()

            def _cloak_spawned_window(before_set, target_fg):
                GWL_EXSTYLE = -20
                WS_EX_TOOLWINDOW = 0x00000080
                WS_EX_APPWINDOW = 0x00040000
                WS_EX_NOACTIVATE = 0x08000000
                SWP_NOSIZE = 0x0001
                SWP_NOZORDER = 0x0004
                SWP_NOACTIVATE = 0x0010
                SWP_HIDEWINDOW = 0x0080

                cloaked_hwnds = set()
                for _ in range(250):
                    if STOP_CLOAKING_EVENT.is_set():
                        break
                    current_hwnds = _get_chrome_windows()
                    new_hwnds = current_hwnds - before_set
                    for hwnd in new_hwnds:
                        if hwnd not in cloaked_hwnds:
                            cloaked_hwnds.add(hwnd)
                            CLOAKED_HWNDS.add(hwnd)
                            if use_headless:
                                ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                                ex_style = (
                                    ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
                                ) & ~WS_EX_APPWINDOW
                                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)
                                user32.SetWindowPos(
                                    hwnd,
                                    0,
                                    -32000,
                                    -32000,
                                    0,
                                    0,
                                    SWP_NOSIZE
                                    | SWP_NOZORDER
                                    | SWP_NOACTIVATE
                                    | SWP_HIDEWINDOW,
                                )
                                user32.ShowWindow(hwnd, SW_HIDE)
                            else:
                                user32.ShowWindow(hwnd, SW_SHOWMINNOACTIVE)

                            if target_fg and user32.GetForegroundWindow() != target_fg:
                                user32.SetForegroundWindow(target_fg)

                    if cloaked_hwnds:
                        for hwnd in list(cloaked_hwnds):
                            if STOP_CLOAKING_EVENT.is_set():
                                break
                            if use_headless and user32.IsWindowVisible(hwnd):
                                user32.ShowWindow(hwnd, SW_HIDE)
                            if target_fg and user32.GetForegroundWindow() != target_fg:
                                user32.SetForegroundWindow(target_fg)
                    time.sleep(0.015)

            threading.Thread(
                target=_cloak_spawned_window,
                args=(existing_hwnds, prev_fg_hwnd),
                daemon=True,
            ).start()

        return proc

    # Fallback: standard webbrowser open with focus-steal prevention
    print(
        f"[automaton] Vivaldi binary not found; falling back to webbrowser.open(autoraise=False)..."
    )
    webbrowser.open(url, new=2, autoraise=force_visible)
    return None


def UTILS_uncloak_browser_windows_for_relog():
    """
    Unhides the cloaked Vivaldi window when routed to /login so the user can log in
    directly inside the same tab (preserving the sessionStorage class queue [a, b, c, d, e]).
    """
    STOP_CLOAKING_EVENT.set()
    if sys.platform != "win32":
        return
    user32 = ctypes.windll.user32
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000
    WS_EX_NOACTIVATE = 0x08000000
    SW_SHOWNORMAL = 1
    SWP_SHOWWINDOW = 0x0040

    for hwnd in list(CLOAKED_HWNDS):
        if user32.IsWindow(hwnd):
            ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style = (ex_style & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)
            user32.ShowWindow(hwnd, SW_SHOWNORMAL)
            user32.SetWindowPos(hwnd, 0, 160, 100, 900, 700, SWP_SHOWWINDOW)
            user32.SetForegroundWindow(hwnd)


def UTILS_recloak_browser_windows():
    """
    Re-hides the Vivaldi window back into headless/background mode once relog is verified
    and the loop resumes.
    """
    if sys.platform != "win32":
        return
    user32 = ctypes.windll.user32
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000
    WS_EX_NOACTIVATE = 0x08000000
    SW_HIDE = 0
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    SWP_HIDEWINDOW = 0x0080

    for hwnd in list(CLOAKED_HWNDS):
        if user32.IsWindow(hwnd):
            ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ex_style = (ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)
            user32.SetWindowPos(
                hwnd,
                0,
                -32000,
                -32000,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW,
            )
            user32.ShowWindow(hwnd, SW_HIDE)


def UTILS_monitor_browser_for_login_url(server, stop_event):
    """
    Polls the headless CDP endpoint (if active) to check whether any browser tab
    reverted to https://elearning.pnb.ac.id/login while HW_Fetcher / Class_Fetcher runs.
    """
    cdp_url = f"http://127.0.0.1:{HEADLESS_DEBUG_PORT}/json"
    while not stop_event.is_set() and not server.received_event.is_set():
        try:
            with urllib.request.urlopen(cdp_url, timeout=1.0) as resp:
                tabs = json.loads(resp.read().decode("utf-8"))
                for tab in tabs:
                    tab_url = tab.get("url", "")
                    if (
                        tab_url.startswith(LOGIN_URL)
                        and "relog_prompt=1" not in tab_url
                    ):
                        print(
                            f"[automaton] CDP monitor detected redirect to {tab_url}!"
                        )
                        server.received_payload = {
                            "source": "cdp_url_monitor",
                            "status": "login_required",
                            "url": tab_url,
                        }
                        server.received_event.set()
                        return
        except Exception:
            pass
        time.sleep(1.0)


def UTILS_check_tokensrc_in_localstorage():
    """
    Fallback inspection of Vivaldi's Local Storage LevelDB files on disk to check
    whether the key 'tokenscr' or 'tokensrc' exists for elearning.pnb.ac.id.
    """
    candidate_dirs = [
        os.path.expandvars(
            r"%LOCALAPPDATA%\Vivaldi\User Data\Default\Local Storage\leveldb"
        ),
        os.path.join(HEADLESS_PROFILE_DIR, "Default", "Local Storage", "leveldb"),
    ]
    for ldb_dir in candidate_dirs:
        if not os.path.isdir(ldb_dir):
            continue
        try:
            for fname in os.listdir(ldb_dir):
                if not (fname.endswith(".ldb") or fname.endswith(".log")):
                    continue
                fpath = os.path.join(ldb_dir, fname)
                try:
                    with open(fpath, "rb") as f:
                        raw = f.read()
                    if b"elearning.pnb.ac.id" in raw:
                        for k in TOKEN_STORAGE_KEYS:
                            if k.encode("utf-8") in raw or k.encode("utf-16-le") in raw:
                                return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def SEGMENT_prompt_user_relog_and_verify(server):
    """
    Makes the browser non-headless (or spawns a tiny non-headless login window + helper prompt)
    asking the user to log in at https://elearning.pnb.ac.id/login, waits for the user to
    close the login window/prompt, then navigates to https://elearning.pnb.ac.id/mahasiswa/list-class
    to check if 'tokenscr' / 'tokensrc' exists in localStorage.
    """
    print(
        f"[automaton] URL reverted to {LOGIN_URL}. Opening non-headless tiny window for re-login..."
    )
    STOP_CLOAKING_EVENT.set()
    server.relog_closed_event.clear()

    relog_url = f"{LOGIN_URL}?relog_prompt=1"
    vivaldi_exe = UTILS_find_vivaldi_path()
    relog_proc = None
    relog_proc_is_standalone = False
    tracked_relog_hwnds = set()

    if sys.platform == "win32" and vivaldi_exe:
        user32 = ctypes.windll.user32
        GWL_EXSTYLE = -20
        WS_EX_TOOLWINDOW = 0x00000080
        WS_EX_APPWINDOW = 0x00040000
        WS_EX_NOACTIVATE = 0x08000000
        SW_SHOWNORMAL = 1
        SWP_SHOWWINDOW = 0x0040

        # 1. If we already have a cloaked Vivaldi window that bounced to /login, uncloak & resize it
        for hwnd in list(CLOAKED_HWNDS):
            if user32.IsWindow(hwnd):
                ex_style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                ex_style = (ex_style & ~WS_EX_TOOLWINDOW & ~WS_EX_NOACTIVATE) | WS_EX_APPWINDOW
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style)
                user32.ShowWindow(hwnd, SW_SHOWNORMAL)
                user32.SetWindowPos(hwnd, 0, 180, 120, 500, 660, SWP_SHOWWINDOW)
                user32.SetForegroundWindow(hwnd)
                tracked_relog_hwnds.add(hwnd)
        CLOAKED_HWNDS.clear()

        # 2. If no cloaked window was uncloaked, spawn a tiny non-headless login window
        if not tracked_relog_hwnds:
            WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

            def _get_visible_chrome_windows():
                hwnds = set()

                def _cb(hwnd, lparam):
                    if user32.IsWindowVisible(hwnd):
                        cls = ctypes.create_unicode_buffer(256)
                        user32.GetClassNameW(hwnd, cls, 256)
                        if "Chrome_WidgetWin" in cls.value:
                            hwnds.add(hwnd)
                    return True

                user32.EnumWindows(WNDENUMPROC(_cb), 0)
                return hwnds

            before_hwnds = _get_visible_chrome_windows()

            cmd = [
                vivaldi_exe,
                "--new-window",
                f"--app={relog_url}",
                "--window-size=500,660",
                "--window-position=180,120",
            ]
            relog_proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            for _ in range(25):
                time.sleep(0.1)
                after_hwnds = _get_visible_chrome_windows()
                diff = after_hwnds - before_hwnds
                if diff:
                    tracked_relog_hwnds.update(diff)
                    for hwnd in tracked_relog_hwnds:
                        user32.SetWindowPos(hwnd, 0, 180, 120, 500, 660, 0x0004)
                    break

            # Only treat relog_proc as standalone if it is still running after 2.5s
            if relog_proc.poll() is None:
                relog_proc_is_standalone = True
    else:
        webbrowser.open(relog_url, new=1, autoraise=True)

    print("[automaton] Waiting for user to log in and close the login window (or click Done in prompt)...")

    # Show a tiny companion Tkinter window so the user knows to log in and close when ready
    try:
        prompt_root = tk.Tk()
        prompt_root.title("e-Learning Re-Login Required")
        prompt_root.resizable(False, False)
        prompt_root.attributes("-topmost", True)
        prompt_root.configure(bg="#2b2b2b")
        prompt_root.geometry("380x190+700+180")

        lbl = tk.Label(
            prompt_root,
            text=(
                "🔒 Session Token Bounced (/login)\n\n"
                "Please log in to e-Learning in the browser window.\n"
                "Once logged in, close the browser login window\n"
                "(or click 'Logged In / Done' below)."
            ),
            bg="#2b2b2b",
            fg="#ffffff",
            font=("Segoe UI", 10),
            justify="center",
            wraplength=340,
        )
        lbl.pack(pady=(18, 12))

        done_btn = tk.Button(
            prompt_root,
            text="Logged In / Done",
            bg="#4CAF50",
            fg="#ffffff",
            font=("Segoe UI", 10, "bold"),
            relief="flat",
            padx=16,
            pady=6,
            cursor="hand2",
            command=prompt_root.destroy,
        )
        done_btn.pack()

        start_wait = time.time()

        def _poll_relog_state():
            if time.time() - start_wait >= TIMEOUT_SECONDS:
                prompt_root.destroy()
                return
            if server.relog_closed_event.is_set():
                print("[automaton] User closed the login tab/window (reported by browser).")
                prompt_root.destroy()
                return
            if tracked_relog_hwnds and sys.platform == "win32":
                u32 = ctypes.windll.user32
                if all(not u32.IsWindow(h) or not u32.IsWindowVisible(h) for h in tracked_relog_hwnds):
                    print("[automaton] User closed the login window (HWND closed).")
                    prompt_root.destroy()
                    return
            if relog_proc_is_standalone and relog_proc is not None and relog_proc.poll() is not None:
                print("[automaton] Standalone login browser process closed by user.")
                prompt_root.destroy()
                return
            prompt_root.after(300, _poll_relog_state)

        prompt_root.after(500, _poll_relog_state)
        prompt_root.mainloop()
    except Exception as e:
        print(f"[automaton] Fallback wait for login window closure: {e}")
        start_wait = time.time()
        while time.time() - start_wait < TIMEOUT_SECONDS:
            if server.relog_closed_event.is_set():
                break
            if tracked_relog_hwnds and sys.platform == "win32":
                u32 = ctypes.windll.user32
                if all(not u32.IsWindow(h) or not u32.IsWindowVisible(h) for h in tracked_relog_hwnds):
                    break
            if relog_proc_is_standalone and relog_proc is not None and relog_proc.poll() is not None:
                break
            time.sleep(0.5)

    # Now verify login by navigating to https://elearning.pnb.ac.id/mahasiswa/list-class
    # and checking localStorage for 'tokenscr' / 'tokensrc'
    print(
        f"[automaton] Checking login status on {TARGET_URL} (inspecting localStorage keys {TOKEN_STORAGE_KEYS})..."
    )
    server.relog_verify_event.clear()
    server.relog_verified = False
    server.received_payload = None
    server.received_event.clear()

    verify_params = ["verify_auth=1"]
    if UTILS_should_ignore_date():
        verify_params.append("ignore_date=1")
    if UTILS_should_ignore_hw_tokens():
        verify_params.append("ignore_hw_tokens=1")
    if UTILS_should_disable_auto_close():
        verify_params.append("no_auto_close=1")

    sep = "&" if "?" in TARGET_URL else "?"
    verify_url = f"{TARGET_URL}{sep}{'&'.join(verify_params)}"

    verify_proc = UTILS_open_browser_unobtrusive(verify_url)
    verified_signal = server.relog_verify_event.wait(timeout=25)

    is_logged_in = False
    if verified_signal:
        is_logged_in = bool(server.relog_verified)
    else:
        is_logged_in = UTILS_check_tokensrc_in_localstorage()

    if not is_logged_in:
        print(f"[automaton] {RELOG_FAIL_ALERT_MESSAGE}")
        if verify_proc is not None and verify_proc.poll() is None:
            try:
                verify_proc.terminate()
            except Exception:
                pass
        fail_payload = {
            "source": "automaton_relog_fail",
            "status": "relog_failed",
            "whatsappMessage": RELOG_FAIL_ALERT_MESSAGE,
            "message": RELOG_FAIL_ALERT_MESSAGE,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        SEGMENT_trigger_whatsapp_alert(fail_payload)
        print(f"[automaton] Closing port {SERVER_PORT} and force stopping.")
        server.shutdown()
        server.server_close()
        sys.exit(1)

    print(
        f"[automaton] Token {TOKEN_STORAGE_KEYS} found in localStorage! Re-login verified. Continuing homework scrape..."
    )
    return verify_proc


def SEGMENT_trigger_whatsapp_alert(payload):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    payload_file = os.path.join(script_dir, "hw_payload.json")
    alert_script = os.path.join(script_dir, "alert.js")

    print(f"[automaton] Writing payload to {payload_file}...")
    try:
        with open(payload_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[automaton] Failed writing payload file: {e}")
        return False

    print(f"[automaton] Invoking alert.js to forward output to WhatsApp...")
    try:
        # Run node alert.js passing payload_file without popping up a console window
        creation_flags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            if sys.platform == "win32"
            else 0
        )
        result = subprocess.run(
            ["node", alert_script, payload_file],
            cwd=script_dir,
            timeout=120,
            creationflags=creation_flags,
        )
        if result.returncode == 0:
            print("[automaton] alert.js executed successfully.")
            return True
        else:
            print(f"[automaton] alert.js exited with return code {result.returncode}.")
            return False
    except subprocess.TimeoutExpired:
        print("[automaton] alert.js timed out after 120 seconds.")
        return False
    except FileNotFoundError:
        print(
            "[automaton] Error: 'node' executable not found in PATH. Please verify Node.js is installed."
        )
        return False
    except Exception as e:
        print(f"[automaton] Error running alert.js: {e}")
        return False


def SEGMENT_start_pipeline(open_browser=True):
    print(f"[automaton] Starting receiver on {SERVER_HOST}:{SERVER_PORT}...")
    try:
        server = HWReceiverServer((SERVER_HOST, SERVER_PORT), HWReceiverHandler)
    except OSError as e:
        print(f"[automaton] Port {SERVER_PORT} error: {e}")
        print("[automaton] Please ensure no other process is using this port.")
        return

    # Start server in background thread
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(
        f"[automaton] Port {SERVER_PORT} is open and listening for incoming HW_Fetcher output."
    )

    if open_browser:
        target_url = TARGET_URL
        query_params = []
        if UTILS_should_ignore_date():
            query_params.append("ignore_date=1")
        if UTILS_should_ignore_hw_tokens():
            query_params.append("ignore_hw_tokens=1")
        if UTILS_should_disable_auto_close():
            query_params.append("no_auto_close=1")
        if query_params:
            sep = "&" if "?" in target_url else "?"
            target_url = f"{target_url}{sep}{'&'.join(query_params)}"
        print(
            f"[automaton] Launching browser to {target_url} (headless={UTILS_is_headless_mode()})..."
        )
        browser_proc = UTILS_open_browser_unobtrusive(target_url)
    else:
        browser_proc = None
        print("[automaton] Browser launch skipped (listening only).")

    stop_monitor_event = threading.Event()
    if open_browser and UTILS_is_headless_mode():
        threading.Thread(
            target=UTILS_monitor_browser_for_login_url,
            args=(server, stop_monitor_event),
            daemon=True,
        ).start()

    print(
        f"[automaton] Waiting for output from browser userscript (timeout: {TIMEOUT_SECONDS}s)..."
    )
    received = server.received_event.wait(timeout=TIMEOUT_SECONDS)
    stop_monitor_event.set()

    # Clean up headless browser process if it was spawned as a standalone headless instance
    if browser_proc is not None and browser_proc.poll() is None:
        try:
            browser_proc.terminate()
        except Exception:
            pass

    if received and server.received_payload:
        payload = server.received_payload
        count = payload.get("count", len(payload.get("items", [])))
        status = payload.get("status", "unknown")
        print(
            f"[automaton] Output successfully caught on port! Status: {status}, Assignments: {count}"
        )

        if status == "relog_failed":
            fail_payload = {
                "source": "automaton_relog_fail",
                "status": "relog_failed",
                "whatsappMessage": RELOG_FAIL_ALERT_MESSAGE,
                "message": RELOG_FAIL_ALERT_MESSAGE,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            SEGMENT_trigger_whatsapp_alert(fail_payload)
            server.shutdown()
            server.server_close()
            sys.exit(1)

        UTILS_mark_ran_today()

        if status == "skipped":
            if UTILS_should_ignore_date():
                print(
                    "[automaton] Warning: Browser userscript reported 'skipped' (NO_REPEAT_IN_A_DAY / IGNORE_LAST_RUN_DATE in JS)."
                )
            if UTILS_should_disable_auto_close():
                print(
                    "[automaton] Auto-close on repeat is disabled (debugging mode). Keeping process alive until interrupted."
                )
                server.shutdown()
                server.server_close()
                return
            print(
                "[automaton] Script already ran today. Closing port and exiting process."
            )
            server.shutdown()
            server.server_close()
            sys.exit(0)

        # Trigger alert.js to send to WhatsApp
        SEGMENT_trigger_whatsapp_alert(payload)
    else:
        print("[automaton] Timed out waiting for output from browser userscripts.")
        print(
            f"[automaton] Sending timeout report to WhatsApp: {TIMEOUT_ALERT_MESSAGE}"
        )
        timeout_payload = {
            "source": "automaton_timeout",
            "status": "timeout",
            "whatsappMessage": TIMEOUT_ALERT_MESSAGE,
            "message": TIMEOUT_ALERT_MESSAGE,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        SEGMENT_trigger_whatsapp_alert(timeout_payload)

    print(f"[automaton] Closing port {SERVER_PORT}...")
    server.shutdown()
    server.server_close()
    print("[automaton] Pipeline complete.")


def SEGMENT_on_yes(window):
    UTILS_mark_as_scheduled()
    window.destroy()
    SEGMENT_start_pipeline(open_browser=True)


def SEGMENT_on_no(window):
    window.destroy()
    webbrowser.open(TASK_SCHEDULER_GUIDE_URL)
    print(
        "[!] Opened Task Scheduler guide. Please set it up and run this script again."
    )


def SEGMENT_show_reminder():
    root = tk.Tk()
    root.title(WINDOW_TITLE)
    root.resizable(False, False)

    UTILS_center_window(root, 520, 420)

    root.configure(bg="#2b2b2b")

    # --- icon label ---
    icon_label = tk.Label(
        root, text="📋", font=("Segoe UI Emoji", 36), bg="#2b2b2b", fg="#ffcc00"
    )
    icon_label.pack(pady=(20, 0))

    # --- reminder text ---
    text_font = tkfont.Font(family="Segoe UI", size=11)
    text_label = tk.Label(
        root,
        text=REMINDER_TEXT,
        font=text_font,
        bg="#2b2b2b",
        fg="#ffffff",
        wraplength=460,
        justify="center",
    )
    text_label.pack(pady=(10, 20))

    # --- button frame ---
    button_frame = tk.Frame(root, bg="#2b2b2b")
    button_frame.pack(pady=(0, 20))

    btn_font = tkfont.Font(family="Segoe UI", size=10, weight="bold")

    # --- yes button ---
    yes_btn = tk.Button(
        button_frame,
        text="Done.",
        font=btn_font,
        bg="#4CAF50",
        fg="#ffffff",
        activebackground="#45a049",
        activeforeground="#ffffff",
        relief="flat",
        padx=20,
        pady=8,
        cursor="hand2",
        command=lambda: SEGMENT_on_yes(root),
    )
    yes_btn.pack(side="left", padx=15)

    # --- no button ---
    no_btn = tk.Button(
        button_frame,
        text="Idk how.",
        font=btn_font,
        bg="#f44336",
        fg="#ffffff",
        activebackground="#da190b",
        activeforeground="#ffffff",
        relief="flat",
        padx=20,
        pady=8,
        cursor="hand2",
        command=lambda: SEGMENT_on_no(root),
    )
    no_btn.pack(side="left", padx=15)

    root.mainloop()


def UTILS_ensure_background_process():
    """
    If RUN_IN_BACKGROUND_DAEMON is True or '--daemon' / '--bg' is passed, re-spawns
    automaton.py detached in the background with CREATE_NO_WINDOW and exits the foreground
    launcher immediately so the user's terminal or desktop is never blocked.
    """
    if sys.platform != "win32":
        return
    if "--_bg_child" in sys.argv:
        return
    if not (RUN_IN_BACKGROUND_DAEMON or "--daemon" in sys.argv or "--bg" in sys.argv):
        return

    args = [a for a in sys.argv[1:] if a not in ("--daemon", "--bg")] + ["--_bg_child"]
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = pythonw if os.path.exists(pythonw) else sys.executable
    creation_flags = (
        getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    )
    log_path = os.path.join(SCRIPT_DIR, "automaton_bg.log")
    log_file = open(log_path, "a", encoding="utf-8")
    subprocess.Popen(
        [exe, os.path.abspath(__file__)] + args,
        cwd=SCRIPT_DIR,
        creationflags=creation_flags,
        stdout=log_file,
        stderr=log_file,
        stdin=subprocess.DEVNULL,
    )
    print(f"[automaton] Spawned headless background process (logging to {log_path}).")
    sys.exit(0)


# --- entry point ---
if __name__ == "__main__":
    UTILS_ensure_background_process()
    if "--listen" in sys.argv:
        # Test mode: listen on port without launching browser
        SEGMENT_start_pipeline(open_browser=False)
    elif "--test-alert" in sys.argv:
        # Test mode: trigger alert.js with sample test homework payload
        test_payload = {
            "source": "manual_test",
            "status": "success",
            "count": 1,
            "items": [
                {
                    "className": "Testing Class",
                    "hw_name": "Verify WhatsApp & Port Pipeline Integration",
                    "cleanDate": "Due 2026-10-25 23:59:00",
                    "daysDiff": 2,
                    "label": "🔴",
                }
            ],
            "timestamp": "2026-10-20T15:00:00Z",
        }
        print("[automaton] Running test alert...")
        SEGMENT_trigger_whatsapp_alert(test_payload)
    else:
        if UTILS_has_already_run_today():
            if UTILS_should_disable_auto_close():
                print(
                    "[automaton] Already ran today, but auto-close is disabled (debugging mode). Continuing..."
                )
            else:
                print("[automaton] Already ran today. Closing process automatically.")
                sys.exit(0)

        if UTILS_has_been_scheduled():
            SEGMENT_start_pipeline(open_browser=True)
        else:
            SEGMENT_show_reminder()
