Let's build a chrome browser extension. It should present a more prominent toolbar icon when we detect that we're on an overdrive audiobook page. An example of such a URL is https://<some subdomain>.listen.overdrive.com/. When the user clicks the toolbar button on such a page, we should present a popup that offers to download the book, pre-filling the directory name based on the title of the book.

To "download", what we'll do is watch network traffic for requests to the odrmediaclips.cachefly.net and audioclips.cdn.overdrive.com domains. Whenever we encounter such a request, we should make a request to the same URL. It seems to be a signed URL, so we don't need to rely on the user's cookies to do it. Note that these requests use the `Range` header to ask for smaller bites of each file-- we will request the whole thing but we'll need to be careful not to download the same file multiple times.

Once that's set up, we'll scrub through the audiobook, triggering requests for each audio file in order. We'll start at the beginning of the book and keep track of the order in which they're sent out, so we know how to name the file downloads.

You can see an example script that's working in ../libby-download/. However, our implementation has some important differences:

- that one uses playwright, but we'll be limited to the APIs available to chrome extensions.
- That one needs to present a progress bar, but the audiobook page itself will have a progress bar (how far through the book we are), so we can skip that.
- libby-download handles signing into the website, but we can assume this has already happened, as we're piggybacking on the user's cookies.

Some preferences:

- Please use `pnpm` rather than `npm`.
- Please use typescript.
- No need to make a generic web-extension; it's okay if this only runs on chrome.
- Let's use manifest version 3

To start with, figure out which permissions you'll need to request in the manifest. Please ask me any clarifying questions you'll need before beginning to code.
