import { beforeEach, describe, expect, test } from "bun:test";
import channelTable from '../../../contracts/channel-table.json';

const calls: Array<{ channel: string; args: unknown[] }> = [];
const target = globalThis as unknown as { window: Record<string, unknown> };
target.window = {
  __KLAUS_DESKTOP__: {
    core: {
      invoke: async (
        _method: string,
        envelope: { channel: string; args: unknown[] },
      ) => {
        calls.push(envelope);
        return null;
      },
    },
    event: { listen: async () => () => {} },
  },
};
const { petApi } = await import("../../bridge/pet-api");
beforeEach(() => {
  calls.length = 0;
});
describe("desktop pet transport contract", () => {
  test('dictation retains its speech source while visible-conversation context stays main-only', async () => {
    const pet = channelTable.roles.find(role => role.role === 'pet')!;
    const main = channelTable.roles.find(role => role.role === 'main')!;
    expect(pet.invoke).toContain('voice:transcribe');
    expect(pet.push).toContain('voice:session:event');
    expect(pet.invoke).not.toContain('desktop-pet:set-main-conversation');
    expect(main.invoke).toContain('desktop-pet:set-main-conversation');
    await petApi.transcribe(new Uint8Array([1, 2]).buffer, 'audio/wav', 'capture', { source: 'qwenwork', durationMs: 1000 });
    expect(calls).toEqual([{ channel: 'voice:transcribe', args: [{ data: { __klausBinary: 'AQI=' }, mimeType: 'audio/wav', operationId: 'capture', source: 'qwenwork', durationMs: 1000 }] }]);
  });
  test("notification preferences target one session while global menus stay untargeted", async () => {
    await petApi.contextMenu("session-one");
    await petApi.contextMenu();
    await petApi.setTaskMuted("session-one", true);
    await petApi.setTaskMuted("session-one", false);
    expect(calls).toEqual([
      { channel: "desktop-pet:context-menu", args: [{ taskId: "session-one" }] },
      { channel: "desktop-pet:context-menu", args: [{}] },
      { channel: "desktop-pet:set-task-muted", args: [{ id: "session-one", muted: true }] },
      { channel: "desktop-pet:set-task-muted", args: [{ id: "session-one", muted: false }] },
    ]);
  });
  test("hit regions, keyboard and stash use named argument envelopes", async () => {
    await petApi.setRegions([{ x: 1, y: 2, width: 3, height: 4 }]);
    await petApi.setKeyboard(true);
    await petApi.stash("left");
    expect(calls).toEqual([
      {
        channel: "desktop-pet:set-regions",
        args: [{ regions: [{ x: 1, y: 2, width: 3, height: 4 }] }],
      },
      { channel: "desktop-pet:set-keyboard", args: [{ active: true }] },
      { channel: "desktop-pet:stash", args: [{ edge: "left" }] },
    ]);
  });
  test("throw velocities and URL previews satisfy host validation", async () => {
    await petApi.throw({ x: 123, y: -456 });
    await petApi.previewUrl("https://example.test/pet.webp");
    expect(calls).toEqual([
      {
        channel: "desktop-pet:throw",
        args: [{ velocityX: 123, velocityY: -456, bounce: false }],
      },
      {
        channel: "desktop-pet:preview-url",
        args: [
          { imageUrl: "https://example.test/pet.webp", name: "Custom pet" },
        ],
      },
    ]);
  });
  test("realtime controls and acknowledgement remain on the scoped companion surface", async () => {
    await petApi.realtimeState();
    await petApi.negotiateRealtime({ requestId: 'request-one', offerSdp: 'v=0', microphoneMuted: false, speakerMuted: false });
    await petApi.controlRealtime({ requestId: 'request-one', generation: 1, action: 'microphone', muted: true });
    await petApi.controlRealtime({ requestId: 'request-one', generation: 1, action: 'speaker', muted: false });
    await petApi.endRealtime({ requestId: 'request-one', generation: 1 });
    await petApi.acknowledgeTask("session-one");
    expect(calls).toEqual([
      { channel: "desktop-pet:realtime-state", args: [] },
      { channel: "desktop-pet:negotiate-realtime", args: [{ requestId: 'request-one', offerSdp: 'v=0', microphoneMuted: false, speakerMuted: false }] },
      { channel: "desktop-pet:realtime-control", args: [{ requestId: 'request-one', generation: 1, action: 'microphone', muted: true }] },
      { channel: "desktop-pet:realtime-control", args: [{ requestId: 'request-one', generation: 1, action: 'speaker', muted: false }] },
      { channel: "desktop-pet:end-realtime", args: [{ requestId: 'request-one', generation: 1 }] },
      { channel: "desktop-pet:acknowledge-task", args: [{ id: "session-one" }] },
    ]);
  });
  test("composer attachments and targeted sends keep opaque host identifiers", async () => {
    await petApi.pickAttachments();
    await petApi.screenshotSources();
    await petApi.attachScreenshot("screen:one");
    await petApi.removeAttachment("opaque-one");
    await petApi.submitMessage({
      text: "Inspect",
      attachmentIds: ["opaque-one"],
      submissionId: "delivery-one",
      targetTaskId: "task-one",
    });
    expect(calls).toEqual([
      { channel: "desktop-pet:pick-attachments", args: [] },
      { channel: "desktop-pet:screenshot-sources", args: [] },
      {
        channel: "desktop-pet:attach-screenshot",
        args: [{ sourceId: "screen:one" }],
      },
      {
        channel: "desktop-pet:remove-attachment",
        args: [{ id: "opaque-one" }],
      },
      {
        channel: "desktop-pet:submit-message",
        args: [
          {
            text: "Inspect",
            attachmentIds: ["opaque-one"],
            submissionId: "delivery-one",
            targetTaskId: "task-one",
          },
        ],
      },
    ]);
  });
  test("realtime negotiation, mute, interruption and end retain the owned call identity", async () => {
    const offer = { requestId: "call-seven", offerSdp: "v=0\r\ns=audio", targetSessionId: "task-one", microphoneMuted: false, speakerMuted: false };
    await petApi.negotiateRealtime(offer);
    await petApi.controlRealtime({ requestId: "call-seven", generation: 7, action: "microphone", muted: true });
    await petApi.controlRealtime({ requestId: "call-seven", generation: 7, action: "interrupt" });
    await petApi.endRealtime({ requestId: "call-seven", generation: 7 });
    expect(calls).toEqual([
      { channel: "desktop-pet:negotiate-realtime", args: [offer] },
      { channel: "desktop-pet:realtime-control", args: [{ requestId: "call-seven", generation: 7, action: "microphone", muted: true }] },
      { channel: "desktop-pet:realtime-control", args: [{ requestId: "call-seven", generation: 7, action: "interrupt" }] },
      { channel: "desktop-pet:end-realtime", args: [{ requestId: "call-seven", generation: 7 }] },
    ]);
  });
  test("realtime source previews carry the current conversation without pinning a source override", async () => {
    await petApi.realtimeOptions(undefined, 'selected-conversation');
    await petApi.realtimeOptions('subscription:codex');
    await petApi.realtimeOptions();
    expect(calls).toEqual([
      { channel: 'desktop-pet:realtime-options', args: [{ sessionId: 'selected-conversation' }] },
      { channel: 'desktop-pet:realtime-options', args: [{ sourceId: 'subscription:codex' }] },
      { channel: 'desktop-pet:realtime-options', args: [{}] },
    ]);
  });

});
