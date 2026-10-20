// Drop filter: decides which dropped files reach analysis (both drop paths).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAudioFile } from "./audio-drop.ts";

describe("isAudioFile", () => {
  it("accepts known extensions whatever the MIME type", () => {
    for (const name of [
      "song.mp3",
      "Song.MP3",
      "a.m4a",
      "b.flac",
      "c.wav",
      "d.ogg",
      "e.opus",
      "f.aiff",
      "g.caf",
      "h.webm",
      "i.mka",
    ]) {
      assert.equal(isAudioFile({ name, type: "" }), true, name);
      assert.equal(isAudioFile({ name, type: "application/octet-stream" }), true, name);
    }
  });
  it("accepts audio MIME types without a known extension", () => {
    for (const type of ["audio/mpeg", "audio/flac", "video/mp4", "video/webm", "application/ogg"]) {
      assert.equal(isAudioFile({ name: "download", type }), true, type);
    }
  });
  it("rejects non-audio files that merely mention an audio word", () => {
    for (const name of ["audio-notes.txt", "mp3-list.pdf", "wav.png", "song.mp3.zip"]) {
      assert.equal(isAudioFile({ name, type: "" }), false, name);
    }
    assert.equal(isAudioFile({ name: "notes", type: "text/plain" }), false);
    assert.equal(isAudioFile({ name: "clip", type: "video/quicktime" }), false);
    for (const type of ["audio/x-mpegurl", "audio/mpegurl", "audio/x-scpls", "audio/midi"]) {
      assert.equal(isAudioFile({ name: "list", type }), false, type);
    }
  });
});
