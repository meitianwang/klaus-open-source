import { describe, expect, test } from "bun:test";
import type {
  PetFormAttention,
  PetQuestionAttention,
} from "../../../contracts/desktop-pet-attention";
import {
  canSubmitQuestion,
  initialFormValues,
  questionResponse,
} from "./attention-model";

describe("desktop attention response shapes", () => {
  test("legacy choice requests keep positional answer ordering", () => {
    const attention: PetQuestionAttention = {
      kind: "question",
      id: "r1",
      responseChannel: "elicit",
      responseMode: "values",
      questions: [
        { question: "First", options: [] },
        { question: "Second", options: [] },
      ],
    };
    expect(questionResponse(attention, { Second: "B", First: "A" })).toEqual({
      kind: "accept",
      values: ["A", "B"],
    });
  });
  test("structured question requests keep exact question keys and freeform content", () => {
    const attention: PetQuestionAttention = {
      kind: "question",
      id: "r2",
      responseChannel: "async-question",
      responseMode: "answers",
      questions: [{ question: "Where?", options: [] }],
    };
    expect(
      questionResponse(attention, { "Where?": "A custom path with spaces" }),
    ).toEqual({
      kind: "answers",
      answers: { "Where?": "A custom path with spaces" },
    });
  });
  test("form defaults preserve false and zero and clone array defaults", () => {
    const attention: PetFormAttention = {
      kind: "mcp-form",
      id: "r3",
      schema: {
        properties: {
          allowed: { type: "boolean" },
          limit: { type: "integer", default: 0 },
          tags: { type: "array", default: ["one"] },
          title: { type: "string" },
        },
      },
    };
    const values = initialFormValues(attention);
    expect(values).toEqual({ allowed: false, limit: 0, tags: ["one"] });
    (values.tags as string[]).push("two");
    expect(attention.schema.properties.tags.default).toEqual(["one"]);
  });
  test("attachment-enabled questions accept opaque files without requiring extra text", () => {
    const attention: PetQuestionAttention = {
      kind: "question",
      id: "r4",
      responseChannel: "async-question",
      responseMode: "answers",
      attachmentsSupported: true,
      questions: [{ question: "Show the image", options: [] }],
    };
    const attachments = {
      "Show the image": ["opaque-image"],
      unknown: ["must-not-be-sent"],
    };
    expect(canSubmitQuestion(attention, {}, attachments)).toBe(true);
    expect(questionResponse(attention, {}, attachments)).toEqual({
      kind: "answers",
      answers: {},
      attachments: { "Show the image": ["opaque-image"] },
    });
  });
  test("unsupported attachment capability cannot satisfy an unanswered question or send tokens", () => {
    const attention: PetQuestionAttention = {
      kind: "question",
      id: "r5",
      responseChannel: "permission",
      attachmentsSupported: false,
      questions: [{ question: "Choose", options: [] }],
    };
    const attachments = { Choose: ["opaque-file"] };
    expect(canSubmitQuestion(attention, {}, attachments)).toBe(false);
    expect(
      questionResponse(attention, { Choose: "Text only" }, attachments),
    ).toEqual({ kind: "answers", answers: { Choose: "Text only" } });
  });
  test("each question needs its own answer or attachment and empty groups are omitted", () => {
    const attention: PetQuestionAttention = {
      kind: "question",
      id: "r6",
      responseChannel: "async-question",
      attachmentsSupported: true,
      questions: [
        { question: "First", options: [] },
        { question: "Second", options: [] },
      ],
    };
    expect(
      canSubmitQuestion(attention, {}, { First: ["one"], Second: [] }),
    ).toBe(false);
    expect(
      canSubmitQuestion(
        attention,
        { Second: "Other answer" },
        { First: ["one"] },
      ),
    ).toBe(true);
    expect(
      questionResponse(
        attention,
        { First: "A", Second: "B" },
        { First: [], Second: [] },
      ),
    ).toEqual({ kind: "answers", answers: { First: "A", Second: "B" } });
  });
});
