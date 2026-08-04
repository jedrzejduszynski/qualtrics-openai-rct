Qualtrics.SurveyEngine.addOnload(function () {
  var qThis = this;
  var EXPECTED_ORIGIN = "https://jedrzejduszynski.github.io";
  var REQUIRE_ONE_SUCCESSFUL_RESPONSE = false;
  var iframe = document.getElementById("rct-chat-frame");

  if (!iframe) {
    console.error("[RCT bridge] iframe #rct-chat-frame not found.");
    return;
  }

  if (REQUIRE_ONE_SUCCESSFUL_RESPONSE) qThis.hideNextButton();

  function writeEmbeddedData(log) {
    var events = Array.isArray(log.events) ? log.events : [];
    var prompts = events.filter(function (event) { return event.type === "prompt"; });
    var responses = events.filter(function (event) { return event.type === "response"; });
    var errors = events.filter(function (event) { return event.type === "error"; });

    Qualtrics.SurveyEngine.setEmbeddedData("InteractionLog", JSON.stringify(log));
    Qualtrics.SurveyEngine.setEmbeddedData("session_id", log.session_id || "");
    Qualtrics.SurveyEngine.setEmbeddedData("chat_arm", log.arm || "");
    Qualtrics.SurveyEngine.setEmbeddedData("chat_model", log.model_used || "");
    Qualtrics.SurveyEngine.setEmbeddedData("frontend_version", log.frontend_version || "");
    Qualtrics.SurveyEngine.setEmbeddedData("prompt_count", String(log.prompt_count || 0));
    Qualtrics.SurveyEngine.setEmbeddedData("response_count", String(log.response_count || 0));
    Qualtrics.SurveyEngine.setEmbeddedData("chat_error_count", String(log.error_count || errors.length || 0));
    Qualtrics.SurveyEngine.setEmbeddedData("chat_total_latency_ms", String(log.total_latency_ms || 0));
    Qualtrics.SurveyEngine.setEmbeddedData("last_prompt", prompts.length ? prompts[prompts.length - 1].content : "");
    Qualtrics.SurveyEngine.setEmbeddedData("last_response", responses.length ? responses[responses.length - 1].content : "");
    Qualtrics.SurveyEngine.setEmbeddedData("all_prompts", prompts.map(function (event) { return event.content; }).join("\n---\n"));
    Qualtrics.SurveyEngine.setEmbeddedData("all_responses", responses.map(function (event) { return event.content; }).join("\n---\n"));

    for (var index = 0; index < 20; index += 1) {
      Qualtrics.SurveyEngine.setEmbeddedData("prompt_" + (index + 1), prompts[index] ? prompts[index].content : "");
      Qualtrics.SurveyEngine.setEmbeddedData("response_" + (index + 1), responses[index] ? responses[index].content : "");
      Qualtrics.SurveyEngine.setEmbeddedData("response_latency_ms_" + (index + 1), responses[index] ? String(responses[index].latency_ms || "") : "");
    }

    if (REQUIRE_ONE_SUCCESSFUL_RESPONSE && responses.length > 0) qThis.showNextButton();
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== EXPECTED_ORIGIN) return;
    if (event.source !== iframe.contentWindow) return;
    if (!event.data || typeof event.data !== "object") return;

    if (event.data.type === "rct_log_update" && event.data.payload) {
      writeEmbeddedData(event.data.payload);
    }

    if (event.data.type === "rct_height") {
      var height = Math.max(540, Math.min(1200, Number(event.data.value) || 640));
      iframe.style.height = height + "px";
    }
  });

  console.log("[RCT bridge] listening for messages from " + EXPECTED_ORIGIN);
});
