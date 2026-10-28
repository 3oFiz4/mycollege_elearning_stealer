// ==UserScript==
// @name         Class Fetcher
// @namespace    http://tampermonkey.net/
// @version      2026-04-23
// @description  Expose a bunch of Homework list with their deadline and origin schedule via HTTP POST to Discord WebHook and WhatsApp
// @author       3oFiz4
// @match        https://elearning.pnb.ac.id/mahasiswa/list-class*
// @match        https://elearning.pnb.ac.id/login*
// @match        https://elearning.pnb.ac.id/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ac.id
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @grant        GM_xmlhttpRequest
// @grant        window.close
// @connect      127.0.0.1
// @connect      localhost
// @connect      target-site.com
// @noframes
// ==/UserScript==

// this script only runs for my college elearning lol.
// this is not meant for others to use.
// but for others to learn how it works
// that is.. inject and inspecting Vue.js-made website.
(function () {
  const NO_REPEAT_IN_A_DAY = true;
  const IGNORE_LAST_RUN_DATE = false; // Set to true for debugging to ignore the date in memory
  const IGNORE_HW_TOKENS = false; // Set to true for debugging to ignore all __HW_NOTIFIER_* tokens
  const DISABLE_AUTO_CLOSE_ON_REPEAT = false; // Set to true to disable automatic tab/process close when already ran today
  const STORAGE_KEY_LAST_RUN = "__HW_NOTIFIER_LAST_RUN_DATE__";
  const TOKEN_STORAGE_KEYS = ["tokenscr", "tokensrc"];
  const LOGIN_URL_PREFIX = "https://elearning.pnb.ac.id/login";
  const LIST_CLASS_URL = "https://elearning.pnb.ac.id/mahasiswa/list-class";
  const LOCAL_PORT_URL = "http://127.0.0.1:5005/output";
  const RELOG_WAIT_MS = 30000; // Wait at least 30 seconds for user to log in

  // --- relog state session keys ---
  const SESSION_KEY_WAITING_RELOG = "__HW_NOTIFIER_WAITING_RELOG__";
  const SESSION_KEY_RELOG_START_TS = "__HW_NOTIFIER_RELOG_START_TS__";
  const SESSION_KEY_RESUME_URL = "__HW_NOTIFIER_RESUME_URL__";
  const SESSION_KEY_TESTING_RELOG = "__HW_NOTIFIER_TESTING_RELOG__";

  function UTILS_shouldIgnoreHwTokens() {
    if (
      IGNORE_HW_TOKENS ||
      IGNORE_LAST_RUN_DATE ||
      window.location.search.includes("ignore_hw_tokens=1") ||
      window.location.search.includes("ignore_date=1") ||
      sessionStorage.getItem("__HW_NOTIFIER_IGNORE_TOKENS__") === "1" ||
      sessionStorage.getItem("__HW_NOTIFIER_IGNORE_DATE__") === "1"
    ) {
      sessionStorage.setItem("__HW_NOTIFIER_IGNORE_TOKENS__", "1");
      sessionStorage.setItem("__HW_NOTIFIER_IGNORE_DATE__", "1");
      return true;
    }
    return false;
  }

  function UTILS_shouldDisableAutoClose() {
    if (
      DISABLE_AUTO_CLOSE_ON_REPEAT ||
      window.location.search.includes("no_auto_close=1") ||
      sessionStorage.getItem("__HW_NOTIFIER_NO_AUTO_CLOSE__") === "1"
    ) {
      sessionStorage.setItem("__HW_NOTIFIER_NO_AUTO_CLOSE__", "1");
      return true;
    }
    return false;
  }

  function UTILS_clearAllHwTokens() {
    const prefixes = ["__HW_", "HW_LAST_"];
    [localStorage, sessionStorage].forEach(function (store) {
      const toRemove = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (
          k &&
          k !== "__HW_NOTIFIER_IGNORE_TOKENS__" &&
          k !== "__HW_NOTIFIER_IGNORE_DATE__" &&
          k !== "__HW_NOTIFIER_NO_AUTO_CLOSE__" &&
          prefixes.some(function (p) {
            return k.indexOf(p) === 0;
          })
        ) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(function (k) {
        store.removeItem(k);
      });
    });
  }

  function UTILS_hasAlreadyRunToday() {
    if (UTILS_shouldIgnoreHwTokens() || !NO_REPEAT_IN_A_DAY) {
      return false;
    }
    const lastRun = localStorage.getItem(STORAGE_KEY_LAST_RUN);
    if (!lastRun) return false;
    const today = new Date().toDateString();
    return lastRun === today;
  }

  function UTILS_hasValidTokenAuth() {
    for (let i = 0; i < TOKEN_STORAGE_KEYS.length; i++) {
      const val = localStorage.getItem(TOKEN_STORAGE_KEYS[i]);
      if (val && String(val).trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function UTILS_isLoginUrl(url) {
    const target = url || window.location.href;
    return (
      target.indexOf(LOGIN_URL_PREFIX) === 0 ||
      window.location.pathname.indexOf("/login") === 0
    );
  }

  function UTILS_isListClassPage() {
    return window.location.pathname.indexOf("/mahasiswa/list-class") === 0;
  }

  function UTILS_markRanToday() {
    localStorage.setItem(STORAGE_KEY_LAST_RUN, new Date().toDateString());
  }

  if (window.__HW_NOTIFIER_CLASS_FETCHER_LOADED__) return;
  window.__HW_NOTIFIER_CLASS_FETCHER_LOADED__ = true;

  const class_list_element_grid = "div.container.my-5 .v-card";
  const class_link_element = ".v-toolbar__title a";
  const class_homework_url =
    "https://elearning.pnb.ac.id/mahasiswa/class/detail/work?<CLASS_NUMBER>";
  const fetchClassNumberRegexPattern = /class=(\d+)/;
  let CLASS_DICTIONARY = {};

  // --- shared session keys ---
  const SESSION_KEY_QUEUE = "__HW_NOTIFIER_QUEUE__";
  const SESSION_KEY_INDEX = "__HW_NOTIFIER_INDEX__";
  const SESSION_KEY_ACTIVE = "__HW_NOTIFIER_ACTIVE__";
  const SESSION_KEY_CURRENT_CLASS = "__HW_NOTIFIER_CURRENT_CLASS__";
  const SESSION_KEY_CLASS_DICTIONARY = "__HW_NOTIFIER_CLASS_DICTIONARY__";
  const SESSION_KEY_DONE = "__HW_NOTIFIER_DONE__";
  const SESSION_KEY_COLLECTED_HW = "__HW_NOTIFIER_COLLECTED_HW__";

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

  function UTILS_matchRegex(text, pattern) {
    return text.match(pattern);
  }

  function UTILS_substituteRegex(text, pattern, replacement) {
    return text.replace(pattern, replacement);
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
        "[Class_Fetcher] Failed parsing sessionStorage key:",
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

  function UTILS_sendToLocalPort(payload) {
    const localUrl = LOCAL_PORT_URL;
    const dataString = JSON.stringify(payload);

    return new Promise(function (resolve) {
      console.log("[Class_Fetcher] Sending status to local port at " + localUrl + "...");

      if (typeof GM_xmlhttpRequest === "function") {
        try {
          GM_xmlhttpRequest({
            method: "POST",
            url: localUrl,
            headers: {
              "Content-Type": "application/json",
            },
            data: dataString,
            timeout: 5000,
            onload: function (response) {
              console.log("[Class_Fetcher] Local port response:", response.status);
              resolve(true);
            },
            onerror: function (err) {
              console.warn("[Class_Fetcher] GM_xmlhttpRequest error, trying fetch...", err);
              fallbackFetch();
            },
            ontimeout: function () {
              console.warn("[Class_Fetcher] GM_xmlhttpRequest timeout, trying fetch...");
              fallbackFetch();
            },
          });
          return;
        } catch (e) {
          console.warn("[Class_Fetcher] Exception calling GM_xmlhttpRequest:", e);
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
            console.log("[Class_Fetcher] Successfully sent to local port via fetch.");
            resolve(true);
          })
          .catch(function (err) {
            console.warn("[Class_Fetcher] Could not reach local port via fetch:", err);
            resolve(false);
          });
      }
    });
  }

  function UTILS_fetchPage(url) {
    sessionStorage.setItem("INSPECT_NEXT_PAGE", "1");
    sessionStorage.setItem("TARGET_URL", url);
    sessionStorage.setItem("__hw__next", "1");
    window.location.href = url;
  }

  // --- build class dictionary from the list page ---
  function SEGMENT_getClass() {
    CLASS_DICTIONARY = {};

    $(class_list_element_grid).each(function (index, item) {
      const linkElement = $(item).find(class_link_element).first();
      const className = linkElement.text().trim();
      const classUrl = linkElement.attr("href");

      if (className && classUrl) {
        const fullUrl = classUrl.startsWith("http")
          ? classUrl
          : window.location.origin + classUrl;

        const class_number_match = UTILS_matchRegex(
          fullUrl,
          fetchClassNumberRegexPattern,
        );
        const class_number =
          class_number_match && class_number_match[1]
            ? class_number_match[1]
            : "";

        if (!class_number) return;

        const class_hw_url = UTILS_substituteRegex(
          class_homework_url,
          "<CLASS_NUMBER>",
          "class=" + class_number,
        );

        CLASS_DICTIONARY[className] = {
          url: fullUrl,
          class_number: class_number,
          class_hw_url: class_hw_url,
        };
      }
    });

    console.log("[Class_Fetcher] CLASS_DICTIONARY:", CLASS_DICTIONARY);
  }

  // --- build the queue in sessionStorage and navigate to the first class ---
  function SEGMENT_prepareAndStartQueue() {
    const queue = Object.keys(CLASS_DICTIONARY).map(function (className) {
      return {
        className: className,
        url: CLASS_DICTIONARY[className].url,
        class_number: CLASS_DICTIONARY[className].class_number,
        class_hw_url: CLASS_DICTIONARY[className].class_hw_url,
      };
    });

    UTILS_removeSessionKeys([
      SESSION_KEY_QUEUE,
      SESSION_KEY_INDEX,
      SESSION_KEY_ACTIVE,
      SESSION_KEY_CURRENT_CLASS,
      SESSION_KEY_CLASS_DICTIONARY,
      SESSION_KEY_DONE,
      SESSION_KEY_COLLECTED_HW,
    ]);

    if (!queue.length) {
      console.warn("[Class_Fetcher] No classes found — queue empty.");
      UTILS_sendToLocalPort({
        source: "Class_Fetcher",
        status: "empty",
        count: 0,
        items: [],
        message: "No classes found on list-class page.",
      });
      return;
    }

    UTILS_setSessionJSON(SESSION_KEY_CLASS_DICTIONARY, CLASS_DICTIONARY);
    UTILS_setSessionJSON(SESSION_KEY_QUEUE, queue);
    UTILS_setSessionJSON(SESSION_KEY_DONE, []);
    sessionStorage.setItem(SESSION_KEY_INDEX, "0");
    sessionStorage.setItem(SESSION_KEY_ACTIVE, "1");

    // --- set current class to index 0 and navigate ---
    const firstClass = queue[0];
    UTILS_setSessionJSON(SESSION_KEY_CURRENT_CLASS, firstClass);

    console.log(
      "[Class_Fetcher] Queue prepared (" +
        queue.length +
        " classes). Starting with:",
      firstClass,
    );
    UTILS_fetchPage(firstClass.class_hw_url);
  }

  function SEGMENT_getDeadline() {
    // intentionally left empty — HW_Fetcher handles this
  }

  function SEGMENT_runQueueStep() {
    // handled by SEGMENT_prepareAndStartQueue on list page
  }

  function UTILS_closeTab(isRepeatSkip) {
    if (isRepeatSkip && UTILS_shouldDisableAutoClose()) {
      console.log(
        "[Class_Fetcher] Auto-close on repeat is disabled (debugging mode). Keeping tab open.",
      );
      return;
    }
    console.log("[Class_Fetcher] Closing tab...");
    setTimeout(function () {
      window.close();
      if (!window.closed) {
        console.log(
          "[Class_Fetcher] Could not close tab automatically. Please close manually.",
        );
      }
    }, 1000);
  }

  let LOGIN_BOUNCE_REPORTED = false;
  let SCRAPE_STARTED = false;

  function UTILS_getResumeUrlForLoop() {
    const existingResume = sessionStorage.getItem(SESSION_KEY_RESUME_URL);
    if (existingResume) return existingResume;

    const isQueueActive = sessionStorage.getItem(SESSION_KEY_ACTIVE) === "1";
    const currentClass = UTILS_getSessionJSON(SESSION_KEY_CURRENT_CLASS, null);
    if (isQueueActive && currentClass && currentClass.class_hw_url) {
      return currentClass.class_hw_url;
    }
    return LIST_CLASS_URL;
  }

  function UTILS_showRelogBanner(remainingSec, resumeUrl) {
    let banner = document.getElementById("__hw_relog_banner__");
    if (!banner && document.body) {
      banner = document.createElement("div");
      banner.id = "__hw_relog_banner__";
      banner.style.cssText =
        "position:fixed;top:12px;right:12px;z-index:999999;background:#d32f2f;color:#fff;" +
        "padding:12px 18px;border-radius:8px;font-family:Segoe UI,sans-serif;font-size:13px;" +
        "box-shadow:0 4px 12px rgba(0,0,0,0.4);max-width:360px;line-height:1.4;";
      document.body.appendChild(banner);
    }
    if (banner) {
      banner.innerHTML =
        "<b>⚠️ Routed to /login — Please Log In!</b><br>" +
        "Waiting <b>" +
        remainingSec +
        "s</b> before resuming loop at:<br>" +
        "<span style='font-size:11px;opacity:0.9;word-break:break-all;'>" +
        resumeUrl +
        "</span>";
    }
  }

  function SEGMENT_beginRelogWait() {
    if (window.__HW_NOTIFIER_RELOG_TIMER_RUNNING__) return;
    window.__HW_NOTIFIER_RELOG_TIMER_RUNNING__ = true;

    const resumeUrl = UTILS_getResumeUrlForLoop();
    sessionStorage.setItem(SESSION_KEY_RESUME_URL, resumeUrl);

    let startTs = parseInt(
      sessionStorage.getItem(SESSION_KEY_RELOG_START_TS) || "0",
      10,
    );
    if (!startTs) {
      startTs = Date.now();
      sessionStorage.setItem(SESSION_KEY_RELOG_START_TS, String(startTs));
    }

    if (sessionStorage.getItem(SESSION_KEY_WAITING_RELOG) !== "1") {
      sessionStorage.setItem(SESSION_KEY_WAITING_RELOG, "1");
      console.warn(
        "[Class_Fetcher] Routed to /login! Requesting user login and waiting at least " +
          RELOG_WAIT_MS / 1000 +
          "s before resuming:",
        resumeUrl,
      );
      UTILS_sendToLocalPort({
        source: "Class_Fetcher",
        status: "login_required",
        url: window.location.href,
        resumeUrl: resumeUrl,
        waitSeconds: RELOG_WAIT_MS / 1000,
        message: "Routed to /login. Waiting 30s for user re-login.",
      });
    }

    const timer = setInterval(function () {
      const elapsed = Date.now() - startTs;
      const remainingMs = Math.max(0, RELOG_WAIT_MS - elapsed);
      const remainingSec = Math.ceil(remainingMs / 1000);
      UTILS_showRelogBanner(remainingSec, resumeUrl);

      if (remainingMs <= 0) {
        clearInterval(timer);
        sessionStorage.removeItem(SESSION_KEY_WAITING_RELOG);
        sessionStorage.removeItem(SESSION_KEY_RELOG_START_TS);
        sessionStorage.setItem(SESSION_KEY_TESTING_RELOG, "1");
        console.log(
          "[Class_Fetcher] 30s relog wait complete. Re-entering loop URL to test if <div> appears:",
          resumeUrl,
        );
        window.location.href = resumeUrl;
      }
    }, 500);
  }

  function SEGMENT_failRelogAndStop() {
    LOGIN_BOUNCE_REPORTED = true;
    UTILS_removeSessionKeys([
      SESSION_KEY_QUEUE,
      SESSION_KEY_INDEX,
      SESSION_KEY_ACTIVE,
      SESSION_KEY_CURRENT_CLASS,
      SESSION_KEY_CLASS_DICTIONARY,
      SESSION_KEY_DONE,
      SESSION_KEY_COLLECTED_HW,
      SESSION_KEY_WAITING_RELOG,
      SESSION_KEY_RELOG_START_TS,
      SESSION_KEY_RESUME_URL,
      SESSION_KEY_TESTING_RELOG,
    ]);
    console.error(
      "[Class_Fetcher] Relog check failed (<div> did not appear / still on /login). Sending failure report.",
    );
    UTILS_sendToLocalPort({
      source: "Class_Fetcher",
      status: "relog_failed",
      url: window.location.href,
      message:
        "[!] Relog in fail. After bouncing of token auth, user does not give any proper inputs of log-in auth. Force stop.",
    }).then(function () {
      UTILS_closeTab(false);
    });
  }

  function SEGMENT_startMainScrape() {
    if (SCRAPE_STARTED) return;
    if (UTILS_isLoginUrl()) return;
    if (!UTILS_isListClassPage()) return;
    SCRAPE_STARTED = true;

    const isTestingRelog =
      sessionStorage.getItem(SESSION_KEY_TESTING_RELOG) === "1";

    if (!isTestingRelog && UTILS_hasAlreadyRunToday()) {
      console.log(
        "%c[Class_Fetcher] Already ran today. Skipping.",
        "background: #0f0; color: #fff",
      );
      UTILS_sendToLocalPort({
        source: "Class_Fetcher",
        status: "skipped",
        count: 0,
        items: [],
        message: "Class_Fetcher already ran today.",
      }).then(function () {
        UTILS_closeTab(true);
      });
      return;
    } else {
      console.log(`%cOBSERVING...`, "background: #f00; color: #fff");
      console.log(`%cDo **not** abuse this script.`, "color:#f00");
    }

    setTimeout(function () {
      if (UTILS_isLoginUrl()) {
        if (isTestingRelog) {
          SEGMENT_failRelogAndStop();
        }
        return;
      }

      const cards = $(class_list_element_grid);
      if (isTestingRelog) {
        if (!cards.length) {
          // <div> process did not appear after relog wait -> still logged out
          SEGMENT_failRelogAndStop();
          return;
        }
        console.log(
          "[Class_Fetcher] Relog verified! <div> elements appeared on list-class.",
        );
        sessionStorage.removeItem(SESSION_KEY_TESTING_RELOG);
        sessionStorage.removeItem(SESSION_KEY_RESUME_URL);
        UTILS_sendToLocalPort({
          source: "Class_Fetcher",
          status: "relog_verified",
          url: window.location.href,
        });
      }

      // UTILS_markRanToday();
      SEGMENT_getClass();
      SEGMENT_prepareAndStartQueue();
    }, 4000);
  }

  function SEGMENT_startUrlWatcher() {
    // 1. If we are currently in the 30-second relog wait (even if login redirected to dashboard/home),
    // keep the 30-second countdown running and then navigate back to the loop URL!
    if (sessionStorage.getItem(SESSION_KEY_WAITING_RELOG) === "1") {
      SEGMENT_beginRelogWait();
      return true;
    }

    // 2. If we were testing relog after the 30s wait and got routed right back to /login,
    // that means relog failed!
    if (
      sessionStorage.getItem(SESSION_KEY_TESTING_RELOG) === "1" &&
      UTILS_isLoginUrl()
    ) {
      SEGMENT_failRelogAndStop();
      return true;
    }

    // 3. Watch URL continuously for any redirect to /login
    setInterval(function () {
      if (LOGIN_BOUNCE_REPORTED) return;
      if (UTILS_isLoginUrl()) {
        if (sessionStorage.getItem(SESSION_KEY_TESTING_RELOG) === "1") {
          SEGMENT_failRelogAndStop();
          return;
        }
        SEGMENT_beginRelogWait();
      }
    }, 500);

    return false;
  }

  // --- entry point ---
  window.addEventListener("load", () => {
    if (
      UTILS_shouldIgnoreHwTokens() &&
      sessionStorage.getItem(SESSION_KEY_WAITING_RELOG) !== "1" &&
      sessionStorage.getItem(SESSION_KEY_TESTING_RELOG) !== "1" &&
      sessionStorage.getItem(SESSION_KEY_ACTIVE) !== "1"
    ) {
      console.log(
        "[Class_Fetcher] Ignoring __HW_ tokens in storage (debug mode).",
      );
      UTILS_clearAllHwTokens();
    }

    const handledByWatcher = SEGMENT_startUrlWatcher();
    if (handledByWatcher) {
      return;
    }

    // Wait briefly for Vue router to settle in case it redirects to /login
    setTimeout(function () {
      if (
        UTILS_isLoginUrl() ||
        LOGIN_BOUNCE_REPORTED ||
        sessionStorage.getItem(SESSION_KEY_WAITING_RELOG) === "1"
      ) {
        return;
      }
      SEGMENT_startMainScrape();
    }, 800);
  });
})();
