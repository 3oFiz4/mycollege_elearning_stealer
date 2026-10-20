import os
import sys
import json
import time
import threading
import subprocess
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
import tkinter as tk
from tkinter import font as tkfont

# --- config ---
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 5005
TARGET_URL = "https://elearning.pnb.ac.id/mahasiswa/list-class"
WINDOW_TITLE = "read me for a sec"
FLAG_FILE = ".hw_notifier_scheduled"
TASK_SCHEDULER_GUIDE_URL = "https://www.windowscentral.com/how-create-automated-task-using-task-scheduler-windows-10"
TIMEOUT_SECONDS = 300  # 5 minutes wait for browser to finish

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
            print(f"\n[automaton] Successfully received payload on port {SERVER_PORT}!")
            count = payload.get("count", len(payload.get("items", [])))
            print(f"[automaton] Payload contains {count} item(s) from source '{payload.get('source', 'unknown')}'.")

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
        print(f"[automaton-port-{SERVER_PORT}] {self.address_string()} - {format % args}")


class HWReceiverServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass):
        super().__init__(server_address, RequestHandlerClass)
        self.received_payload = None
        self.received_event = threading.Event()


def UTILS_center_window(window, width, height):
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width // 2) - (width // 2)
    y = (screen_height // 2) - (height // 2)
    window.geometry(f"{width}x{height}+{x}+{y}")


def UTILS_has_been_scheduled():
    return os.path.exists(FLAG_FILE)


def UTILS_mark_as_scheduled():
    with open(FLAG_FILE, "w") as f:
        f.write("scheduled")


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
        # Run node alert.js passing payload_file
        result = subprocess.run(
            ["node", alert_script, payload_file],
            cwd=script_dir,
            timeout=120
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
        print("[automaton] Error: 'node' executable not found in PATH. Please verify Node.js is installed.")
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
    print(f"[automaton] Port {SERVER_PORT} is open and listening for incoming HW_Fetcher output.")

    if open_browser:
        print(f"[automaton] Launching browser to {TARGET_URL}...")
        webbrowser.open(TARGET_URL)
    else:
        print("[automaton] Browser launch skipped (listening only).")

    print(f"[automaton] Waiting for output from browser userscript (timeout: {TIMEOUT_SECONDS}s)...")
    received = server.received_event.wait(timeout=TIMEOUT_SECONDS)

    if received and server.received_payload:
        payload = server.received_payload
        count = payload.get("count", len(payload.get("items", [])))
        status = payload.get("status", "unknown")
        print(f"[automaton] Output successfully caught on port! Status: {status}, Assignments: {count}")

        # Trigger alert.js to send to WhatsApp
        SEGMENT_trigger_whatsapp_alert(payload)
    else:
        print("[automaton] Timed out waiting for output from browser userscripts.")

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


# --- entry point ---
if __name__ == "__main__":
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
                    "label": "🔴"
                }
            ],
            "timestamp": "2026-10-20T15:00:00Z"
        }
        print("[automaton] Running test alert...")
        SEGMENT_trigger_whatsapp_alert(test_payload)
    else:
        if UTILS_has_been_scheduled():
            SEGMENT_start_pipeline(open_browser=True)
        else:
            SEGMENT_show_reminder()
