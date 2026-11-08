import test from "node:test";
import assert from "node:assert/strict";
import { Annotations } from "../src/annotations.js";
import { appendAnnotationDraft } from "../src/annotation-drafts.js";

test("annotations wait for composer acknowledgement and stay scoped to their conversation/client", async () => {
  const notes = new Annotations({});
  const request = { sessionId: "one", requestId: "note", content: [{ type: "text", text: "Fix button" }] };
  const pending = notes.enqueue(request);
  const poll = (client, sessionId, revision, acknowledgements = []) => notes.currentSession({ client, sessionId, revision, active: true, acknowledgements });
  assert.equal(poll("a", "two", 1).drafts.length, 0);
  assert.deepEqual(poll("b", "one", 1).drafts, [request]);
  assert.equal(poll("c", "one", 1, [{ id: "note" }]).drafts.length, 0);
  assert.equal(notes.pending.size, 1);
  assert.deepEqual(poll("b", "one", 2, [{ id: "note" }]).drafts, []);
  assert.deepEqual(await pending, { accepted: true });
  assert.equal(notes.pending.size, 0); await notes.close();
});

test("multiple annotations append to existing text and attachments without submitting", () => {
  const state = { draft: "Existing @reference", draftRev: 1, phase: "idle", attachmentIds: ["existing"] };
  const projection = { detectText: "Existing \ufffc" };
  const shell = { projection, state: { getSnapshot: () => state }, actions: {
    insertText(text, span) { assert.equal(span.start, projection.detectText.length); assert.equal(span.end, span.start); assert.equal(span.draftRev, state.draftRev); state.draft += text; projection.detectText += text; state.draftRev++; return true; },
    addAttachments(ids) { state.attachmentIds.push(...ids); return true; },
    removeAttachment(id) { state.attachmentIds = state.attachmentIds.filter(item => item !== id); },
    submit() { assert.fail("annotations must not submit"); },
  } };
  const conversation = { input: { shell: () => shell }, createDrafts(_id, files) { assert.equal(files[0].type, "image/png"); return [{ id: "image" }]; }, releaseDraftAttachment() { assert.fail("retained attachment released"); } };
  assert.equal(appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "First note" }, { type: "image", data: "aGk=", mediaType: "image/png" }] }), true);
  assert.equal(appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "Second note" }] }), true);
  assert.match(state.draft, /^Existing @reference\n\nFirst note\n\n\nSecond note/);
  assert.deepEqual(state.attachmentIds, ["existing", "image"]);
  state.phase = "submitting";
  assert.equal(appendAnnotationDraft(conversation, { content: [] }), false);
});

test("the reference-chip path needs no persistDraft (DSH InputActions has none)", () => {
  // Regression: 0.8.3 called shell.actions.persistDraft() after a successful chip insert.
  // DSH 0.2.0-rc.2 has no such method, so the call threw AFTER the chip landed; the caller
  // never acknowledged the draft and its one-second poll re-inserted it ~20 times.
  const chips = [];
  const state = { draftRev: 1, phase: "plain", attachmentIds: [] };
  const shell = {
    projection: { detectText: "" },
    state: { getSnapshot: () => state },
    insertReference(reference, span) {
      assert.equal(reference.label, "页面批注");
      assert.equal(span.draftRev, state.draftRev);
      chips.push(reference.clipboardText); state.draftRev++;
      return true;
    },
    actions: {
      addAttachments() { return true; }, removeAttachment() {},
      insertText() { assert.fail("the chip path must not fall back to plain text"); },
      submit() { assert.fail("annotations must not submit"); },
    },
  };
  const conversation = { input: { shell: () => shell }, createDrafts() { return []; }, releaseDraftAttachment() {} };
  assert.equal(appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "Fix the title" }] }), true);
  assert.equal(chips.length, 1);
  assert.match(chips[0], /^<doyourweb_annotation>\nFix the title\n<\/doyourweb_annotation>$/);
});

test("a refused chip insert reports false so the caller can retry or fail loudly", () => {
  const state = { draftRev: 3, phase: "plain", attachmentIds: [] };
  const shell = {
    projection: { detectText: "" },
    state: { getSnapshot: () => state },
    insertReference() { return false; },
    actions: { addAttachments() { return true; }, removeAttachment() {}, insertText() { return false; }, submit() { assert.fail("never submit"); } },
  };
  const conversation = { input: { shell: () => shell }, createDrafts() { return []; }, releaseDraftAttachment() {} };
  assert.equal(appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "note" }] }), false);
});
