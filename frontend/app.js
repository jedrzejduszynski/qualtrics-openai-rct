(() => {
  "use strict";

  const config = window.RCT_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const participantId = params.get("pid") || "anonymous";
  const arm = params.get("arm") || "unknown";
  const taskId = params.get("task") || config.taskId || "main";
  const sessionToken = hashParams.get("token") || "";
  const workerBaseUrl = String(config.workerBaseUrl || "").replace(/\/$/, "");
  const maxPrompts = Number(config.maxPrompts || 20);
  const storageKey = `creativity_rct_chat_${participantId}_${arm}`;

  const elements = {
    title: document.getElementById("chat-title"),
    welcome: document.getElementById("welcome-text"),
    status: document.getElementById("status"),
    messages: document.getElementById("messages"),
    input: document.getElementById("chat-input"),
    send: document.getElementById("send-button")
  };

  const state = loadState() || {
    session_id: crypto.randomUUID(),
    participant_id: participantId,
    arm,
    task_id: taskId,
    frontend_version: "2026-07-30.1",
    model_used: null,
    started_at: new Date().toISOString(),
    events: [],
    messages: [],
    prompt_count: 0,
    response_count: 0,
    error_count: 0,
    total_latency_ms: 0
  };

  elements.title.textContent = config.interfaceTitle || "AI assistant";
  elements.welcome.textContent = config.welcomeText || "Use the assistant to support your work on the task.";
  elements.input.placeholder = config.inputPlaceholder || "Type a message...";

  if (!workerBaseUrl || workerBaseUrl.includes("REPLACE-WITH")) {
    showFatal("The chat backend URL has not been configured.");
    return;
  }
  if (!sessionToken) {
    showFatal("The secure study session is missing. Please reload the survey or contact the researcher.");
    return;
  }

  renderAllMessages();
  setStatus("Ready");
  postLog();
  postHeight();

  elements.send.addEventListener("click", sendMessage);
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  window.addEventListener("resize", postHeight);
  new ResizeObserver(postHeight).observe(document.body);

  async function sendMessage() {
    const content = elements.input.value.trim();
    if (!content || elements.send.disabled) return;
    if (state.prompt_count >= maxPrompts) {
      setStatus(`The maximum of ${maxPrompts} messages has been reached.`, true);
      return;
    }

    elements.input.value = "";
    appendMessage("user", content);
    state.messages.push({ role: "user", content });
    state.prompt_count += 1;
    state.events.push({ type: "prompt", ts: new Date().toISOString(), content });
    persistAndPost();

    setBusy(true);
    setStatus("Assistant is responding...");
    const startedAt = performance.now();

    try {
      const response = await fetch(`${workerBaseUrl}/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ task_id: taskId, messages: state.messages })
      });

      const data = await response.json().catch(() => ({}));
      const localLatency = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        throw new Error(data.detail || data.error || `Request failed with status ${response.status}`);
      }

      const reply = String(data.content || "").trim();
      if (!reply) throw new Error("The assistant returned an empty response.");

      appendMessage("assistant", reply);
      state.messages.push({ role: "assistant", content: reply });
      state.response_count += 1;
      state.model_used = data.model || state.model_used;
      state.total_latency_ms += Number(data.latency_ms || localLatency);
      state.events.push({
        type: "response",
        ts: new Date().toISOString(),
        content: reply,
        latency_ms: Number(data.latency_ms || localLatency),
        response_id: data.response_id || null,
        request_id: data.request_id || null,
        model: data.model || null,
        usage: data.usage || null
      });
      setStatus("Ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown chat error";
      state.error_count += 1;
      state.events.push({ type: "error", ts: new Date().toISOString(), error: message });
      appendMessage("system", `The assistant is temporarily unavailable: ${message}`);
      setStatus("The assistant request failed. You can try again.", true);
    } finally {
      setBusy(false);
      persistAndPost();
      elements.input.focus();
    }
  }

  function appendMessage(role, content) {
    const bubble = document.createElement("div");
    bubble.className = `message ${role}`;
    bubble.textContent = content;
    elements.messages.appendChild(bubble);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function renderAllMessages() {
    elements.messages.innerHTML = "";
    for (const message of state.messages) appendMessage(message.role, message.content);
  }

  function setBusy(isBusy) {
    elements.send.disabled = isBusy;
    elements.input.disabled = isBusy;
    elements.send.textContent = isBusy ? "Sending..." : "Send";
  }

  function setStatus(text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle("error", isError);
  }

  function showFatal(message) {
    elements.messages.innerHTML = "";
    appendMessage("system", message);
    elements.input.disabled = true;
    elements.send.disabled = true;
    setStatus("Configuration error", true);
    postHeight();
  }

  function loadState() {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      if (parsed.participant_id !== participantId || parsed.arm !== arm) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function persistAndPost() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* non-fatal */ }
    postLog();
    postHeight();
  }

  function postLog() {
    window.parent.postMessage({ type: "rct_log_update", payload: state }, "*");
  }

  function postHeight() {
    const height = Math.max(540, Math.ceil(document.documentElement.scrollHeight));
    window.parent.postMessage({ type: "rct_height", value: height }, "*");
  }
})();
