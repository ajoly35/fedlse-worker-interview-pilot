# FED/LSE AI worker interview: pilot tester site

Static copy of the Qualtrics pages, served at https://ajoly35.github.io/fedlse-worker-interview-pilot/ (GitHub Pages, `main`).
The two question scripts are the exact JavaScript pasted into Qualtrics; `index.html` only wraps them in a stand-in for the Qualtrics page API.

| File | Qualtrics page | ElevenLabs agent |
|---|---|---|
| `mic_test_question.js` | Microphone and sound test, right after consent / instructions | `agent_2001m6ph5eape2y8xbwmtxsczeav` "FED/LSE AI worker interview: Mic and sound test" |
| `interview_question.js` | The interview (one topic per respondent, pause / resume) | one agent per topic (IDs in the file) |

Tester link: `?t=INITIALS` (and optionally `&topic=adoption|tasks|job_quality|management`). Steps on the tester site: setup, mic test, questionnaire, instructions, interview, done.

## Mic test: what it does

1. **Start test** starts an ElevenLabs call (same SDK and embedding as the interview) and triggers the browser's microphone prompt.
2. The agent says: "Hi, this is a short test of your microphone and sound. If you can hear me, please say the word blue." The word is never shown on the page.
3. Any reply counts ("blue", "yes, I can hear you", anything else). The agent says "Thank you, that worked. Please click the button on the page to continue to the survey." and calls the `mic_test_passed` client tool. The page hangs up 2.5 s later (microphone off), and only then shows **Continue to the survey**.
4. No reply: the agent asks once more after 8 s of silence (agent `turn_timeout`). Still nothing: it calls `mic_test_failed`. The page also fails on its own after 32 s without a reply, after 15 s without a connection, or if the SDK does not load (ad blocker).
5. A failure shows the checks (volume, microphone permission, ad blockers, work laptop) and **Try again**. After 2 failed calls the page sets `mic_test_passed = "false"` and shows **Continue**, so the Survey Flow can route the respondent.

The test agent gets no dynamic variables and no survey data. Its privacy settings are identical to the interview agents (recording on, no retention limit, no redaction, no zero-retention mode); it has no data collection or evaluation criteria. Call length is capped by the page (about 47 s worst case) and by the agent at 600 s.

## Qualtrics setup

**Mic test page** (one block, right after consent / instructions, nothing else on the page):
- Add a Descriptive Text question with no text. Question gear > JavaScript > replace everything with `mic_test_question.js`.
- Survey Flow, **before** this block, Embedded Data (leave values empty): `mic_test_passed`, `mic_test_tries`, `mic_test_result`, `mic_test_conversation_ids`.
- Survey Flow, **after** this block: Branch `If mic_test_passed Is Equal to false` -> end of survey (exit page) or skip the interview block, as the team decides. (`mic_test_result` says why: `no_reply`, `not_connected`, `sdk_blocked`.)
- The Next button is hidden by the script until the test passes or fails twice. Do not add a timer or auto-advance.

**Interview page**: as before, see the header of `interview_question.js` (embedded data `occupation`, `industry`, `employer_genai`, `ai_use_freq`, `employer_encouragement`, `topic` from the Randomizer, and the output fields `topic_source`, `ai_user`, `el_conversation_id`, `el_conversation_ids`, `n_sessions`, `n_pauses`, `interview_completed`).

Qualtrics silently drops any value set for a field the flow does not declare.

## Microphone permission later in the survey

The browser remembers the microphone decision per site, so after a pass the interview page normally starts without a second prompt in Chrome, Edge and Android Chrome. Two known exceptions:
- **Safari (iPhone and Mac)** may ask again on each page load. The interview page already handles a prompt: Start, allow, and the call begins.
- **A different domain** (for example a custom survey domain, or Qualtrics in an iframe) counts as a different site. Keep both pages in the same survey, same domain.

## Device test checklist (to do on real devices)

| Case | Expected |
|---|---|
| Microphone denied in the prompt | "The microphone was not allowed." + checks + Try again; second denial -> Continue, `mic_test_passed=false`, `mic_test_result=not_connected` |
| Ad blocker (uBlock Origin, Privacy Badger) on | "The test did not load." + reload advice; after 1 min a way out (`sdk_blocked`) |
| No sound (volume 0) and silence | agent re-asks once, then fails: `no_reply`; Try again |
| iPhone Safari, Android Chrome | prompt appears on Start test; pass; interview page later starts (Safari may prompt again) |
| Work laptop with microphone blocked by IT | `not_connected` twice -> Continue; respondent routed by the flow |
| Reload mid-test or after the result | state is kept in localStorage per ResponseID; the result and Continue button come back |
