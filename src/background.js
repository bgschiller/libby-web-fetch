// @ts-check
/// <reference types="chrome"/>

// @ts-ignore - importScripts is available in the service worker global scope
importScripts("logger.js");

const bgLogger = /** @type {any} */ (globalThis).LibbyLogger;
if (bgLogger) {
  bgLogger.install("background", { persist: true });
  bgLogger.restorePersisted();
}

// Background service worker for Libby audiobook downloads

/** @type {{isDownloading: boolean, bookTitle: string, kebabTitle: string, downloadedUrls: Set<string>, pendingUrls: Set<string>, fileCount: number, tabId: number|null, currentPercent: number, expectedDuration: string, nextRuleId: number, spineData: Array<any>, spineByPartId: Object, spineWithTimes: Array<any>, missingFiles: Array<any>, isFillingGaps: boolean, capturedRequests: Array<{tabId: number, url: string, baseUrl: string}>}} */
const state = {
  isDownloading: false,
  bookTitle: "",
  kebabTitle: "",
  downloadedUrls: new Set(),
  pendingUrls: new Set(), // URLs currently being processed (to prevent race conditions)
  fileCount: 0,
  tabId: null,
  currentPercent: 0,
  expectedDuration: "",
  nextRuleId: 1,
  spineData: [],
  spineByPartId: {},
  spineWithTimes: [],  // spine entries with cumulative start times, for gap detection
  missingFiles: [],     // files declared in manifest but not downloaded
  isFillingGaps: false,
  capturedRequests: [],
};

const CAPTURED_REQUESTS_KEY = "capturedRequests";

// Restore captured requests that were persisted before the service worker last shut down.
if (chrome.storage.session) {
  chrome.storage.session.get(CAPTURED_REQUESTS_KEY).then((result) => {
    const stored = result?.[CAPTURED_REQUESTS_KEY];
    if (Array.isArray(stored)) {
      for (const r of stored) {
        if (r && typeof r.tabId === "number" && typeof r.url === "string" && typeof r.baseUrl === "string") {
          const exists = state.capturedRequests.some(
            (c) => c.tabId === r.tabId && c.baseUrl === r.baseUrl
          );
          if (!exists) state.capturedRequests.push(r);
        }
      }
      console.log("[libby-fetch] Restored", state.capturedRequests.length, "captured request(s)");
    }
  }).catch((err) => {
    console.error("[libby-fetch] Failed to restore captured requests:", err);
  });
}

// URL patterns for audio files
const AUDIO_URL_PATTERNS = [
  /^https:\/\/odrmediaclips\.cachefly\.net/,
  /^https:\/\/audioclips\.cdn\.overdrive\.com/,
];

/**
 * @param {string} str
 * @returns {string}
 */
function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract a normalized identifier for deduplication.
 * Audio URLs have a badurl parameter that's base64-encoded and contains the actual file path.
 * Example: ...;badurl=aHR0cHM6Ly9vZnMt...;... decodes to https://ofs-.../Part01.mp3
 * We extract the Part number (e.g., "Part01") as the unique identifier.
 * @param {string} url
 * @returns {string}
 */
function getBaseUrl(url) {
  try {
    // Try to extract the badurl parameter which contains the actual file identifier.
    // The badurl value is URL-safe base64 (uses _ and - instead of / and +).
    const badUrlMatch = url.match(/badurl=([^;/]+)/);
    if (badUrlMatch) {
      // Convert URL-safe base64 to standard base64 for atob
      const b64 = badUrlMatch[1].replace(/_/g, '/').replace(/-/g, '+');
      const decoded = atob(b64);
      // Extract the Part number (e.g., Part01, Part02)
      const partMatch = decoded.match(/Part(\d+)\.mp3/i);
      if (partMatch) {
        return 'Part' + partMatch[1];
      }
      // Fallback: use the decoded filename
      const filenameMatch = decoded.match(/([^/]+\.mp3)$/i);
      if (filenameMatch) {
        return filenameMatch[1];
      }
    }
  } catch (e) {
    console.log("[libby-fetch] Error decoding URL:", e.message);
  }

  // Fallback: use the path from the URL
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/');
  return pathParts[pathParts.length - 1] || url;
}

