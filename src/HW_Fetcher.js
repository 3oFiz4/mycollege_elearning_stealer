// ==UserScript==
// @name         HW Fetcher
// @namespace    http://tampermonkey.net/
// @version      2026-04-23
// @description  Expose a bunch of Homework list with their deadline and origin schedule via HTTP POST to Discord WebHook and WhatsApp
// @author       3oFiz4
// @match        https://elearning.pnb.ac.id/mahasiswa/class/detail/work?class=*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ac.id
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @grant        GM_xmlhttpRequest
// @grant        window.close
// @connect      discord.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      target-site.com
// @noframes
// ==/UserScript==

(function () {
  const NO_REPEAT_IN_A_DAY = true;
  const STORAGE_KEY_LAST_RUN = "__HW_NOTIFIER_LAST_RUN_DATE__";

  function UTILS_hasAlreadyRunToday() {
    if (!NO_REPEAT_IN_A_DAY) return false;
    const lastRun = localStorage.getItem(STORAGE_KEY_LAST_RUN);
    if (!lastRun) return false;
    const today = new Date().toDateString();
    return lastRun === today;
  }

  let CLASS_DICTIONARY = {};
  const seen = new Set();
  let WEBHOOK_SENT = false;

  // Config (you can modify this variable)
  const WEBHOOK_URL =
    "https://discord.com/api/webhooks/1503018580235653230/e2hjAlMXmf_YpSpgauik1alpPs_IyFsU-qmRVatyTptXfSzuZwp3lMY6g34Pjikv1pW5";
  const LOCAL_PORT_URL = "http://127.0.0.1:5005/output";

  // --- Deadline Filter Config ---
  // If false: only detect upcoming deadlines (ignores deadlines that already passed behind)
  // If true: detect all deadlines even if they already passed behind
  const DETECT_PAST_DEADLINES = true;

  // --- Delay / Timing Config (in milliseconds) ---
  const INITIAL_PAGE_LOAD_DELAY = 300; // Delay before starting extraction after work page loads
  const DOM_WAIT_RETRY_DELAY = 200; // Interval between checking if DOM/URL matches expected class
  const DOM_WAIT_MAX_RETRIES = 5; // Max attempts waiting for DOM/URL to match
  const PAGE_RETRY_DELAY = 200; // Delay before retrying expansion panel search
  const PAGE_RETRY_LIMIT = 3; // Max retries for panels to appear
  const NAVIGATE_DELAY = 200; // Delay before navigating to the next class in queue
  const CLOSE_TAB_DELAY = 100; // Delay before closing tab when queue finishes
  const LOCAL_PORT_TIMEOUT = 5000; // Timeout for GM_xmlhttpRequest to local port

  // --- shared session keys ---
  const SESSION_KEY_QUEUE = "__HW_NOTIFIER_QUEUE__";
  const SESSION_KEY_INDEX = "__HW_NOTIFIER_INDEX__";
  const SESSION_KEY_ACTIVE = "__HW_NOTIFIER_ACTIVE__";
  const SESSION_KEY_CURRENT_CLASS = "__HW_NOTIFIER_CURRENT_CLASS__";
  const SESSION_KEY_CLASS_DICTIONARY = "__HW_NOTIFIER_CLASS_DICTIONARY__";
  const SESSION_KEY_DONE = "__HW_NOTIFIER_DONE__";
  const SESSION_KEY_COLLECTED_HW = "__HW_NOTIFIER_COLLECTED_HW__";

  // --- per-page state ---
  let PAGE_RETRY_COUNTER = 0;

  function UTILS_parseDueDate(text) {
    const match = text.match(/Due\s(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
    if (!match) return null;
    return new Date(match[1].replace(" ", "T"));
  }

  function UTILS_getDateDifference(targetDate) {
    const now = new Date();
    const diffMs = targetDate - now;
    return diffMs / (1000 * 60 * 60 * 24);
  }

  function UTILS_fetchPage(url) {
    window.location.href = url;
  }

  function UTILS_webhookPOST(content) {
    const webhookURL = WEBHOOK_URL;

    return new Promise(function (resolve) {
      $.ajax({
        url: webhookURL,
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ content: content }),
        success: function (response) {
          console.log("[HW_Fetcher] Webhook sent successfully.");
          resolve(true);
        },
        error: function (xhr) {
          if (xhr.status === 429) {
            const retryAfter = JSON.parse(xhr.responseText).retry_after || 2;
            console.warn(
              "[HW_Fetcher] Rate limited. Retrying after " +
                retryAfter +
                "s...",
            );
            setTimeout(function () {
              UTILS_webhookPOST(content).then(resolve);
            }, retryAfter * 1000);
          } else {
            console.warn(
              "[HW_Fetcher] Webhook error:",
              xhr.status,
              xhr.responseText,
            );
            resolve(false);
          }
        },
      });
    });
  }

  function UTILS_sendToLocalPort(payload) {
    const localUrl = LOCAL_PORT_URL;
    const dataString = JSON.stringify(payload);

    return new Promise(function (resolve) {
      console.log(
        "[HW_Fetcher] Sending output to local port at " + localUrl + "...",
      );

      // Try GM_xmlhttpRequest if available (bypasses browser mixed-content and CORS restrictions)
      if (typeof GM_xmlhttpRequest === "function") {
        try {
          GM_xmlhttpRequest({
            method: "POST",
            url: localUrl,
            headers: {
              "Content-Type": "application/json",
            },
            data: dataString,
            timeout: LOCAL_PORT_TIMEOUT,
            onload: function (response) {
              console.log(
                "[HW_Fetcher] Successfully communicated with local port:",
                response.status,
                response.responseText,
              );
              resolve(true);
            },
            onerror: function (err) {
              console.warn(
                "[HW_Fetcher] GM_xmlhttpRequest error sending to local port, trying fetch fallback...",
                err,
              );
              fallbackFetch();
            },
            ontimeout: function () {
              console.warn(
                "[HW_Fetcher] GM_xmlhttpRequest timed out, trying fetch fallback...",
              );
              fallbackFetch();
            },
          });
          return;
        } catch (e) {
          console.warn("[HW_Fetcher] Exception calling GM_xmlhttpRequest:", e);
        }
      }

      fallbackFetch();

      function fallbackFetch() {
        fetch(localUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: dataString,
        })
          .then(function (res) {
            console.log(
              "[HW_Fetcher] Successfully communicated with local port via fetch:",
              res.status,
            );
            resolve(true);
          })
          .catch(function (err) {
            console.warn(
              "[HW_Fetcher] Failed communicating with local port via fetch:",
              err,
            );
            resolve(false);
          });
      }
    });
  }

  function UTILS_formatWhatsAppMessage(items) {
    if (!items || items.length === 0) {
      return (
        "🎉 *PENGINGAT TUGAS E-LEARNING*\n\n" +
        "Tidak ada tugas yang pending hari ini. Santai dulu! ✨"
      );
    }

    const todayStr = new Date().toLocaleDateString("id-ID", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const hasUrgent = items.some(function (hw) {
      return Number(hw.daysDiff) <= 1;
    });
    const tagHeader = hasUrgent
      ? "@everyone 🚨 *PERINGATAN DEADLINE DEKAT!* 🚨\n\n"
      : "";

    let msg = tagHeader;
    msg += "📚 *PENGINGAT TUGAS E-LEARNING* 📚\n";
    msg += `📅 ${todayStr}\n`;
    msg += "━━━━━━━━━━━━━━━━━━━━━\n\n";

    items.forEach(function (hw, i) {
      let urgencyEmoji = "⚪";
      if (hw.daysDiff <= 0) {
        const passedDays = Math.abs(hw.daysDiff);
        urgencyEmoji =
          passedDays === 0
            ? "⚠️ *TELAH BERAKHIR HARI INI*"
            : `⚠️ *TELAH LEWAT ${passedDays} HARI*`;
      } else if (hw.daysDiff <= 1) {
        urgencyEmoji = "🚨 *HARI INI / BESOK* (Segera kumpulkan!)";
      } else if (hw.daysDiff <= 2) {
        urgencyEmoji = "🔴 *2 hari lagi*";
      } else if (hw.daysDiff <= 3) {
        urgencyEmoji = "🟠 *3 hari lagi*";
      } else if (hw.daysDiff <= 5) {
        urgencyEmoji = "🟢 *5 hari lagi*";
      } else {
        urgencyEmoji = "⚪ *" + hw.daysDiff + " hari lagi*";
      }

      msg += `*${i + 1}. ${hw.className}*\n`;
      msg += `> 📝 *Tugas:* ${hw.hw_name}\n`;
      msg += `> ⏰ *${hw.cleanDate}*\n`;
      msg += `> Sisa Waktu: ${urgencyEmoji}\n\n`;
    });

    msg += "━━━━━━━━━━━━━━━━━━━━━\n";
    msg += `Total: *${items.length}* tugas terdeteksi.\n`;
    msg += "_Notifikasi otomatis dikirim via E-Learning Stealer_";

    return msg;
  }

  function UTILS_sendMessagesSequentially(messages, delayMs) {
    let chain = Promise.resolve();
    messages.forEach(function (msg) {
      chain = chain
        .then(function () {
          return UTILS_webhookPOST(msg);
        })
        .then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, delayMs);
          });
        });
    });
    return chain;
  }

  function UTILS_setSessionJSON(key, value) {
    sessionStorage.setItem(key, JSON.stringify(value));
  }

  function UTILS_getSessionJSON(key, fallbackValue) {
    try {
      const rawValue = sessionStorage.getItem(key);
      return rawValue ? JSON.parse(rawValue) : fallbackValue;
    } catch (error) {
      console.warn(
        "[HW_Fetcher] Failed parsing sessionStorage key:",
        key,
        error,
      );
      return fallbackValue;
    }
  }

  function UTILS_removeSessionKeys(keys) {
    keys.forEach(function (key) {
      sessionStorage.removeItem(key);
    });
  }

  function UTILS_isQueueActive() {
    return sessionStorage.getItem(SESSION_KEY_ACTIVE) === "1";
  }

  function UTILS_isWorkPage() {
    return window.location.pathname.includes("mahasiswa/class/detail/work");
  }

  function UTILS_waitForFreshDOM(
    expectedClassNumber,
    callback,
    maxRetries,
    retryDelay,
  ) {
    let attempts = 0;
    maxRetries = maxRetries || DOM_WAIT_MAX_RETRIES;
    retryDelay = retryDelay || DOM_WAIT_RETRY_DELAY;

    function check() {
      attempts++;
      const currentUrl = window.location.href;
      const urlMatch = currentUrl.includes("class=" + expectedClassNumber);

      if (!urlMatch) {
        console.log(
          "[HW_Fetcher] URL doesn't match expected class yet, retry " +
            attempts +
            "/" +
            maxRetries,
        );
        if (attempts < maxRetries) {
          setTimeout(check, retryDelay);
        } else {
          console.warn("[HW_Fetcher] URL never matched. Skipping.");
          callback(false);
        }
        return;
      }

      callback(true);
    }

    check();
  }

  function UTILS_markClassDone(currentClass) {
    if (!currentClass) return;
    const doneList = UTILS_getSessionJSON(SESSION_KEY_DONE, []);
    const classNumber = String(currentClass.class_number);
    if (!doneList.includes(classNumber)) {
      doneList.push(classNumber);
      UTILS_setSessionJSON(SESSION_KEY_DONE, doneList);
    }
  }

  function UTILS_isClassDone(currentClass) {
    if (!currentClass) return false;
    const doneList = UTILS_getSessionJSON(SESSION_KEY_DONE, []);
    return doneList.includes(String(currentClass.class_number));
  }

  function UTILS_finishQueue() {
    if (WEBHOOK_SENT) return;
    WEBHOOK_SENT = true;

    console.log(
      "[HW_Fetcher] All classes processed. Sending collected HW to webhook & local port...",
    );

    const collectedHW = UTILS_getSessionJSON(SESSION_KEY_COLLECTED_HW, []);

    let fullDiscordMessage = "";
    if (collectedHW.length > 0) {
      const lines = collectedHW.map(function (hw, i) {
        const labelText = hw.label ? hw.label + " " : "";
        return (
          "**" +
          (i + 1) +
          ".** __" +
          hw.className +
          "__\n" +
          "> " +
          hw.hw_name +
          "\n" +
          "> **Deadline**: " +
          hw.cleanDate +
          " (" +
          labelText +
          hw.daysDiff +
          " day(s) left)"
        );
      });
      fullDiscordMessage = lines.join("\n\n");
    }

    const payload = {
      source: "HW_Fetcher",
      status: "success",
      count: collectedHW.length,
      items: collectedHW,
      discordMessage: fullDiscordMessage,
      whatsappMessage: UTILS_formatWhatsAppMessage(collectedHW),
      timestamp: new Date().toISOString(),
    };

    const tasks = [];

    // 1. Send output to local port (for automaton.py and alert.js)
    tasks.push(UTILS_sendToLocalPort(payload));

    // 2. Send output to Discord webhook if there is homework
    if (collectedHW.length > 0 && fullDiscordMessage) {
      tasks.push(UTILS_webhookPOST(fullDiscordMessage));
    } else {
      console.log("[HW_Fetcher] No homework to send to Discord webhook.");
    }

    Promise.all(tasks).then(function () {
      console.log("[HW_Fetcher] Notifications dispatched. Queue complete.");
      localStorage.setItem(STORAGE_KEY_LAST_RUN, new Date().toDateString());
      UTILS_removeSessionKeys([
        SESSION_KEY_QUEUE,
        SESSION_KEY_INDEX,
        SESSION_KEY_ACTIVE,
        SESSION_KEY_CURRENT_CLASS,
        SESSION_KEY_CLASS_DICTIONARY,
        SESSION_KEY_DONE,
        SESSION_KEY_COLLECTED_HW,
      ]);
      UTILS_closeTab();
    });
  }

  // --- advance to next class in queue ---
  function SEGMENT_runQueueStep() {
    const queue = UTILS_getSessionJSON(SESSION_KEY_QUEUE, []);
    const currentIndex = parseInt(
      sessionStorage.getItem(SESSION_KEY_INDEX) || "0",
      10,
    );
    const nextIndex = currentIndex + 1;

    if (nextIndex >= queue.length) {
      UTILS_finishQueue();
      return;
    }

    sessionStorage.setItem(SESSION_KEY_INDEX, String(nextIndex));

    const nextClass = queue[nextIndex];
    UTILS_setSessionJSON(SESSION_KEY_CURRENT_CLASS, nextClass);

    console.log(
      "[HW_Fetcher] Advancing to class " +
        (nextIndex + 1) +
        "/" +
        queue.length +
        ":",
      nextClass.className,
    );

    setTimeout(function () {
      UTILS_fetchPage(nextClass.class_hw_url);
    }, NAVIGATE_DELAY);
  }

  // --- collect deadlines from current page and post to webhook ---
  function SEGMENT_getDeadline() {
    if (!UTILS_isWorkPage()) return;
    if (!UTILS_isQueueActive()) return;

    const currentClass = UTILS_getSessionJSON(SESSION_KEY_CURRENT_CLASS, null);

    if (!currentClass) {
      console.warn(
        "[HW_Fetcher] No current class in sessionStorage, skipping.",
      );
      return;
    }

    if (UTILS_isClassDone(currentClass)) {
      console.log(
        "[HW_Fetcher] Class already done, advancing:",
        currentClass.className,
      );
      SEGMENT_runQueueStep();
      return;
    }

    const queue = UTILS_getSessionJSON(SESSION_KEY_QUEUE, []);
    const currentIndex = parseInt(
      sessionStorage.getItem(SESSION_KEY_INDEX) || "0",
      10,
    );

    console.log(
      "[HW_Fetcher] Processing class " +
        (currentIndex + 1) +
        "/" +
        queue.length +
        ": " +
        currentClass.className,
    );

    UTILS_waitForFreshDOM(currentClass.class_number, function (urlReady) {
      if (!urlReady) {
        UTILS_markClassDone(currentClass);
        SEGMENT_runQueueStep();
        return;
      }

      SEGMENT_collectPanels(currentClass);
    });
  }

  function SEGMENT_collectPanels(currentClass) {
    let panels = $(".v-expansion-panel:visible");
    if (!panels.length) {
      panels = $(".v-expansion-panel");
    }

    if (!panels.length) {
      PAGE_RETRY_COUNTER++;
      if (PAGE_RETRY_COUNTER <= PAGE_RETRY_LIMIT) {
        console.log(
          "[HW_Fetcher] Panels not found, retrying " +
            PAGE_RETRY_COUNTER +
            "/" +
            PAGE_RETRY_LIMIT +
            "...",
        );
        setTimeout(function () {
          SEGMENT_collectPanels(currentClass);
        }, PAGE_RETRY_DELAY);
        return;
      }
      console.log(
        "[HW_Fetcher] No panels after retries for: " + currentClass.className,
      );
      PAGE_RETRY_COUNTER = 0;
      UTILS_markClassDone(currentClass);
      SEGMENT_runQueueStep();
      return;
    }

    PAGE_RETRY_COUNTER = 0;
    const className = currentClass.className || "Unknown Class";
    const collectedHW = UTILS_getSessionJSON(SESSION_KEY_COLLECTED_HW, []);
    let addedCount = 0;

    console.log(
      "[HW_Fetcher] Found " + panels.length + " panel(s) for: " + className,
    );

    panels.each(function () {
      const panel = $(this);
      const hw_date = panel.find(".text-right").text().trim();
      const hw_name = panel
        .find("div > div:nth-child(2) > div")
        .first()
        .text()
        .trim();

      if (!hw_name || !hw_date) return;

      const cleanDate = hw_date.replace(/\s+/g, " ").trim();

      // --- skip posted items ---
      if (/posted/i.test(cleanDate)) return;

      // --- must contain Due ---
      if (!/due/i.test(cleanDate)) return;

      const dueDate = UTILS_parseDueDate(cleanDate);
      if (!dueDate || isNaN(dueDate.getTime())) return;

      const daysDiffRaw = UTILS_getDateDifference(dueDate);
      if (!DETECT_PAST_DEADLINES && daysDiffRaw <= 0) return;

      const daysDiff = Math.ceil(daysDiffRaw);

      // --- deduplicate ---
      const isDuplicate = collectedHW.some(function (existing) {
        return (
          existing.hw_name === hw_name &&
          existing.cleanDate === cleanDate &&
          existing.className === className
        );
      });
      if (isDuplicate) return;

      let label = "";
      if (daysDiff <= 0) {
        label = ":skull: (Sudah Lewat)";
      } else if (daysDiff <= 1) {
        label = ":hot_face: <@&1519690716278816793>";
      } else if (daysDiff <= 2) {
        label = ":red_circle: <@&1519690716278816793>";
      } else if (daysDiff <= 3) {
        label = ":orange_circle: <@&1519690638814347407>";
      } else if (daysDiff <= 5) {
        label = ":green_circle: <@&1519690554328485949>";
      } else if (daysDiff <= 7) {
        label = ":white_cirlce: <@&1519690471683657789>";
      }

      const entry = {
        className: className,
        hw_name: hw_name,
        cleanDate: cleanDate,
        daysDiff: daysDiff,
        label: label,
      };

      console.log("DEBUG:", entry);
      collectedHW.push(entry);
      addedCount++;
    });

    UTILS_setSessionJSON(SESSION_KEY_COLLECTED_HW, collectedHW);
    console.log(
      "[HW_Fetcher] Added " +
        addedCount +
        " item(s) for: " +
        className +
        " (total: " +
        collectedHW.length +
        ")",
    );

    UTILS_markClassDone(currentClass);
    SEGMENT_runQueueStep();
  }

  function UTILS_closeTab() {
    console.log("[HW_Fetcher] Closing tab...");
    setTimeout(function () {
      window.close();
      // fallback: if window.close() fails due to browser security
      if (!window.closed) {
        console.log(
          "[HW_Fetcher] Could not close tab automatically. Please close manually.",
        );
      }
    }, CLOSE_TAB_DELAY);
  }

  // --- entry point ---
  window.addEventListener("load", () => {
    if (!UTILS_isWorkPage()) return;
    if (!UTILS_isQueueActive()) return;

    if (UTILS_hasAlreadyRunToday()) {
      console.log(
        "%c[HW_Fetcher] Already ran today. Skipping.",
        "background: #0f0; color: #fff",
      );
      UTILS_sendToLocalPort({
        source: "HW_Fetcher",
        status: "skipped",
        count: 0,
        items: [],
        message: "HW_Fetcher already ran today.",
      }).then(function () {
        UTILS_closeTab();
      });
      return;
    } else {
      console.log(
        `%c[HW_Fetcher] OBSERVING...`,
        "background: #f00; color: #fff",
      );
      console.log(
        "[HW_Fetcher] Work page detected, queue is active. Waiting for DOM...",
      );
    }
    setTimeout(SEGMENT_getDeadline, INITIAL_PAGE_LOAD_DELAY);
  });
})();
