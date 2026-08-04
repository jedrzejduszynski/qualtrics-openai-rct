# Qualtrics + OpenAI RCT setup

This package implements two randomized chatbot conditions:

- **Unrestricted assistant**
- **Socratic assistant**

Both use the same OpenAI model, interface, API key, output limit, and logging structure. The system prompt is the intended treatment difference.

## Architecture

```text
Qualtrics Randomizer
  -> sets arm = socratic or unrestricted
  -> Qualtrics Web Service requests a signed session token
  -> one shared Qualtrics task block loads the Cloudflare Pages iframe
  -> iframe calls the Cloudflare Worker with the signed token
  -> Worker selects the server-side system prompt and calls OpenAI
  -> iframe sends the interaction log back to Qualtrics
```

The signed session prevents a participant from switching treatment arms by editing the browser request.

---

## 1. Prerequisites

You need:

1. A Cloudflare Free account.
2. An OpenAI API account with billing or credits enabled.
3. A Qualtrics license that permits custom JavaScript. For the secure setup, your tenant must also permit a Survey Flow **Web Service** with credentials.

Do not put the OpenAI API key in Qualtrics, HTML, JavaScript, GitHub, or a Pages file.

---

## 2. Generate two random secrets

On macOS or Linux, run twice:

```bash
openssl rand -hex 32
```

Use the first output as `SESSION_SIGNING_SECRET` and the second as `QUALTRICS_SESSION_KEY`. Store both securely.

- `SESSION_SIGNING_SECRET` signs participant session tokens and exists only in Cloudflare.
- `QUALTRICS_SESSION_KEY` authenticates the Qualtrics Web Service to Cloudflare and exists in Cloudflare and the protected Qualtrics credential store.

---

## 3. Create the Cloudflare Worker

1. In Cloudflare, open **Workers & Pages**.
2. Select **Create** and create a Worker.
3. Name it, for example, `creativity-rct-api`.
4. Open **Edit code**.
5. Replace the template with `backend/worker.js`.
6. Deploy.
7. Note the Worker base URL, for example:

```text
https://creativity-rct-api.your-subdomain.workers.dev
```

### Add Worker secrets

Worker -> **Settings** -> **Variables and Secrets** -> **Add**:

| Name | Type | Value |
|---|---|---|
| `OPENAI_API_KEY` | Secret | Your OpenAI API key |
| `SESSION_SIGNING_SECRET` | Secret | First random secret |
| `QUALTRICS_SESSION_KEY` | Secret | Second random secret |

### Add Worker text variables

| Name | Suggested value |
|---|---|
| `ALLOWED_ORIGINS` | Temporary placeholder until Pages is deployed |
| `OPENAI_MODEL` | `gpt-5.6-luna` |
| `MAX_OUTPUT_TOKENS` | `700` |
| `SESSION_TTL_SECONDS` | `14400` |
| `EXPERIMENT_VERSION` | `creativity-rct-v1` |

Deploy the updated Worker settings.

### Check the Worker

Open:

```text
https://YOUR-WORKER.workers.dev/health
```

You should receive JSON with `"status":"ok"`.

---

## 4. Configure and deploy the chat interface on Cloudflare Pages

1. Open `frontend/config.js`.
2. Replace:

```text
https://REPLACE-WITH-YOUR-WORKER.workers.dev
```

with your actual Worker base URL. Do not add `/chat` to the value.

3. In Cloudflare, open **Workers & Pages** -> **Create** -> **Pages** -> **Direct Upload**.
4. Name the project, for example, `creativity-rct-chat`.
5. Upload the contents of the `frontend` directory (or upload a zip containing those files at its root).
6. Deploy.
7. Note the Pages origin, for example:

```text
https://creativity-rct-chat.pages.dev
```

### Finish the Worker origin setting

Return to the Worker's Variables and Secrets and set:

```text
ALLOWED_ORIGINS=https://creativity-rct-chat.pages.dev
```

Use the origin only: no path and no trailing slash. Deploy the Worker settings again.

### Test the interface URL

Opening `https://YOUR-PAGES.pages.dev/embed.html` directly should show the interface and a missing-session warning. That is expected because the secure token is supplied by Qualtrics.

---

## 5. Test the backend outside Qualtrics

Edit environment values and run `test-worker.sh`, or run:

```bash
WORKER_BASE_URL="https://YOUR-WORKER.workers.dev" \
STUDY_KEY="YOUR_QUALTRICS_SESSION_KEY" \
PAGES_ORIGIN="https://YOUR-PAGES.pages.dev" \
ARM="socratic" \
./test-worker.sh
```

The script checks `/health`, obtains a signed token from `/session`, and sends one request to `/chat`.

Run again with:

```bash
ARM="unrestricted"
```

Confirm that the two responses reflect different interaction styles.

---

## 6. Build the Qualtrics task block

Create one block, for example **Creativity task**, containing:

1. A **Text/Graphic** question with the task instructions.
2. A **Text/Graphic** question containing the chatbot iframe.
3. A native **Text Entry** question for the participant's final creative output.

Keeping the final response in a normal Qualtrics question is safer than storing the primary outcome only inside custom JavaScript.