/**
 * Extract the Part suffix from a spine entry's path.
 * e.g. "%7BGUID%7DFmt425-Part01.mp3" -> "Part01.mp3"
 * @param {Object} entry
 * @returns {string}
 */
function extractPartSuffix(entry) {
  const decoded = decodeURIComponent(entry.path);
  const match = decoded.match(/Part(\d+)\.mp3$/i);
  if (match) return match[1] + '.mp3';  // e.g., "08.mp3" instead of "Part08.mp3"
  // Fallback: filename after last / or \
  return decoded.replace(/.*[/\\]/, '') || decoded;
}

/**
 * Add a blocking rule for a URL to prevent duplicate requests
 * @param {string} baseUrl
 */
async function blockUrl(baseUrl) {
  const ruleId = state.nextRuleId++;

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: baseUrl,
          resourceTypes: ["media", "xmlhttprequest", "other"]
        }
      }],
      removeRuleIds: []
    });
    console.log("[libby-fetch] Added block rule", ruleId, "for", baseUrl);
  } catch (err) {
    console.error("[libby-fetch] Failed to add block rule:", err);
  }
}

/**
 * Clear all blocking rules (called when download starts or stops)
 */
async function clearBlockRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleIds = rules.map(r => r.id);
    if (ruleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ruleIds,
        addRules: []
      });
      console.log("[libby-fetch] Cleared", ruleIds.length, "block rules");
    }
  } catch (err) {
    console.error("[libby-fetch] Failed to clear block rules:", err);
  }
  state.nextRuleId = 1;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAudioUrl(url) {
  return AUDIO_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Persist captured requests so they survive service worker restarts.
 */
function persistCapturedRequests() {
  if (!chrome.storage.session) return;
  chrome.storage.session.set({ [CAPTURED_REQUESTS_KEY]: state.capturedRequests }).catch((err) => {
    console.error("[libby-fetch] Failed to persist captured requests:", err);
  });
}

/**
 * Record an audio request that fired before the user clicked "Start Download".
 * These are processed (downloaded) once the user starts a download for this tab.
 * @param {number} tabId
 * @param {string} url
 * @param {string} baseUrl
 */
function captureRequest(tabId, url, baseUrl) {
  const alreadyCaptured = state.capturedRequests.some(
    (r) => r.tabId === tabId && r.baseUrl === baseUrl
  );
  if (alreadyCaptured) return;
  state.capturedRequests.push({ tabId, url, baseUrl });
  persistCapturedRequests();
}

/**
 * Remove captured requests for a tab (e.g. when it navigates or closes).
 * @param {number} tabId
 */
function clearCapturedRequestsForTab(tabId) {
  const before = state.capturedRequests.length;
  state.capturedRequests = state.capturedRequests.filter((r) => r.tabId !== tabId);
  if (state.capturedRequests.length !== before) {
    persistCapturedRequests();
  }
}

/**
 * Load spine data from page context and build the partId lookup map.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function loadSpineData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        try {
          // @ts-ignore
          return window.BIF?.map?.spine || [];
        } catch (e) {
          return [];
        }
      }
    });
    // The player (and window.BIF) lives in an iframe on *.listen.libbyapp.com,
    // so scan all frames for the one that actually returned spine data.
    let spine = [];
    for (const result of results || []) {
      if (Array.isArray(result?.result) && result.result.length > 0) {
        spine = result.result;
        break;
      }
    }
    state.spineData = spine;
    state.spineByPartId = {};
    for (const entry of spine) {
      const decoded = decodeURIComponent(entry.path);
      const partMatch = decoded.match(/Part(\d+)\.mp3/i);
      if (partMatch) {
        state.spineByPartId['Part' + partMatch[1]] = entry;
      }
    }
    console.log("[libby-fetch] Loaded spine:", state.spineData.length, "entries");
  } catch (err) {
    console.error("[libby-fetch] Failed to load spine data:", err);
    state.spineData = [];
    state.spineByPartId = {};
  }
}

/**
 * Download the manifest JSON file listing all expected audio parts with their time spans.
 */
function downloadManifest() {
  if (state.spineData.length === 0) {
    console.log("[libby-fetch] No spine data available, skipping manifest download");
    return;
  }

  let cumulativeTime = 0;
  const filesWithTimes = [];
  const files = state.spineData.map(entry => {
    const suffix = extractPartSuffix(entry);
    const duration = entry['audio-duration'] || 0;
    const file = {
      filename: `${state.kebabTitle}-${suffix}`,
      startTime: cumulativeTime,
      duration,
      endTime: cumulativeTime + duration,
      byteSize: entry['-odread-file-bytes'],
      bitrate: entry['audio-bitrate'],
      spinePosition: entry['-odread-spine-position'],
      path: entry.path,
    };
    cumulativeTime += duration;
    filesWithTimes.push({ ...file, cumulativeStartTime: cumulativeTime - duration });
    return file;
  });

  // Store spine entries with cumulative start times for gap detection later
  state.spineWithTimes = filesWithTimes;

  const manifest = {
    bookTitle: state.bookTitle,
    kebabTitle: state.kebabTitle,
    generatedAt: new Date().toISOString(),
    totalDuration: cumulativeTime,
    files,
  };

  const json = JSON.stringify(manifest, null, 2);
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);

  chrome.downloads.download({
    url: dataUrl,
    filename: `${state.kebabTitle}/${state.kebabTitle}-manifest.json`,
    conflictAction: 'overwrite',
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error("[libby-fetch] Manifest download error:", chrome.runtime.lastError);
    } else {
      console.log("[libby-fetch] Manifest downloaded:", downloadId);
    }
  });
}

