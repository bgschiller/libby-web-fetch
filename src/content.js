// @ts-check
/// <reference types="chrome"/>

// Content script for Libby audiobook pages

let isScrubbing = false;
/** @type {HTMLElement|null} */
let progressBanner = null;
/** @type {number} */
let totalExpectedFiles = 0;
/** @type {number|null} */
let scrubInterval = null;
/** @type {number} */
let totalDurationSeconds = 0;

/** @returns {string} */
function getBookTitle() {
  return document.title || "Unknown Book";
}

/** @returns {number} */
function getProgressPercent() {
  const pctElement = document.querySelector(
    ".timeline-clocks .timeline-percent-visual"
  );
  if (!pctElement) return 0;
  const text = pctElement.textContent || "0%";
  return parseFloat(text) / 100;
}

/**
 * Parse time string like "13:51:44" or "20:16" or "-20:16" to seconds
 * @param {string} timeStr
 * @returns {number}
 */
function parseTimeToSeconds(timeStr) {
  const clean = timeStr.replace(/^-/, "").trim();
  const parts = clean.split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

/**
 * Get current position in seconds and total duration
 * @returns {{currentSeconds: number, totalSeconds: number, remainingSeconds: number}}
 */
function getTimeInfo() {
  let currentSeconds = 0;
  let remainingSeconds = 0;
  
  // The timeline-clocks area has child elements with specific content
  // Look for elements containing "elapsed" and "remaining" text
  const clocksEl = document.querySelector(".timeline-clocks");
  if (!clocksEl) return { currentSeconds: 0, totalSeconds: 0, remainingSeconds: 0 };
  
  // Get all text nodes and elements
  const allElements = clocksEl.querySelectorAll("*");
  
  for (const el of allElements) {
    const text = el.textContent || "";
    
    // Check for elapsed time (contains "elapsed" in accessible text)
    if (text.includes("elapsed")) {
      const match = text.match(/(\d+:\d+(?::\d+)?)/);
      if (match) {
        currentSeconds = parseTimeToSeconds(match[1]);
      }
    }
    
    // Check for remaining time (starts with "-" or contains "remaining")
    if (text.includes("remaining")) {
      const match = text.match(/(\d+:\d+(?::\d+)?)/);
      if (match) {
        remainingSeconds = parseTimeToSeconds(match[1]);
      }
    }
  }
  
  // Fallback: look for time patterns directly
  // The elapsed time is usually a positive time like "13:51:44"
  // The remaining time is usually prefixed with "-" like "-20:16"
  if (currentSeconds === 0 || remainingSeconds === 0) {
    const fullText = clocksEl.textContent || "";
    
    // Find remaining time (has minus sign before it)
    const remainingMatch = fullText.match(/-\s*(\d+:\d+(?::\d+)?)/);
    if (remainingMatch && remainingSeconds === 0) {
      remainingSeconds = parseTimeToSeconds(remainingMatch[1]);
    }
    
    // Find all time patterns
    const allTimes = fullText.match(/\d+:\d+(?::\d+)?/g) || [];
    if (allTimes.length >= 2 && currentSeconds === 0) {
      // First time is usually elapsed, but verify it's not the remaining time
      const firstTime = allTimes[0];
      const firstTimeSeconds = parseTimeToSeconds(firstTime);
      // If first time matches remaining, use the pattern before the minus
      if (firstTimeSeconds !== remainingSeconds) {
        currentSeconds = firstTimeSeconds;
      }
    }
  }
  
  const totalSeconds = currentSeconds + remainingSeconds;
  
  console.log("[libby-fetch] Time info - current:", currentSeconds, "remaining:", remainingSeconds, "total:", totalSeconds);
  
  return { currentSeconds, totalSeconds, remainingSeconds };
}

/**
 * Format seconds as human-readable duration
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

/** @returns {HTMLElement|null} */
function getSeekometer() {
  return document.querySelector(".seekometer");
}

/** @returns {HTMLElement|null} */
function getPlayButton() {
  return document.querySelector('footer button[aria-label="Play"]') ||
    document.querySelector('button[aria-label="Play"]');
}

/** @returns {HTMLElement|null} */
function getPauseButton() {
  return document.querySelector('footer button[aria-label="Pause"]') ||
    document.querySelector('button[aria-label="Pause"]');
}

/** @returns {HTMLElement|null} */
function getStartOfAudiobookButton() {
  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    const label = btn.getAttribute("aria-label") || btn.textContent || "";
    if (label.toLowerCase().includes("start of audiobook")) {
      return /** @type {HTMLElement} */ (btn);
    }
  }
  return null;
}

