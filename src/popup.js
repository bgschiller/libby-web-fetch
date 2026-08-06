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

  if (status.isDownloading || status.isFillingGaps) {
    showSection("progress-section");
    updateProgress(status.fileCount, status.percent || 0);
    currentKebabTitle = status.kebabTitle;
    expectedDuration = status.expectedDuration;
    return;
  }

  // If a download completed but the popup was closed, restore the completion view.
  // This also handles the case where gaps were found/filled while the popup was closed.
  if (status.fileCount > 0 && !status.isDownloading) {
    currentKebabTitle = status.kebabTitle;
    expectedDuration = status.expectedDuration;
    showComplete(status.fileCount, status.expectedCount, status.missingFiles);
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

/** @type {Array<{filename: string, partId: string}>} */
let currentMissingFiles = [];

/**
 * @param {number} totalFiles
 * @param {number} [expectedCount]
 * @param {Array<{filename: string, partId: string}>} [missingFiles]
 */
function showComplete(totalFiles, expectedCount, missingFiles) {
  showSection("complete-section");

  currentMissingFiles = missingFiles || [];
  
  const totalFilesEl = $("total-files");
  if (totalFilesEl) {
    if (expectedCount && missingFiles && missingFiles.length > 0) {
      totalFilesEl.textContent = `${totalFiles} / ${expectedCount}`;
    } else {
      totalFilesEl.textContent = String(totalFiles);
    }
  }

  // Show/hide gap-fill UI
  const gapSection = $("gap-section");
  const missingFilesList = $("missing-files-list");
  const fillGapsBtn = $("fill-gaps-btn");

  if (gapSection && missingFiles && missingFiles.length > 0) {
    gapSection.classList.remove("hidden");
    if (missingFilesList) {
      missingFilesList.textContent = missingFiles.map(f => f.filename).join("\n");
    }
    if (fillGapsBtn) {
      fillGapsBtn.disabled = false;
      fillGapsBtn.textContent = `Fill ${missingFiles.length} Gap${missingFiles.length > 1 ? 's' : ''}`;
    }
  } else if (gapSection) {
    gapSection.classList.add("hidden");
  }
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
      // DOWNLOAD_PROGRESS with isDownloading=false is the older signal.
      // DOWNLOAD_COMPLETE is the newer, richer one. Both may fire, so
      // DOWNLOAD_COMPLETE takes precedence for the final state.
      if (!message.missingFiles) {
        showComplete(message.fileCount);
      }
    } else if (message.isDownloading || message.fileCount >= 0) {
      updateProgress(message.fileCount, message.percent || 0);
    }
  }

  if (message.type === "DOWNLOAD_COMPLETE") {
    showComplete(message.fileCount, message.expectedCount, message.missingFiles);
  }
});

// Set up event listeners
document.addEventListener("DOMContentLoaded", () => {
  init();

  $("start-btn")?.addEventListener("click", startDownload);
  $("stop-btn")?.addEventListener("click", stopDownload);
  $("new-download-btn")?.addEventListener("click", () => {
    currentMissingFiles = [];
    showSection("setup-section");
  });

  // Fill gaps button
  $("fill-gaps-btn")?.addEventListener("click", async () => {
    const btn = /** @type {HTMLButtonElement} */ ($("fill-gaps-btn"));
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Filling gaps...";
    }

    try {
      await chrome.runtime.sendMessage({ type: "FILL_GAPS" });
    } catch (error) {
      console.error("Fill gaps error:", error);
      showError("Failed to fill gaps. Make sure the Libby page is still open.");
      if (btn) {
        btn.disabled = false;
        btn.textContent = currentMissingFiles.length > 0
          ? `Fill ${currentMissingFiles.length} Gap${currentMissingFiles.length > 1 ? 's' : ''}`
          : "Fill Gaps";
      }
    }
  });

  // Update kebab title when folder name changes
  $("folder-name")?.addEventListener("input", (e) => {
    currentKebabTitle = /** @type {HTMLInputElement} */ (e.target).value;
  });
});