/**
 * Build the track list sent to the content script for manifest-driven scrubbing.
 * @returns {Array<{partId: string, startTime: number, endTime: number}>}
 */
function buildTrackList() {
  return state.spineWithTimes
    .map((entry) => {
      const suffixMatch = entry.filename.match(/-(\d+)\.mp3$/);
      if (!suffixMatch) return null;
      return {
        partId: 'Part' + suffixMatch[1],
        startTime: entry.startTime,
        endTime: entry.endTime,
      };
    })
    .filter((t) => t !== null);
}

/**
 * Compare downloaded URLs against the manifest spine to detect missing files.
 * Reports gaps to the popup and content script.
 */
function verifyAndReport() {
  if (state.spineWithTimes.length === 0) {
    console.log("[libby-fetch] No spine timing data available, skipping verification");
    return;
  }

  const missing = [];
  for (const entry of state.spineWithTimes) {
    // Determine the part ID that getBaseUrl() would produce for this file.
    // The entry's filename is like "operation-bounce-house-01.mp3", the part suffix is "01.mp3"
    // and getBaseUrl returns "Part01".
    const suffixMatch = entry.filename.match(/-(\d+)\.mp3$/);
    const partId = suffixMatch ? 'Part' + suffixMatch[1] : null;

    if (!partId) {
      console.log("[libby-fetch] Could not extract part ID from:", entry.filename);
      continue;
    }

    if (!state.downloadedUrls.has(partId)) {
      missing.push({
        filename: entry.filename,
        partId,
        startTime: entry.cumulativeStartTime,
        duration: entry.duration,
        path: entry.path,
      });
    }
  }

  state.missingFiles = missing;

  if (missing.length > 0) {
    console.warn(
      "[libby-fetch] MISSING FILES:",
      missing.map(f => f.filename).join(", "),
      `(${missing.length} of ${state.spineWithTimes.length} expected)`
    );
  } else {
    console.log("[libby-fetch] All", state.spineWithTimes.length, "expected files accounted for");
  }

  // Notify popup and content script of completion with gap info
  const msg = {
    type: "DOWNLOAD_COMPLETE",
    fileCount: state.fileCount,
    expectedCount: state.spineWithTimes.length,
    missingFiles: missing,
    totalDuration: state.spineWithTimes.length > 0
      ? state.spineWithTimes[state.spineWithTimes.length - 1].endTime
      : 0,
  };

  chrome.runtime.sendMessage(msg).catch(() => {});
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, msg).catch(() => {});
  }
}