/** @returns {HTMLElement|null} */
function getTableOfContentsButton() {
  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    const label = btn.getAttribute("aria-label") || btn.textContent || "";
    if (label.toLowerCase().includes("table of contents")) {
      return /** @type {HTMLElement} */ (btn);
    }
  }
  return null;
}

/** @returns {HTMLElement|null} */
function getFirstTrackInTOC() {
  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    const text = btn.textContent || "";
    const label = btn.getAttribute("aria-label") || "";
    const combined = text + " " + label;
    
    if (combined.match(/track[:\s]*1\b/i)) {
      return /** @type {HTMLElement} */ (btn);
    }
    if (combined.match(/chapter[:\s]*1\b/i)) {
      return /** @type {HTMLElement} */ (btn);
    }
  }
  
  for (const btn of buttons) {
    const text = btn.textContent || "";
    if (text.trim() === "00:00" || text.trim() === "0 minutes") {
      return /** @type {HTMLElement} */ (btn);
    }
  }
  
  return null;
}

/** @returns {HTMLElement|null} */
function getDismissDialogButton() {
  const buttons = document.querySelectorAll("button");
  for (const btn of buttons) {
    const label = btn.getAttribute("aria-label") || btn.textContent || "";
    if (label.toLowerCase().includes("dismiss dialog")) {
      return /** @type {HTMLElement} */ (btn);
    }
  }
  return null;
}

