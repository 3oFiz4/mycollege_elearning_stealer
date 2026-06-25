// ==UserScript==
// @name         Class Fetcher
// @namespace    http://tampermonkey.net/
// @version      2026-04-23
// @description  Expose a bunch of Homework list with their deadline and origin schedule via HTTP POST to Discord WebHook
// @author       3oFiz4
// @match        https://elearning.pnb.ac.id/mahasiswa/list-class
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ac.id
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @grant        GM_xmlhttpRequest
// @connect      target-site.com
// @noframes
// ==/UserScript==

// this script only runs for my college elearning lol.
// this is not meant for others to use.
// but for others to learn how it works
// that is.. inject and inspecting Vue.js-made website.
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

  function UTILS_markRanToday() {
    localStorage.setItem(STORAGE_KEY_LAST_RUN, new Date().toDateString());
  }

  if (window.__HW_NOTIFIER_CLASS_FETCHER_LOADED__) return;
  window.__HW_NOTIFIER_CLASS_FETCHER_LOADED__ = true;

  /* this is a yap i made at early version. no need to see this.
    console.log("[!] Homework Notifier status OK");
    console.log(`
    This script is made by 3oFiz4. It is made for the sake of convenience of exposing a bunch of homework list with their created and deadline date via HTTP POST to Discord Webhook.`);

    */

  /* !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! READ ME (apologize for the long-ass !)!!
    console.log(`
    %cIf CSP blocks this script, unblock it.
    Please always wait 2 seconds for each segment of the script to run to avoid SPA.
    `, 'color:#fff;background:black;');
    */

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

  // --- entry point ---
  window.addEventListener("load", () => {
    if (UTILS_hasAlreadyRunToday()) {
      console.log(
        "%c[Class_Fetcher] Already ran today. Skipping.",
        "background: #0f0; color: #fff",
      );
      return;
    } else {
      console.log(`%cOBSERVING...`, "background: #f00; color: #fff");
      console.log(`%cDo **not** abuse this script.`, "color:#f00");
    }

    setTimeout(function () {
      // UTILS_markRanToday();
      SEGMENT_getClass();
      SEGMENT_prepareAndStartQueue();
    }, 4000);
  });
})();