/**
 * Called when all spine entries have been collected. Stops the download and notifies UI.
 * Content script stops scrubbing when it receives DOWNLOAD_PROGRESS with isDownloading=false.
 */
function completeDownload() {
  state.isDownloading = false;
  clearBlockRules();
  verifyAndReport();
  notifyProgress();
}

/**
 * Download a single audio URL and record its dedupe/blocking state.
 * @param {string} url
 * @param {string} baseUrl
 */
function handleAudioRequest(url, baseUrl) {
  if (!state.isDownloading && !state.isFillingGaps) return;

  // Check if we've already downloaded or are currently processing this URL
  if (state.downloadedUrls.has(baseUrl) || state.pendingUrls.has(baseUrl)) {
    console.log("[libby-fetch] Skipping duplicate URL:", baseUrl);
    return;
  }

  // Mark as pending immediately to prevent race conditions
  state.pendingUrls.add(baseUrl);

  // Then mark as downloaded
  state.downloadedUrls.add(baseUrl);
  state.fileCount++;

  // Ack the content script so its manifest-driven scrub loop can advance.
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: "TRACK_DOWNLOADED", partId: baseUrl }).catch(() => {});
  }

  // Determine filename: look up the spine entry by part ID (e.g., "Part08")
  // getBaseUrl now correctly extracts the part ID from the URL-safe-base64 badurl parameter
  const spineEntry = state.spineByPartId[baseUrl];
  const fileSuffix = spineEntry ? extractPartSuffix(spineEntry) : `${baseUrl}.mp3`;
  const filename = `${state.kebabTitle}-${fileSuffix}`;
  console.log("[libby-fetch] Matched:", baseUrl, "→", fileSuffix);
  const downloadPath = `${state.kebabTitle}/${filename}`;

  console.log("[libby-fetch] Downloading:", downloadPath, "from", url);

  // Block future requests for this URL to reduce server load
  blockUrl(baseUrl);

  // Download the full file (the URL is signed, so we can fetch it directly)
  chrome.downloads.download(
    {
      url,
      filename: downloadPath,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[libby-fetch] Download error:", chrome.runtime.lastError);
      } else {
        console.log("[libby-fetch] Started download:", downloadId, filename);
      }
    }
  );

  // Notify popup and content script of progress
  notifyProgress();

  // Check if all spine entries have been collected
  if (state.spineData.length > 0 && state.downloadedUrls.size >= state.spineData.length) {
    console.log("[libby-fetch] All", state.spineData.length, "spine entries collected, completing download");
    completeDownload();
  }
}

/**
 * Process audio requests captured before the user clicked "Start Download".
 * @param {number} tabId
 */
function processCapturedRequests(tabId) {
  const relevant = state.capturedRequests.filter((r) => r.tabId === tabId);
  if (relevant.length === 0) return;

  state.capturedRequests = state.capturedRequests.filter((r) => r.tabId !== tabId);
  persistCapturedRequests();

  console.log("[libby-fetch] Processing", relevant.length, "captured request(s) for tab", tabId);
  for (const r of relevant) {
    handleAudioRequest(r.url, r.baseUrl);
  }
}

// Listen for audio file requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const baseUrl = getBaseUrl(details.url);
    const shouldDownload = state.isDownloading || state.isFillingGaps;

    // Capture requests immediately so we don't miss the first part of the book,
    // which Libby requests when the player loads (before the user clicks Start).
    if (details.tabId >= 0 && !shouldDownload) {
      captureRequest(details.tabId, details.url, baseUrl);
    }

    if (!shouldDownload) return;

    handleAudioRequest(details.url, baseUrl);
  },
  {
    urls: [
      "*://odrmediaclips.cachefly.net/*",
      "*://audioclips.cdn.overdrive.com/*",
    ],
  }
);