/** @returns {HTMLElement|null} */
function getAdvance15Button() {
  return /** @type {HTMLElement|null} */ (
    document.querySelector('button[aria-label="Advance 15 seconds"]')
  );
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {HTMLElement} el
 * @returns {Promise<void>}
 */
async function clickElement(el) {
  el.click();
  await sleep(500);
}

/**
 * Click the Advance 15 seconds button
 * @returns {boolean} true if button was clicked
 */
function advanceFifteenSeconds() {
  const btn = getAdvance15Button();
  if (btn) {
    btn.click();
    return true;
  }
  console.log("[libby-fetch] Advance 15 seconds button not found");
  return false;
}

async function restartAudiobook() {
  console.log("[libby-fetch] Restarting audiobook from beginning...");

  // First, try to pause if playing
  const pauseBtn = getPauseButton();
  if (pauseBtn) {
    console.log("[libby-fetch] Pausing playback");
    await clickElement(pauseBtn);
    await sleep(1000);
  }

  // Try method 1: "Start of Audiobook" button
  const startBtn = getStartOfAudiobookButton();
  if (startBtn) {
    console.log("[libby-fetch] Clicking start of audiobook button");
    await clickElement(startBtn);
    await sleep(2000);
  } else {
    // Method 2: Open Table of Contents and click first track
    console.log("[libby-fetch] Opening Table of Contents...");
    const tocBtn = getTableOfContentsButton();
    if (tocBtn) {
      await clickElement(tocBtn);
      await sleep(1000);
      
      const firstTrack = getFirstTrackInTOC();
      if (firstTrack) {
        console.log("[libby-fetch] Clicking first track in TOC");
        await clickElement(firstTrack);
        await sleep(1000);
        
        // Close the TOC dialog
        const dismissBtn = getDismissDialogButton();
        if (dismissBtn) {
          console.log("[libby-fetch] Closing TOC dialog");
          await clickElement(dismissBtn);
          await sleep(500);
        }
      } else {
        console.log("[libby-fetch] Could not find first track in TOC");
        const dismissBtn = getDismissDialogButton();
        if (dismissBtn) {
          await clickElement(dismissBtn);
          await sleep(500);
        }
      }
    } else {
      // Method 3: Seek to 0% on seekometer
      console.log("[libby-fetch] Seeking to start via seekometer...");
      await seekToPercent(0.001);
      await sleep(2000);
    }
  }

  // Resume playback
  const playBtn = getPlayButton();
  if (playBtn) {
    console.log("[libby-fetch] Resuming playback");
    await clickElement(playBtn);
    await sleep(1000);
  }
  
  // Capture total duration - when at start, remaining time ≈ total time
  await sleep(500); // Wait for UI to update
  const timeInfo = getTimeInfo();
  const progress = getProgressPercent();
  
  if (timeInfo.remainingSeconds > 0 && progress < 0.05) {
    // Near the start, so remaining ≈ total
    totalDurationSeconds = timeInfo.remainingSeconds;
    console.log("[libby-fetch] Total book duration (from remaining):", formatDuration(totalDurationSeconds));
  } else if (timeInfo.totalSeconds > 0) {
    totalDurationSeconds = timeInfo.totalSeconds;
    console.log("[libby-fetch] Total book duration:", formatDuration(totalDurationSeconds));
  }
}

async function startScrubbing() {
  if (isScrubbing) return;
  isScrubbing = true;
  totalDurationSeconds = 0;

  console.log("[libby-fetch] Starting scrubbing process (15 second advances)");
  
  // Create progress banner on the page
  createProgressBanner();

  // Restart the audiobook from the beginning
  await restartAudiobook();

  // Wait a bit for the first audio to load
  await sleep(2000);

  let lastLoggedPercent = -1;

  // Start the scrub loop - advance 15 seconds at a time with short delays
  scrubInterval = window.setInterval(() => {
    if (!isScrubbing) {
      if (scrubInterval) clearInterval(scrubInterval);
      return;
    }

    const progress = getProgressPercent();
    
    // Log progress every 5%
    const progressPercent = Math.round(progress * 100);
    if (progressPercent >= lastLoggedPercent + 5) {
      lastLoggedPercent = progressPercent;
      const currentSeconds = totalDurationSeconds > 0 ? progress * totalDurationSeconds : 0;
      console.log("[libby-fetch] Progress:", progressPercent + "% (" + formatDuration(currentSeconds) + ")");
      
      // Report progress to background
      chrome.runtime.sendMessage({
        type: "SCRUBBING_PROGRESS",
        percent: progress,
      });
    }

    if (progress >= 0.99) {
      console.log("[libby-fetch] Reached end of audiobook");
      stopScrubbing();
      chrome.runtime.sendMessage({ type: "SCRUBBING_COMPLETE" });
      return;
    }

    // Click advance 15 seconds
    advanceFifteenSeconds();
  }, 150); // Click every 150ms
}

function stopScrubbing() {
  console.log("[libby-fetch] Stopping scrubbing");
  isScrubbing = false;
  if (scrubInterval) {
    clearInterval(scrubInterval);
    scrubInterval = null;
  }
}

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[libby-fetch] Content script received:", message);

  switch (message.type) {
    case "GET_BOOK_INFO": {
      const timeInfo = getTimeInfo();
      // Get expected files async, then respond
      getTotalExpectedFiles().then(expectedFiles => {
        sendResponse({
          title: getBookTitle(),
          progress: getProgressPercent(),
          totalDurationSeconds: timeInfo.totalSeconds,
          totalDurationFormatted: formatDuration(timeInfo.totalSeconds),
          expectedFiles: expectedFiles,
        });
      });
      return true; // Keep channel open for async response
    }

    case "START_SCRUBBING":
      startScrubbing();
      sendResponse({ success: true });
      break;

    case "STOP_SCRUBBING":
      stopScrubbing();
      removeProgressBanner();
      sendResponse({ success: true });
      break;
      
    case "DOWNLOAD_PROGRESS":
      updateProgressBanner(message.fileCount, message.percent || 0);
      if (!message.isDownloading && message.fileCount > 0) {
        showCompleteBanner(message.fileCount);
      }
      sendResponse({ success: true });
      break;
  }

  return true;
});

