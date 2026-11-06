// Qualtrics question JavaScript: FED/LSE AI worker interview, MICROPHONE AND SOUND TEST (v1, 2026-11-05).
// Goes on its own page right after consent / instructions, before any survey question.
// Paste into the "Mic test" question: question gear icon > JavaScript (replace everything).
// The question itself can be a Descriptive Text item with no text (the script draws the page).
//
// Embedded Data fields to declare in Survey Flow BEFORE this block (left empty, set here):
//   mic_test_passed      "true" | "false"      (also "" if the respondent never clicked Start)
//   mic_test_tries       number of calls started (0, 1 or 2)
//   mic_test_result      pass | no_reply | not_connected | sdk_blocked | skipped   (last attempt)
//   mic_test_conversation_ids   ElevenLabs conversation IDs of the test calls, comma separated
// Branch on mic_test_passed after this block: "false" -> exit page, or the survey without the interview.
//
// Flow. Start test -> the browser asks for the microphone -> the agent says "If you can hear me,
// please say the word blue" (the word is never shown on the page) -> any reply counts: the agent
// says "Thank you, that worked..." and calls the mic_test_passed client tool -> the page hangs up
// (microphone off) and only then shows the Continue button. If the agent hears nothing it asks
// once more (agent turn timeout 8 s); still nothing -> it calls mic_test_failed. The page also fails
// on its own if nothing was heard NO_REPLY_MS after the call connected, if the call did not connect
// within CONNECT_MS, or if the SDK did not load (ad blocker). A failure shows the checks (volume,
// microphone, ad blocker) and a Try again button. After MAX_TRIES failed calls, mic_test_passed is
// set to "false" and the Continue button appears, so the survey flow can route them.
//
// Same embedding as the interview: @elevenlabs/client 1.33.0, Conversation.startSession({agentId}),
// client tools. The test agent gets no dynamic variables and no survey data.

