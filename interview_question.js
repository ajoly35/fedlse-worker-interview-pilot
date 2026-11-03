// Qualtrics question JavaScript: FED/LSE AI worker interview, ONE topic per respondent,
// with Pause / Resume (v2, 2026-11-03; v1 covered all four topics in a random order).
// Paste into the "AI interview" question: question gear icon > JavaScript (replace everything).
//
// Embedded Data fields to declare in Survey Flow BEFORE the interview block:
//   set from the questionnaire: occupation, industry, employer_genai, ai_use_freq, employer_encouragement
//   set by the Randomizer:      topic = adoption | tasks | job_quality | management
//   left empty (set here):      topic_source, ai_user, el_conversation_id, el_conversation_ids,
//                               n_sessions, n_pauses, interview_completed
// Qualtrics silently drops any value set here for a field the flow does not declare.
//
// Topic assignment. The Survey Flow Randomizer sets `topic` (1 of 4, evenly presented). This page
// starts the ElevenLabs agent for that topic: each agent knows only its own topic, so it cannot
// drift into the others. If `topic` is missing or not one of the four values (for example the
// Randomizer was left out), the page draws one at random itself, so the interview still runs, and
// records topic_source = "page" instead of "qualtrics". Check topic_source in the export.
//
// How pause works (two levels):
// 1. Soft pause (default). Pause mutes the microphone and sends "[PAUSE]" to the agent, which
//    calls skip_turn and stays silent. The call stays open, so Resume continues the SAME
//    conversation ("[RESUME]"). Silence is billed at 5% of the minute rate after 10 s, and
//    no LLM tokens are used while nobody speaks.
//    Each ElevenLabs session is capped at SESSION_CAP_MS (7,200 s, the agent's maximum
//    duration), and the paused time counts towards it. So the open-call pause lasts
//    SOFT_PAUSE_MAX_MS (90 min), or less if the session cannot afford it while keeping
//    RESERVE_MS for the rest of the interview (only when paused after about minute 17).
// 2. Hard pause (fallback). If the soft pause outlasts that budget, or the call drops (phone
//    locked, app switched, network lost), the page ends the session. Resume then starts a new session and passes the
//    transcript so far to the agent. Each session has its own conversation ID; all are saved,
//    in order, in el_conversation_ids. State is also kept in the browser (localStorage), so a
//    reload of the page resumes the same interview with the same topic and agent.