/**
 * Get the total number of audio files from window.BIF
 * Asks background script to read from page context using chrome.scripting
 * @returns {Promise<number>}
 */
function getTotalExpectedFiles() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_EXPECTED_FILES" }, (response) => {
      resolve(response?.expectedFiles || 0);
    });
  });
}

/**
 * Create or update the progress banner at the top of the page
 */
async function createProgressBanner() {
  if (progressBanner) return;
  
  totalExpectedFiles = await getTotalExpectedFiles();
  console.log("[libby-fetch] Expected files:", totalExpectedFiles);
  
  progressBanner = document.createElement('div');
  progressBanner.id = 'libby-fetch-progress';
  progressBanner.innerHTML = `
    <style>
      #libby-fetch-progress {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 999999;
        background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
        color: white;
        padding: 12px 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      }
      #libby-fetch-progress .lfp-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #libby-fetch-progress .lfp-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: lfp-spin 1s linear infinite;
      }
      @keyframes lfp-spin {
        to { transform: rotate(360deg); }
      }
      #libby-fetch-progress .lfp-status {
        font-weight: 500;
      }
      #libby-fetch-progress .lfp-details {
        opacity: 0.9;
        font-size: 13px;
      }
      #libby-fetch-progress .lfp-stop {
        background: rgba(255,255,255,0.2);
        border: 1px solid rgba(255,255,255,0.3);
        color: white;
        padding: 6px 16px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.2s;
      }
      #libby-fetch-progress .lfp-stop:hover {
        background: rgba(255,255,255,0.3);
      }
      #libby-fetch-progress.lfp-complete {
        background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
      }
    </style>
    <div class="lfp-left">
      <div class="lfp-spinner"></div>
      <div>
        <div class="lfp-status">Downloading audiobook...</div>
        <div class="lfp-details">
          <span class="lfp-files">0</span> files
          <span class="lfp-expected">${totalExpectedFiles > 0 ? ` / ${totalExpectedFiles} expected` : ''}</span>
          · <span class="lfp-percent">0%</span> through book
        </div>
      </div>
    </div>
    <button class="lfp-stop">Stop</button>
  `;
  
  document.body.appendChild(progressBanner);
  
  // Add stop button handler
  progressBanner.querySelector('.lfp-stop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
    removeProgressBanner();
  });
}

/**
 * Update the progress banner
 * @param {number} fileCount
 * @param {number} percent
 */
function updateProgressBanner(fileCount, percent) {
  if (!progressBanner) return;
  
  const filesEl = progressBanner.querySelector('.lfp-files');
  const percentEl = progressBanner.querySelector('.lfp-percent');
  
  if (filesEl) filesEl.textContent = String(fileCount);
  if (percentEl) percentEl.textContent = Math.round(percent * 100) + '%';
}

/**
 * Show completion state in the banner
 * @param {number} fileCount
 */
function showCompleteBanner(fileCount) {
  if (!progressBanner) return;
  
  progressBanner.classList.add('lfp-complete');
  
  const spinner = progressBanner.querySelector('.lfp-spinner');
  if (spinner) spinner.style.display = 'none';
  
  const statusEl = progressBanner.querySelector('.lfp-status');
  if (statusEl) {
    const expectedNote = totalExpectedFiles > 0 && fileCount !== totalExpectedFiles
      ? ` (expected ${totalExpectedFiles})`
      : '';
    statusEl.textContent = `Download complete! ${fileCount} files${expectedNote}`;
  }
  
  const detailsEl = progressBanner.querySelector('.lfp-details');
  if (detailsEl) detailsEl.style.display = 'none';
  
  const stopBtn = progressBanner.querySelector('.lfp-stop');
  if (stopBtn) {
    stopBtn.textContent = 'Dismiss';
    stopBtn.addEventListener('click', removeProgressBanner);
  }
}

/**
 * Remove the progress banner
 */
function removeProgressBanner() {
  if (progressBanner) {
    progressBanner.remove();
    progressBanner = null;
  }
}

console.log("[libby-fetch] Content script loaded on", window.location.href);
