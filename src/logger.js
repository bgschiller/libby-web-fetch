// @ts-check
/// <reference types="chrome"/>

/**
 * In-memory console log capture for the Libby Audiobook Downloader.
 *
 * Every extension context (background service worker, content script, popup)
 * calls LibbyLogger.install() with a source name. Console output is captured
 * into a rolling in-memory buffer. Content scripts and the popup forward their
 * entries to the background worker, which keeps the master buffer, so the
 * "Download Logs" button can export one complete file for bug reports.
 */
(function () {
  "use strict";

  const MAX_ENTRIES = 2000;
  const STORAGE_KEY = "libbyLogBuffer";

  /** @type {Array<{ts: string, level: string, source: string, msg: string}>} */
  let buffer = [];
  let source = "unknown";
  let forwardToBackground = false;
  let persist = false;
  /** @type {number | null} */
  let persistTimer = null;

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  /**
   * @param {any} arg
   * @returns {string}
   */
  function serialize(arg) {
    if (typeof arg === "string") return arg;
    if (typeof arg === "function") return String(arg);
    if (arg instanceof Error) {
      return arg.stack || (arg.name + ": " + arg.message);
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(arg, function (key, value) {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        if (typeof value === "function") return "[Function]";
        if (typeof value === "undefined") return "[undefined]";
        return value;
      });
    } catch (e) {
      return String(arg);
    }
  }

  /**
   * @param {string} level
   * @param {any[]} args
   */
  function capture(level, args) {
    const msg = args.map(serialize).join(" ");
    const entry = { ts: new Date().toISOString(), level, source, msg };
    appendEntry(entry);

    if (forwardToBackground) {
      try {
        chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }).catch(function () {});
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * @param {{ts: string, level: string, source: string, msg: string}} entry
   */
  function appendEntry(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.msg !== "string") return;
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_ENTRIES);
    }
    schedulePersist();
  }

  function schedulePersist() {
    if (!persist || persistTimer !== null) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
          chrome.storage.session.set({ [STORAGE_KEY]: buffer }).catch(function () {});
        }
      } catch (e) {
        /* ignore */
      }
    }, 250);
  }

  /**
   * Restore the master buffer from session storage (background only).
   * @returns {Promise<void>}
   */
  function restorePersisted() {
    if (!persist) return Promise.resolve();
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
        return chrome.storage.session.get(STORAGE_KEY).then(function (result) {
          const stored = result ? result[STORAGE_KEY] : null;
          if (Array.isArray(stored)) {
            buffer = stored.concat(buffer).slice(-MAX_ENTRIES);
          }
        }).catch(function () {});
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.resolve();
  }

  /**
   * @param {string} src
   * @param {{forward?: boolean, persist?: boolean}} [opts]
   */
  function install(src, opts) {
    source = src;
    forwardToBackground = !!(opts && opts.forward);
    persist = !!(opts && opts.persist);

    console.log = function () {
      const args = Array.from(arguments);
      originalConsole.log.apply(null, args);
      capture("log", args);
    };
    console.warn = function () {
      const args = Array.from(arguments);
      originalConsole.warn.apply(null, args);
      capture("warn", args);
    };
    console.error = function () {
      const args = Array.from(arguments);
      originalConsole.error.apply(null, args);
      capture("error", args);
    };
  }

  /** @returns {Array<{ts: string, level: string, source: string, msg: string}>} */
  function getEntries() {
    return buffer.slice();
  }

  function clear() {
    buffer = [];
    schedulePersist();
  }

  // @ts-ignore - assigned to the global scope for use by background/content/popup
  globalThis.LibbyLogger = {
    install,
    getEntries,
    appendEntry,
    clear,
    restorePersisted,
    MAX_ENTRIES,
  };
})();