### Add the iframe

In the chatbot Text/Graphic question:

1. Open HTML or Source view.
2. Paste `qualtrics/iframe-snippet.html`.
3. Replace both instances of `REPLACE-WITH-YOUR-PAGES-SITE` with the actual Pages project hostname.

The token is passed in the URL fragment (`#token=...`). Fragments are not sent to the Pages server.

### Add the bridge JavaScript

1. Open the chatbot question options.
2. Select **Add JavaScript**.
3. Replace the generated code with `qualtrics/qualtrics-question-js.js`.
4. Replace `REPLACE-WITH-YOUR-PAGES-SITE` with the Pages project hostname.

By default, participants may continue without sending a chatbot message. To require one successful response, set:

```javascript
var REQUIRE_ONE_SUCCESSFUL_RESPONSE = true;
```

Consider carefully whether mandatory chatbot use matches the experimental estimand.

---

## 7. Declare Qualtrics Embedded Data

At the top of Survey Flow, add an **Embedded Data** element. Add every field from `qualtrics/embedded-data-fields.txt` and leave the values blank.

The essential fields are:

```text
arm
session_token
session_expires_at
assigned_arm
experiment_version
InteractionLog
session_id
chat_arm
chat_model
prompt_count
response_count
chat_error_count
chat_total_latency_ms
last_prompt
last_response
all_prompts
all_responses
```

The numbered prompt, response, and latency fields make CSV inspection easier. The full `InteractionLog` remains the lossless source.

---

## 8. Configure Qualtrics randomization

In Survey Flow, after the blank Embedded Data declaration:

1. Add a **Randomizer**.
2. Set it to present **1** of the following elements.
3. Enable **Evenly Present Elements**.
4. Nest two **Groups** under it:

```text
Randomizer: present 1, evenly
  Group: Socratic
    Embedded Data: arm = socratic

  Group: Unrestricted
    Embedded Data: arm = unrestricted
```

Do not put the task block inside both groups. Put it later, after session creation, so both conditions use exactly the same block and interface.

---

## 9. Configure the secure Qualtrics Web Service

Place a **Web Service** element immediately after the Randomizer and before the Creativity task block.

### Request

- Method: `POST`
- URL:

```text
https://YOUR-WORKER.workers.dev/session
```

- Content type: JSON
- JSON body:

```json
{
  "participant_id": "${e://Field/ResponseID}",
  "arm": "${e://Field/arm}"
}
```

### Credential

Select **Credentials** -> add an **API key** credential.

Configure it to send:

```text
Header name: X-Study-Key
Value: the same QUALTRICS_SESSION_KEY stored as the Cloudflare secret
```

The key should be stored in Qualtrics' credential store, not typed into question HTML or JavaScript.

### Map the JSON response

Test the Web Service, then map these response properties to Embedded Data fields with the same names:

```text
session_token
session_expires_at
assigned_arm
experiment_version
```

Your final Survey Flow should look like:

```text
Embedded Data declarations
Randomizer: present 1, evenly
  Group Socratic
    Embedded Data arm = socratic
  Group Unrestricted
    Embedded Data arm = unrestricted
Web Service: POST /session
Block: Creativity task
Remaining survey blocks
```

---

## 10. Verify the complete flow

Test both conditions using preview and then a published anonymous link.

For each condition confirm:

1. `arm` is set correctly.
2. `session_token` is populated before the task block.
3. The iframe loads without a missing-session error.
4. Sending a message produces a response.
5. Socratic responses ask focused questions and preserve participant authorship.
6. Unrestricted responses can directly suggest or develop ideas.
7. Both conditions use the same model and interface.
8. Refreshing restores the conversation from local storage.
9. The final creative output is stored in the native Qualtrics Text Entry question.
10. The exported CSV contains a parseable `InteractionLog`, prompt counts, responses, and the randomized `arm`.

Open browser developer tools during testing. The chatbot question should log:

```text
[RCT bridge] listening for messages from https://YOUR-PAGES.pages.dev
```

---

## 11. Freeze before the main RCT

Before recruitment begins, freeze and archive:

- `backend/worker.js`
- `frontend` files
- the two system prompts
- `OPENAI_MODEL`
- `MAX_OUTPUT_TOKENS`
- experiment version
- Qualtrics survey version

Increment `EXPERIMENT_VERSION` whenever a material prompt, model, or interface change is made.

Recommended checks:

- Run a pilot against direct-answer requests and attempts to make the Socratic assistant write the final submission.
- Manually review sample conversations from both conditions.
- Verify that no OpenAI key appears in page source, browser JavaScript, or browser network request headers.
- Set an OpenAI project spending limit and monitor usage.
- Do not log prompt or response bodies in Cloudflare console logs.

---

## 12. Editing the treatment prompts

The two prompts are at the top of `backend/worker.js` in `SYSTEM_PROMPTS`.

Keep the model, interface, token limit, and task context constant across conditions. Change only the system prompt unless another difference is explicitly part of the treatment.

After editing a prompt:

1. Update `EXPERIMENT_VERSION`.
2. Deploy the Worker.
3. Retest both arms.
4. Archive the exact deployed prompt text.
