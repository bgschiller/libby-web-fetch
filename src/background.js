// @ts-check
/// <reference types="chrome"/>

// Background service worker for Libby audiobook downloads

/** @type {{isDownloading: boolean, bookTitle: string, kebabTitle: string, downloadedUrls: Set<string>, pendingUrls: Set<string>, fileCount: number, tabId: number|null, currentPercent: number, expectedDuration: string, nextRuleId: number}} */
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
};

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
    // Try to extract the badurl parameter which contains the actual file identifier
    const badUrlMatch = url.match(/badurl=([^;/]+)/);
    if (badUrlMatch) {
      // Decode the base64 badurl
      const decoded = atob(badUrlMatch[1]);
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
 * Add a blocking rule for a URL to prevent duplicate requests
 * @param {string} baseUrl
 */
async function blockUrl(baseUrl) {
  const ruleId = state.nextRuleId++;
  
  // Escape special regex characters in the URL
  const escapedUrl = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
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

// Listen for audio file requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!state.isDownloading) return;

    const baseUrl = getBaseUrl(details.url);

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

    const paddedNumber = String(state.fileCount).padStart(3, "0");
    const filename = `${state.kebabTitle}-${paddedNumber}.mp3`;
    const downloadPath = `${state.kebabTitle}/${filename}`;

    console.log("[libby-fetch] Downloading:", downloadPath, "from", details.url);

    // Block future requests for this URL to reduce server load
    blockUrl(baseUrl);

    // Download the full file (the URL is signed, so we can fetch it directly)
    chrome.downloads.download(
      {
        url: details.url,
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

    // Notify popup of progress
    notifyPopup();
  },
  {
    urls: [
      "*://odrmediaclips.cachefly.net/*",
      "*://audioclips.cdn.overdrive.com/*",
    ],
  }
);

function notifyPopup() {
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_PROGRESS",
    fileCount: state.fileCount,
    percent: state.currentPercent,
    isDownloading: state.isDownloading,
  }).catch(() => {
    // Popup might not be open, that's fine
  });
}

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[libby-fetch] Received message:", message);

  switch (message.type) {
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
      
      console.log("[libby-fetch] Starting download for:", state.bookTitle);
      
      // Tell content script to start scrubbing
      if (state.tabId) {
        chrome.tabs.sendMessage(state.tabId, { type: "START_SCRUBBING" });
      }
      
      sendResponse({ success: true, kebabTitle: state.kebabTitle });
      break;

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
      });
      break;

    case "SCRUBBING_COMPLETE":
      state.isDownloading = false;
      console.log("[libby-fetch] Scrubbing complete, total files:", state.fileCount);
      
      // Clear block rules now that we're done
      clearBlockRules();
      
      notifyPopup();
      sendResponse({ success: true });
      break;

    case "SCRUBBING_PROGRESS":
      state.currentPercent = message.percent;
      // Forward progress to popup
      chrome.runtime.sendMessage({
        type: "PROGRESS_UPDATE",
        fileCount: state.fileCount,
        percent: message.percent,
        isDownloading: state.isDownloading,
      }).catch(() => {});
      sendResponse({ success: true });
      break;
  }

  return true; // Keep channel open for async response
});

// Update badge when on Overdrive pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    if (tab.url.includes(".listen.overdrive.com")) {
      chrome.action.setBadgeText({ tabId, text: "●" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#4CAF50" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  }
});

console.log("[libby-fetch] Background service worker initialized");