function notifyProgress() {
  const message = {
    type: "DOWNLOAD_PROGRESS",
    fileCount: state.fileCount,
    percent: state.currentPercent,
    isDownloading: state.isDownloading,
  };

  // Notify popup (if open)
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup might not be open, that's fine
  });

  // Notify content script (for on-page progress banner)
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, message).catch(() => {
      // Content script might not be ready
    });
  }
}

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ingest log entries forwarded from content scripts and the popup without
  // logging them again (that would recurse and double-count).
  if (message && message.type === "LOG_ENTRY" && message.entry) {
    bgLogger.appendEntry(message.entry);
    sendResponse({ success: true });
    return false;
  }

  console.log("[libby-fetch] Received message:", message);

  switch (message.type) {
    case "GET_EXPECTED_FILES":
      // Get the tab ID from the sender
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ expectedFiles: 0 });
        return;
      }

      // If spine is already loaded, use it directly
      if (state.spineData.length > 0) {
        sendResponse({ expectedFiles: state.spineData.length });
        return;
      }

      // Execute in page context to read window.BIF
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
          try {
            // @ts-ignore
            const spine = window.BIF?.map?.spine;
            return Array.isArray(spine) ? spine.length : 0;
          } catch (e) {
            return 0;
          }
        }
      }).then(results => {
        let count = 0;
        for (const result of results || []) {
          if (result?.result > 0) {
            count = result.result;
            break;
          }
        }
        sendResponse({ expectedFiles: count });
      }).catch(err => {
        console.error("[libby-fetch] Error getting expected files:", err);
        sendResponse({ expectedFiles: 0 });
      });

      return true; // Keep channel open for async response

    case "START_DOWNLOAD":
      // Clear any existing block rules from previous downloads
      clearBlockRules();

      state.isDownloading = true;
      state.bookTitle = message.bookTitle;
      state.kebabTitle = toKebabCase(message.bookTitle);
      state.downloadedUrls.clear();
      state.pendingUrls.clear();
      state.fileCount = 0;
      state.tabId = message.tabId;
      state.currentPercent = 0;
      state.expectedDuration = message.expectedDuration || "";
      state.spineData = [];
      state.spineByPartId = {};

      console.log("[libby-fetch] Starting download for:", state.bookTitle);

      sendResponse({ success: true, kebabTitle: state.kebabTitle });

      // Load spine, download manifest, process any pre-start requests, then start scrubbing
      loadSpineData(message.tabId).then(() => {
        downloadManifest();
        processCapturedRequests(message.tabId);
        if (state.tabId) {
          chrome.tabs.sendMessage(state.tabId, {
            type: "START_SCRUBBING",
            tracks: buildTrackList(),
            totalDuration: state.spineWithTimes.length > 0
              ? state.spineWithTimes[state.spineWithTimes.length - 1].endTime
              : 0,
            downloadedParts: Array.from(state.downloadedUrls),
          });
        }
      });

      return true; // Keep channel open for async response

    case "STOP_DOWNLOAD":
      state.isDownloading = false;
      console.log("[libby-fetch] Stopping download");

      // Clear block rules
      clearBlockRules();

      // Tell content script to stop
      if (state.tabId) {
        chrome.tabs.sendMessage(state.tabId, { type: "STOP_SCRUBBING" });
      }

      sendResponse({ success: true });
      break;

    case "GET_STATUS":
      sendResponse({
        isDownloading: state.isDownloading,
        fileCount: state.fileCount,
        percent: state.currentPercent,
        bookTitle: state.bookTitle,
        kebabTitle: state.kebabTitle,
        expectedDuration: state.expectedDuration,
        expectedCount: state.spineWithTimes.length,
        missingFiles: state.missingFiles,
        isFillingGaps: state.isFillingGaps,
      });
      break;

    case "EXPORT_LOGS": {
      const entries = /** @type {Array<{ts: string, level: string, source: string, msg: string}>} */ (bgLogger.getEntries());
      entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

      const lines = [
        "Libby Audiobook Downloader — debug log",
        "Generated: " + new Date().toISOString(),
        "Extension version: " + (chrome.runtime.getManifest().version || "unknown"),
        "Book: " + (state.bookTitle || "(none)"),
        "Expected files: " + (state.spineData.length || 0),
        "Downloaded files: " + state.fileCount,
        "Missing files: " + state.missingFiles.map((f) => f.partId).join(", "),
        "",
      ];

      for (const e of entries) {
        lines.push("[" + e.ts + "] [" + e.level + "] [" + e.source + "] " + e.msg);
      }

      const text = lines.join("\n");
      const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const bookPrefix = state.kebabTitle ? state.kebabTitle + "-" : "";
      const filename = "libby-logs-" + bookPrefix + ts + ".txt";

      chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify" }, () => {
        if (chrome.runtime.lastError) {
          console.error("[libby-fetch] Log export failed:", chrome.runtime.lastError);
        }
      });

      console.log("[libby-fetch] Exported", entries.length, "log entries to", filename);
      sendResponse({ success: true, entries: entries.length });
      break;
    }

    case "SCRUBBING_COMPLETE":
      // If background already completed via the file-count check, it already
      // verified and reported — nothing left to do.
      if (!state.isDownloading) {
        sendResponse({ success: true });
        break;
      }
      state.isDownloading = false;
      console.log("[libby-fetch] Scrubbing complete (content finished visiting tracks), total files:", state.fileCount);

      // Clear block rules now that we're done
      clearBlockRules();

      verifyAndReport();
      notifyProgress();
      sendResponse({ success: true });
      break;

    case "FILL_GAPS":
      if (state.missingFiles.length === 0) {
        console.log("[libby-fetch] No gaps to fill");
        sendResponse({ success: true, filled: 0 });
        break;
      }

      console.log("[libby-fetch] Filling", state.missingFiles.length, "gaps:", state.missingFiles.map(f => f.partId));
      state.isFillingGaps = true;

      // Tell content script to seek to each missing part
      if (state.tabId) {
        const totalDuration = state.spineWithTimes[state.spineWithTimes.length - 1]?.endTime || 0;
        chrome.tabs.sendMessage(state.tabId, {
          type: "FILL_GAPS",
          missingParts: state.missingFiles,
          totalDuration,
        }).catch(err => {
          console.error("[libby-fetch] Failed to send FILL_GAPS to content script:", err);
          sendResponse({ success: false, error: err.message });
        });
      }

      sendResponse({ success: true });
      break;

    case "GAP_FILL_COMPLETE":
      state.isFillingGaps = false;
      console.log("[libby-fetch] Gap fill complete, re-verifying");
      verifyAndReport();
      sendResponse({ success: true });
      break;

    case "SCRUBBING_PROGRESS":
      state.currentPercent = message.percent;
      // Forward progress to popup and content script
      notifyProgress();
      sendResponse({ success: true });
      break;
  }

  return true; // Keep channel open for async response
});

// Update icon when on Overdrive pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear captured requests when a tab navigates to a new page so stale
  // captures from a previous book aren't applied to the next one.
  if (changeInfo.status === "loading") {
    clearCapturedRequestsForTab(tabId);
  }

  if (changeInfo.status === "complete" && tab.url) {
    if (tab.url.includes(".listen.overdrive.com") || tab.url.includes("libbyapp.com")) {
      chrome.action.setIcon({
        tabId,
        path: {
          16: "/icons/icon16-active.png",
          48: "/icons/icon48-active.png",
          128: "/icons/icon128-active.png",
        },
      });
    } else {
      chrome.action.setIcon({
        tabId,
        path: {
          16: "/icons/icon16.png",
          48: "/icons/icon48.png",
          128: "/icons/icon128.png",
        },
      });
    }
  }
});

// Clear captured requests when a tab is closed so stale captures can't leak
// into a future tab that happens to reuse the same tab ID.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearCapturedRequestsForTab(tabId);
});

console.log("[libby-fetch] Background service worker initialized");