Qualtrics.SurveyEngine.addOnload(function () {
  var AGENTS = {                               // one ElevenLabs agent per topic
    adoption: "agent_1901m6h59ec4ehnaq63r26k791cg",
    tasks: "agent_9101m6h59fr8fwxseh41cc64fg3k",
    job_quality: "agent_9401m6h59jxqeh29jcf58vt3y1sr",
    management: "agent_0401m6h59kr0fz89kh5v71xqzp5k"
  };
  var SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.33.0/dist/lib.iife.js";
  var RESUME_MESSAGE = "Welcome back. Whenever you're ready, just say so and we'll carry on where we left off.";
  var MAX_RESUME_CHARS = 8000;                 // tail of the transcript passed back on resume
  var NEXT_FALLBACK_MS = 130 * 60 * 1000;      // show Next anyway after 130 min on the page (past the 2 h cap)
  var SESSION_CAP_MS = 7200 * 1000;            // agent max_duration_seconds = 7200
  var RESERVE_MS = 13 * 60 * 1000;             // kept for the rest of the interview (12 min) + 1 min margin
  var SOFT_PAUSE_MAX_MS = 90 * 60 * 1000;      // open-call pause never lasts more than 90 min

  var q = this;
  q.hideNextButton();
  var ED = Qualtrics.SurveyEngine;
  var responseId = "${e://Field/ResponseID}";
  var KEY = "fedai_worker_" + responseId;

  // ---------- state (survives a page reload) ----------
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  var state = load() || { topic: null, topicSource: null, transcript: [], convIds: [], pauses: 0, completed: false };

  // ---------- topic: from the Qualtrics Randomizer, fixed once per respondent ----------
  if (!state.topic || !AGENTS[state.topic]) {
    var fromQualtrics = String(ED.getEmbeddedData("topic") || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (AGENTS[fromQualtrics]) { state.topic = fromQualtrics; state.topicSource = "qualtrics"; }
    else {                                       // fallback: draw here so the interview still runs
      var keys = Object.keys(AGENTS);
      state.topic = keys[Math.floor(Math.random() * keys.length)]; state.topicSource = "page";
    }
    save();
  }
  var AGENT_ID = AGENTS[state.topic];

  var freq = ED.getEmbeddedData("ai_use_freq") || "";
  var aiUser = /never/i.test(freq) ? "no" : "yes";

  ED.setEmbeddedData("topic", state.topic);
  ED.setEmbeddedData("topic_source", state.topicSource);
  ED.setEmbeddedData("ai_user", aiUser);

  // ---------- UI ----------
  var css = document.createElement("style");
  css.textContent =
    ".fedai{margin-top:18px;padding:18px;border:1px solid #d0d7de;border-radius:10px;font-size:16px;line-height:1.5}" +
    ".fedai button{font-size:16px;padding:10px 22px;margin:10px 10px 0 0;border-radius:8px;border:0;cursor:pointer}" +
    ".fedai .start{background:#1a7f37;color:#fff}.fedai .pause{background:#9a6700;color:#fff}" +
    ".fedai .resume{background:#0969da;color:#fff}.fedai button[disabled]{opacity:.5;cursor:default}" +
    ".fedai .status{font-weight:600}.fedai .warn{margin-top:12px;padding:10px 14px;background:#fff8c5;border-radius:8px}";
  document.head.appendChild(css);

  var box = document.createElement("div");
  box.className = "fedai";
  box.innerHTML =
    '<div class="status">Loading the interview...</div>' +
    '<div class="hint"></div>' +
    '<button type="button" class="start" disabled>Start the interview</button>' +
    '<button type="button" class="pause" style="display:none">Pause</button>' +
    '<button type="button" class="resume" style="display:none">Resume</button>';
  q.getQuestionContainer().appendChild(box);
  var $status = box.querySelector(".status"), $hint = box.querySelector(".hint");
  var $start = box.querySelector(".start"), $pause = box.querySelector(".pause"), $resume = box.querySelector(".resume");

  function show(el, on) { el.style.display = on ? "inline-block" : "none"; }
  function setUI(mode) {
    show($start, mode === "ready"); show($pause, mode === "live"); show($resume, mode === "paused");
    $start.disabled = false; $resume.disabled = false;
    if (mode === "ready") { $status.textContent = "Ready."; $hint.textContent = "Click Start, allow the microphone, then speak normally."; }
    if (mode === "connecting") { $status.textContent = "Connecting..."; $hint.textContent = ""; }
    if (mode === "live") { $status.textContent = "Interview in progress."; $hint.textContent = "Need to stop for a while? Click Pause. You can resume at any time from this page."; }
    if (mode === "paused") { $status.textContent = "Interview paused."; $hint.textContent = "Click Resume when you are ready. Your answers so far are kept. Keep this page open and your screen on: locking your phone or switching to another app may end the call. If it does, just click Resume and the interview will carry on."; }
    if (mode === "done") { $status.textContent = "Interview complete. Thank you!"; $hint.textContent = "Please click the Next button to finish the survey."; }
  }
  function warn(html) {
    if (box.querySelector(".warn")) return;
    var w = document.createElement("div"); w.className = "warn"; w.innerHTML = html; box.appendChild(w);
  }

  // ---------- save IDs to Qualtrics ----------
  function syncEmbedded() {
    ED.setEmbeddedData("el_conversation_ids", state.convIds.join(","));
    ED.setEmbeddedData("el_conversation_id", state.convIds[state.convIds.length - 1] || "");
    ED.setEmbeddedData("n_sessions", String(state.convIds.length));
    ED.setEmbeddedData("n_pauses", String(state.pauses));
    ED.setEmbeddedData("interview_completed", state.completed ? "true" : "false");
  }

  function finish() {
    state.completed = true; save(); syncEmbedded();
    setUI("done"); q.showNextButton();
  }

  // ---------- the call ----------
  var conversation = null, userPaused = false, softPaused = false, softTimer = null, sessionStart = 0;

  // ---------- keep the screen awake during the call (Screen Wake Lock API) ----------
  // Stops the phone or laptop from dimming and auto-locking while the call is open, including
  // during a pause. Supported in Chrome, Edge and Safari 16.4+. It cannot stop a respondent
  // from pressing the lock button or switching apps; the browser then releases the lock.
  var wakeLock = null;
  function keepAwake() {
    if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l; l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () {});
  }
  function letSleep() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && conversation) keepAwake();
  });

  function resumeTranscript() {
    if (!state.transcript.length) return "";
    var txt = state.transcript.map(function (m) {
      return (m.role === "agent" ? "Interviewer: " : "Respondent: ") + m.text;
    }).join("\n");
    return txt.length > MAX_RESUME_CHARS ? "..." + txt.slice(-MAX_RESUME_CHARS) : txt;
  }

  function startCall() {
    var isResume = state.transcript.length > 0;
    userPaused = false;
    setUI("connecting");
    var opts = {
      agentId: AGENT_ID,
      dynamicVariables: {
        qualtrics_response_id: responseId,
        response_id: responseId,
        occupation: ED.getEmbeddedData("occupation") || "not reported",
        industry: ED.getEmbeddedData("industry") || "not reported",
        employer_genai: ED.getEmbeddedData("employer_genai") || "not reported",
        ai_use_freq: freq || "not reported",
        employer_encouragement: ED.getEmbeddedData("employer_encouragement") || "not reported",
        ai_user: aiUser,
        resume_transcript: resumeTranscript(),
        session_number: String(state.convIds.length + 1)
      },
      clientTools: {
        end_interview: function () {
          finish();
          // let the closing sentence finish playing, then hang up
          setTimeout(function () { if (conversation) conversation.endSession(); }, 2500);
          return "ok";
        }
      },
      onConnect: function () { sessionStart = Date.now(); keepAwake(); setUI("live"); },
      onMessage: function (m) {
        if (!m || !m.message || /^\[(PAUSE|RESUME)\]/.test(m.message)) return;
        state.transcript.push({ role: m.source === "ai" ? "agent" : "user", text: m.message });
        save();
      },
      onDisconnect: function () {
        conversation = null; softPaused = false; clearTimeout(softTimer); letSleep();
        if (state.completed) return;
        if (!userPaused) {
          // dropped call, network loss or the session cap: treat as a pause
          state.pauses += 1; save(); syncEmbedded();
        }
        setUI("paused");
      },
      onError: function (e) { console.error("[FEDAI]", e); }
    };
    if (isResume) opts.overrides = { agent: { firstMessage: RESUME_MESSAGE } };

    window.ElevenLabsClient.Conversation.startSession(opts).then(function (conv) {
      conversation = conv;
      window.__fedaiConv = conv;
      var id = conv.getId();
      if (id && state.convIds.indexOf(id) < 0) { state.convIds.push(id); save(); syncEmbedded(); }
    }).catch(function (err) {
      console.error("[FEDAI] start failed", err);
      setUI(isResume ? "paused" : "ready");
      warn("<strong>The interview could not start.</strong> Please allow microphone access " +
           "(check the icon in your browser's address bar), turn off any ad blocker or privacy " +
           "extension for this site, then try again.");
    });
  }

  $start.onclick = function () { $start.disabled = true; startCall(); };
  $resume.onclick = function () {
    $resume.disabled = true;
    if (conversation && softPaused) {             // soft pause: same call continues
      clearTimeout(softTimer); softPaused = false;
      conversation.setVolume({ volume: 1 });
      conversation.setMicMuted(false);
      conversation.sendUserMessage("[RESUME]");
      setUI("live");
    } else {                                      // hard pause: new session with transcript
      startCall();
    }
  };
  $pause.onclick = function () {
    state.pauses += 1; save(); syncEmbedded();
    if (!conversation) { setUI("paused"); return; }
    softPaused = true;
    conversation.sendUserMessage("[PAUSE]");
    conversation.setMicMuted(true);
    conversation.setVolume({ volume: 0 });        // nothing is heard even if the agent speaks
    setUI("paused");
    // Open-call budget: what is left of the 7,200 s session after keeping RESERVE_MS for the
    // rest of the interview. Past it, hang up before the cap cuts the call mid-question;
    // Resume then starts a new session with the transcript (no limit on total pause time).
    var budget = SESSION_CAP_MS - (Date.now() - sessionStart) - RESERVE_MS;
    softTimer = setTimeout(function () {
      userPaused = true; softPaused = false;
      if (conversation) conversation.endSession();
    }, Math.max(Math.min(budget, SOFT_PAUSE_MAX_MS), 0));
  };

  // ---------- load the SDK ----------
  function sdkReady() {
    if (state.completed) { finish(); return; }
    setUI(state.transcript.length ? "paused" : "ready");
  }
  if (window.ElevenLabsClient) { sdkReady(); }
  else {
    var s = document.createElement("script");
    s.src = SDK_URL; s.async = true;
    s.onload = sdkReady;
    s.onerror = function () {
      $status.textContent = "The interview did not load.";
      warn("An ad blocker or privacy extension (for example uBlock Origin or Privacy Badger) may be " +
           "blocking it. Please turn it off for this site, then reload this page. Your earlier answers are saved.");
    };
    document.head.appendChild(s);
  }

  syncEmbedded();
  setTimeout(function () { q.showNextButton(); }, NEXT_FALLBACK_MS);
});

// Hang up cleanly if the respondent leaves the page mid-call.
Qualtrics.SurveyEngine.addOnUnload(function () {
  try { if (window.__fedaiConv) window.__fedaiConv.endSession(); } catch (e) {}
});