Qualtrics.SurveyEngine.addOnload(function () {
  var AGENT_ID = "agent_2001m6ph5eape2y8xbwmtxsczeav";   // "FED/LSE AI worker interview: Mic and sound test"
  var SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.33.0/dist/lib.iife.js";
  var MAX_TRIES = 2;
  var CONNECT_MS = 15 * 1000;        // call must connect within 15 s
  var NO_REPLY_MS = 32 * 1000;       // first message ~6 s + 8 s silence + repeat ~6 s + 8 s silence, plus margin
  var HANGUP_DELAY_MS = 2500;        // let "Thank you, that worked..." finish before hanging up

  var q = this;
  q.hideNextButton();
  var ED = Qualtrics.SurveyEngine;
  var responseId = "${e://Field/ResponseID}";
  var KEY = "fedai_mictest_" + responseId;

  // ---------- state (survives a page reload) ----------
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  var state = load() || { tries: 0, passed: null, result: "", convIds: [] };

  function syncEmbedded() {
    ED.setEmbeddedData("mic_test_passed", state.passed === null ? "" : (state.passed ? "true" : "false"));
    ED.setEmbeddedData("mic_test_tries", String(state.tries));
    ED.setEmbeddedData("mic_test_result", state.result);
    ED.setEmbeddedData("mic_test_conversation_ids", state.convIds.join(","));
  }

  // ---------- UI ----------
  var css = document.createElement("style");
  css.textContent =
    ".fedmic{margin-top:18px;padding:18px;border:1px solid #d0d7de;border-radius:10px;font-size:16px;line-height:1.5}" +
    ".fedmic button{font-size:16px;padding:10px 22px;margin:10px 10px 0 0;border-radius:8px;border:0;cursor:pointer}" +
    ".fedmic .start{background:#1a7f37;color:#fff}.fedmic .retry{background:#0969da;color:#fff}" +
    ".fedmic button[disabled]{opacity:.5;cursor:default}.fedmic .status{font-weight:600}" +
    ".fedmic .help{margin-top:12px;padding:12px 16px;background:#fff8c5;border-radius:8px}.fedmic .help ol{margin:8px 0 0 18px;padding:0}";
  document.head.appendChild(css);

  var box = document.createElement("div");
  box.className = "fedmic";
  box.innerHTML =
    '<p>Before the survey, a quick check that your microphone and sound work. Click <strong>Start test</strong>, ' +
    'allow the microphone when your browser asks, and answer out loud. It takes about 20 seconds.</p>' +
    '<div class="status">Loading...</div><div class="hint"></div>' +
    '<button type="button" class="start" disabled>Start test</button>' +
    '<button type="button" class="retry" style="display:none">Try again</button>' +
    '<div class="help" style="display:none"></div>';
  q.getQuestionContainer().appendChild(box);
  var $status = box.querySelector(".status"), $hint = box.querySelector(".hint");
  var $start = box.querySelector(".start"), $retry = box.querySelector(".retry"), $help = box.querySelector(".help");

  function show(el, on) { el.style.display = on ? "inline-block" : "none"; }
  function setUI(mode, text) {
    show($start, mode === "ready"); show($retry, mode === "failed");
    $start.disabled = false; $retry.disabled = false;
    $help.style.display = mode === "failed" || mode === "gaveup" ? "block" : "none";
    if (mode === "ready") { $status.textContent = "Ready."; $hint.textContent = ""; }
    if (mode === "connecting") { $status.textContent = "Connecting..."; $hint.textContent = "If your browser asks, allow the microphone."; }
    if (mode === "live") { $status.textContent = "Listening..."; $hint.textContent = "Answer out loud when you hear the question."; }
    if (mode === "passed") { $status.textContent = "Your microphone and sound work."; $hint.textContent = "The microphone is now off. Please click Continue to go to the survey."; }
    if (mode === "failed") { $status.textContent = "That did not work."; $hint.textContent = text || ""; }
    if (mode === "gaveup") { $status.textContent = "The test did not work on this device."; $hint.textContent = "Please click Continue. You can still take the survey; the voice interview may not be possible on this device."; }
  }
  var HELP =
    "<strong>Please check, then try again:</strong><ol>" +
    "<li><strong>Volume</strong>: turn it up, take the device off silent, and unplug headphones you are not using.</li>" +
    "<li><strong>Microphone</strong>: allow it for this site. Click the lock or camera icon in the address bar and set Microphone to Allow. On a phone, also check Settings &gt; the browser app &gt; Microphone.</li>" +
    "<li><strong>Ad blockers and privacy extensions</strong>: turn them off for this site, or open the survey in another browser (Chrome, Safari or Edge), then reload.</li>" +
    "<li><strong>Work laptop</strong>: if the microphone is blocked by your IT settings, try a personal device or phone.</li></ol>";

  function showResult() {                          // final screen: Continue button appears only here
    setUI(state.passed ? "passed" : "gaveup");
    if (!state.passed) $help.innerHTML = HELP;
    q.showNextButton();
  }
  function finish(passed, result) {
    if (state.passed !== null) return;
    state.passed = passed; state.result = result; save(); syncEmbedded();
    showResult();
  }

  // ---------- the call ----------
  var conversation = null, heard = false, done = false, connectTimer = null, replyTimer = null;

  function clearTimers() { clearTimeout(connectTimer); clearTimeout(replyTimer); }
  function hangUp() { clearTimers(); if (conversation) { try { conversation.endSession(); } catch (e) {} } conversation = null; }

  function pass() {
    if (done) return; done = true; heard = true;
    setTimeout(hangUp, HANGUP_DELAY_MS);             // the microphone is released when the session ends
    finish(true, "pass");
  }

  function fail(result, text) {
    if (done) return; done = true;
    hangUp();
    state.result = result; save(); syncEmbedded();
    if (state.tries >= MAX_TRIES) { finish(false, result); return; }
    setUI("failed", text); $help.innerHTML = HELP;
  }

  function startCall() {
    done = false; heard = false;
    state.tries += 1; save(); syncEmbedded();
    setUI("connecting");
    connectTimer = setTimeout(function () { fail("not_connected", "The call did not connect."); }, CONNECT_MS);
    window.ElevenLabsClient.Conversation.startSession({
      agentId: AGENT_ID,
      clientTools: {
        mic_test_passed: function () { pass(); return "ok"; },
        mic_test_failed: function () { fail("no_reply", "We could not hear you."); return "ok"; }
      },
      onConnect: function () {
        if (done) return;                              // timed out already: the late session is closed below
        clearTimeout(connectTimer); setUI("live");
        replyTimer = setTimeout(function () { if (!heard) fail("no_reply", "We could not hear you."); }, NO_REPLY_MS);
      },
      onMessage: function (m) { if (m && m.source === "user" && m.message) heard = true; },
      onDisconnect: function () {
        conversation = null;
        if (!done) fail("not_connected", "The call ended before the test finished.");
      },
      onError: function (e) { console.error("[FEDMIC]", e); }
    }).then(function (conv) {
      if (done) { try { conv.endSession(); } catch (e) {} return; }   // e.g. microphone allowed after the timeout
      conversation = conv; window.__fedmicConv = conv;
      var id = conv.getId();
      if (id && state.convIds.indexOf(id) < 0) { state.convIds.push(id); save(); syncEmbedded(); }
    }).catch(function (err) {
      console.error("[FEDMIC] start failed", err);
      var denied = /NotAllowed|Permission|denied/i.test(String(err && (err.name + " " + err.message)));
      fail("not_connected", denied ? "The microphone was not allowed." : "The call could not start.");
    });
  }

  $start.onclick = function () { $start.disabled = true; startCall(); };
  $retry.onclick = function () { $retry.disabled = true; startCall(); };

  // ---------- load the SDK ----------
  function sdkReady() {
    if (state.passed !== null) { showResult(); return; }                        // reload after a result
    if (state.tries >= MAX_TRIES) { finish(false, state.result || "no_reply"); return; }
    setUI(state.tries ? "failed" : "ready", "The test was interrupted."); if (state.tries) $help.innerHTML = HELP;
  }
  if (window.ElevenLabsClient) { sdkReady(); }
  else {
    var s = document.createElement("script");
    s.src = SDK_URL; s.async = true;
    s.onload = sdkReady;
    s.onerror = function () {
      $status.textContent = "The test did not load.";
      $help.style.display = "block";
      $help.innerHTML = "<strong>An ad blocker or privacy extension (for example uBlock Origin or Privacy Badger) may be blocking it.</strong> " +
        "Please turn it off for this site, or open the survey in another browser (Chrome, Safari or Edge), then reload this page. " +
        "<button type=\"button\" class=\"retry\" onclick=\"location.reload()\">Reload</button>";
      state.result = "sdk_blocked"; save(); syncEmbedded();
      setTimeout(function () { if (state.passed === null) finish(false, "sdk_blocked"); }, 60 * 1000);   // way out after 1 min
    };
    document.head.appendChild(s);
  }
  syncEmbedded();
});

// Hang up (microphone off) if the respondent leaves the page mid-test.
Qualtrics.SurveyEngine.addOnUnload(function () {
  try { if (window.__fedmicConv) window.__fedmicConv.endSession(); } catch (e) {}
});
