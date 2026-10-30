import { describe, expect, test } from "bun:test";
import { submissionForAttempt } from "./composer-model";
describe("companion composer delivery identity", () => {
  test("a failed send retry preserves its delivery identity and selected attachment order", () => {
    const first = submissionForAttempt(
      null,
      {
        text: " inspect these ",
        attachmentIds: ["file-one", "shot-two"],
        targetTaskId: "task-one",
      },
      () => "attempt-one",
    );
    const retry = submissionForAttempt(
      first,
      {
        text: "inspect these",
        attachmentIds: ["file-one", "shot-two"],
        targetTaskId: "task-one",
      },
      () => "unexpected",
    );
    expect(retry).toBe(first);
    expect(retry.submissionId).toBe("attempt-one");
    expect(retry.text).toBe("inspect these");
  });
  test("changing text, attachments or reply target creates a fresh attempt", () => {
    const first = submissionForAttempt(
      null,
      { text: "Inspect", attachmentIds: [] },
      () => "one",
    );
    expect(
      submissionForAttempt(
        first,
        { text: "Changed", attachmentIds: [] },
        () => "two",
      ).submissionId,
    ).toBe("two");
    expect(
      submissionForAttempt(
        first,
        { text: "Inspect", attachmentIds: ["new"] },
        () => "three",
      ).submissionId,
    ).toBe("three");
    expect(
      submissionForAttempt(
        first,
        { text: "Inspect", attachmentIds: [], targetTaskId: "task" },
        () => "four",
      ).submissionId,
    ).toBe("four");
  });
});
