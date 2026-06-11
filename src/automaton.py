import webbrowser
import tkinter as tk
from tkinter import font as tkfont

# --- config ---
TARGET_URL = "https://elearning.pnb.ac.id/mahasiswa/list-class"
WINDOW_TITLE = "read me for a sec"
FLAG_FILE = ".hw_notifier_scheduled"
TASK_SCHEDULER_GUIDE_URL = "https://www.windowscentral.com/how-create-automated-task-using-task-scheduler-windows-10"

REMINDER_TEXT = (
    "Hey! It looks like you haven't set up Task Scheduler yet.\n\n"
    "To make this script run automatically every day, as long as this PC open\n"
    "you need to add it to Windows Task Scheduler.\n"
    "Have you already done this before?\n\n"
    "If you have, please set this python file to be open as long as PC opened, and then click this green button so this message won't appear next time it ran.\n"
    "If you haven't, click the red button\n"
)


def UTILS_center_window(window, width, height):
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width // 2) - (width // 2)
    y = (screen_height // 2) - (height // 2)
    window.geometry(f"{width}x{height}+{x}+{y}")


def UTILS_has_been_scheduled():
    import os

    return os.path.exists(FLAG_FILE)


def UTILS_mark_as_scheduled():
    with open(FLAG_FILE, "w") as f:
        f.write("scheduled")


def SEGMENT_open_browser():
    webbrowser.open(TARGET_URL)


def SEGMENT_on_yes(window):
    UTILS_mark_as_scheduled()
    window.destroy()
    SEGMENT_open_browser()


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
    if UTILS_has_been_scheduled():
        SEGMENT_open_browser()
    else:
        SEGMENT_show_reminder()
