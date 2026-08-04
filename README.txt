Start with SETUP.md.

Main files:
- backend/worker.js: paste into one Cloudflare Worker.
- frontend/: upload to one Cloudflare Pages project after editing config.js.
- qualtrics/iframe-snippet.html: paste into the chatbot Text/Graphic question.
- qualtrics/qualtrics-question-js.js: paste into that question's JavaScript panel.
- qualtrics/embedded-data-fields.txt: declare these fields in Survey Flow.
- test-worker.sh: end-to-end backend test.
