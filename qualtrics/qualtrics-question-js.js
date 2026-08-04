Qualtrics.SurveyEngine.addOnload(function () {
  var iframe = document.getElementById("rct-chat-frame");
  var EXPECTED_ORIGIN = "https://jedrzejduszynski.github.io";

  if (!iframe) {
    console.error("[RCT iframe] iframe not found.");
    return;
  }

  function handleMessage(event) {
    if (event.origin !== EXPECTED_ORIGIN) return;
    if (event.source !== iframe.contentWindow) return;
    if (!event.data || typeof event.data !== "object") return;

    if (event.data.type === "rct_height") {
      var height = Math.max(
        540,
        Math.min(1200, Number(event.data.value) || 640)
      );

      iframe.style.height = height + "px";
    }
  }

  window.addEventListener("message", handleMessage);

  this.addOnUnload(function () {
    window.removeEventListener("message", handleMessage);
  });
});