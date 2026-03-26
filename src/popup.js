// @ts-check
/// <reference types="chrome"/>

// Popup script for Libby audiobook downloader

/** @type {string} */
let currentKebabTitle = "";
/** @type {string} */
let expectedDuration = "";

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
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function $(id) {
  return document.getElementById(id);
}

/** @returns {Promise<chrome.tabs.Tab|null>} */
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isOverdrivePage(url) {
  return !!url && (url.includes(".listen.overdrive.com") || url.includes("libbyapp.com"));
}

/**
 * @param {string} message
 */
function showError(message) {
  const errorEl = $("error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }
}

function hideError() {
  $("error")?.classList.add("hidden");
}

/**
 * @param {string} sectionId
 */
function showSection(sectionId) {
  ["setup-section", "progress-section", "complete-section", "not-overdrive"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.classList.toggle("hidden", id !== sectionId);
    }
  });
}

async function init() {
  const tab = await getCurrentTab();

  if (!tab || !isOverdrivePage(tab.url)) {
    showSection("not-overdrive");
    return;
  }

  // Check current download status
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });

  if (status.isDownloading) {
    showSection("progress-section");
    updateProgress(status.fileCount, status.percent || 0);
    currentKebabTitle = status.kebabTitle;
    expectedDuration = status.expectedDuration;
    return;
  }

  // Get book info from content script
  try {
    const bookInfo = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_BOOK_INFO",
    });

    const titleEl = $("book-title");
    const durationEl = $("book-duration");
    const folderInput = /** @type {HTMLInputElement|null} */ ($("folder-name"));
    const startBtn = /** @type {HTMLButtonElement|null} */ ($("start-btn"));

    if (titleEl) {
      titleEl.textContent = bookInfo.title;
    }

    if (durationEl) {
      durationEl.textContent = bookInfo.totalDurationFormatted || "--";
      expectedDuration = bookInfo.totalDurationFormatted || "";
    }

    const expectedFilesEl = $("expected-files");
    if (expectedFilesEl) {
      expectedFilesEl.textContent = bookInfo.expectedFiles > 0 ? String(bookInfo.expectedFiles) : "--";
    }

    if (folderInput) {
      folderInput.value = toKebabCase(bookInfo.title);
      currentKebabTitle = folderInput.value;
    }

    if (startBtn) {
      startBtn.disabled = false;
    }

    showSection("setup-section");
  } catch (error) {
    console.error("Failed to get book info:", error);
    showError("Could not connect to page. Try refreshing the page.");
  }
}

/**
 * @param {number} fileCount
 * @param {number} percent
 */
function updateProgress(fileCount, percent) {
  const fileCountEl = $("file-count");
  const progressEl = $("book-progress");

  if (fileCountEl) {
    fileCountEl.textContent = String(fileCount);
  }

  if (progressEl) {
    progressEl.textContent = Math.round(percent * 100) + "%";
  }
}

/**
 * @param {number} totalFiles
 */
function showComplete(totalFiles) {
  showSection("complete-section");
  
  const totalFilesEl = $("total-files");
  if (totalFilesEl) {
    totalFilesEl.textContent = String(totalFiles);
  }

  // Update validation command
  const commandEl = $("validation-command");
  const expectedEl = $("expected-duration");
  
  if (commandEl && currentKebabTitle) {
    // Command that shows both file count and total duration
    const cmd = `cd ~/Downloads/${currentKebabTitle} && echo "Files: $(ls -1 *.mp3 | wc -l)" && for f in *.mp3; do afinfo "$f" 2>/dev/null | grep duration; done | awk '{s+=$3} END {h=int(s/3600); m=int((s%3600)/60); print "Duration: " h "h " m "m"}'`;
    commandEl.textContent = cmd;
  }
  
  // Add dedup command
  const dedupEl = $("dedup-command");
  if (dedupEl && currentKebabTitle) {
    const dedupCmd = `cd ~/Downloads/${currentKebabTitle} && md5 -r *.mp3 | sort | awk '{h=$1;f=$2;if(seen[h]){print "rm \\"" f "\\"";c++}else{seen[h]=1}} END{print "# "c" duplicates"}' | sh && echo "Files: $(ls -1 *.mp3 | wc -l)" && for f in *.mp3; do afinfo "$f" 2>/dev/null | grep duration; done | awk '{s+=$3} END {h=int(s/3600); m=int((s%3600)/60); print "Duration: " h "h " m "m"}'`;
    dedupEl.textContent = dedupCmd;
  }

  if (expectedEl) {
    expectedEl.textContent = expectedDuration || "--";
  }
}

async function startDownload() {
  hideError();

  const tab = await getCurrentTab();
  if (!tab?.id) {
    showError("No active tab");
    return;
  }

  const folderInput = /** @type {HTMLInputElement|null} */ ($("folder-name"));
  
  const bookTitle = folderInput?.value || "audiobook";
  
  currentKebabTitle = bookTitle;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD",
      bookTitle,
      tabId: tab.id,
      expectedDuration,
    });

    if (response.success) {
      showSection("progress-section");
      updateProgress(0, 0);
    } else {
      showError("Failed to start download");
    }
  } catch (error) {
    console.error("Start download error:", error);
    showError("Failed to start download");
  }
}

async function stopDownload() {
  try {
    await chrome.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
    showSection("setup-section");
  } catch (error) {
    console.error("Stop download error:", error);
  }
}

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((message) => {
  console.log("[popup] Received message:", message);

  if (message.type === "DOWNLOAD_PROGRESS" || message.type === "PROGRESS_UPDATE") {
    if (!message.isDownloading && message.fileCount > 0) {
      showComplete(message.fileCount);
    } else {
      updateProgress(message.fileCount, message.percent || 0);
    }
  }
});

// Set up event listeners
document.addEventListener("DOMContentLoaded", () => {
  init();

  $("start-btn")?.addEventListener("click", startDownload);
  $("stop-btn")?.addEventListener("click", stopDownload);
  $("new-download-btn")?.addEventListener("click", () => {
    showSection("setup-section");
  });

  // Update kebab title when folder name changes
  $("folder-name")?.addEventListener("input", (e) => {
    currentKebabTitle = /** @type {HTMLInputElement} */ (e.target).value;
  });
});
