(() => {
  "use strict";

  const config = window.RCT_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(
    window.location.hash.replace(/^#/, "")
  );

  const taskId = params.get("task") || config.taskId || "main";
  const sessionToken = hashParams.get("token") || "";
  const workerBaseUrl = String(config.workerBaseUrl || "").replace(/\/$/, "");
  const maxPrompts = Number(config.maxPrompts || 20);

  const elements = {
    title: document.getElementById("chat-title"),
    welcome: document.getElementById("welcome-text"),
    status: document.getElementById("status"),
    messages: document.getElementById("messages"),
    input: document.getElementById("chat-input"),
    send: document.getElementById("send-button")
  };

  // Conversation data exists only in memory while this page remains open.
  // It is not stored in localStorage and is not sent to Qualtrics.
  const messages = [];
  let promptCount = 0;

  elements.title.textContent =
    config.interfaceTitle || "AI assistant";

  elements.welcome.textContent =
    config.welcomeText ||
    "Use the assistant to support your work on the task.";

  elements.input.placeholder =
    config.inputPlaceholder || "Type a message...";

  if (!workerBaseUrl || workerBaseUrl.includes("REPLACE-WITH")) {
    showFatal("The chat backend URL has not been configured.");
    return;
  }

  if (!sessionToken) {
    showFatal(
      "The secure study session is missing. Please reload the survey or contact the researcher."
    );
    return;
  }

  setStatus("Ready");
  postHeight();

  elements.send.addEventListener("click", sendMessage);

  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  window.addEventListener("resize", postHeight);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(postHeight).observe(document.body);
  }

  async function sendMessage() {
    const content = elements.input.value.trim();

    if (!content || elements.send.disabled) {
      return;
    }

    if (promptCount >= maxPrompts) {
      setStatus(
        `The maximum of ${maxPrompts} messages has been reached.`,
        true
      );
      return;
    }

    elements.input.value = "";

    appendMessage("user", content);

    messages.push({
      role: "user",
      content
    });

    promptCount += 1;

    setBusy(true);
    setStatus("Assistant is responding...");

    try {
      const response = await fetch(`${workerBaseUrl}/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task_id: taskId,
          messages
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.detail ||
            data.error ||
            `Request failed with status ${response.status}`
        );
      }

      const reply = String(data.content || "").trim();

      if (!reply) {
        throw new Error("The assistant returned an empty response.");
      }

      appendMessage("assistant", reply);

      messages.push({
        role: "assistant",
        content: reply
      });

      setStatus("Ready");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown chat error";

      appendMessage(
        "system",
        `The assistant is temporarily unavailable: ${message}`
      );

      setStatus(
        "The assistant request failed. You can try again.",
        true
      );
    } finally {
      setBusy(false);
      elements.input.focus();
      postHeight();
    }
  }

  function appendMessage(role, content) {
    const bubble = document.createElement("div");

    bubble.className = `message ${role}`;
    bubble.textContent = content;

    elements.messages.appendChild(bubble);
    elements.messages.scrollTop =
      elements.messages.scrollHeight;

    postHeight();
  }

  function setBusy(isBusy) {
    elements.send.disabled = isBusy;
    elements.input.disabled = isBusy;
    elements.send.textContent =
      isBusy ? "Sending..." : "Send";
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

  function postHeight() {
    const height = Math.max(
      540,
      Math.ceil(document.documentElement.scrollHeight)
    );

    window.parent.postMessage(
      {
        type: "rct_height",
        value: height
      },
      "*"
    );
  }
})();