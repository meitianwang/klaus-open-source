import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "../../bridge/pet-api";
import { installTabFocusPolicy } from "../app/tab-focus-policy";
import { petApi } from "../../bridge/pet-api";
import {
  DEFAULT_PET_SETTINGS,
  type PetState,
  type PetTask,
} from "../../../contracts/desktop-pet";
import { BUILT_IN_PETS } from "./catalog";
import { PetSprite, usePrefersReducedMotion } from "./Sprite";
import { petMessages } from "./messages";
import type { PetAnimation } from "./animation";
import { spontaneousAllowed, resolveActiveAnimation } from "./spontaneous";
import { useSpontaneousAnimation } from "./use-spontaneous";
import { Icon } from "../components/Icon";
import { TaskNotification } from "./TaskNotification";
import { VoiceControls } from "./VoiceControls";
import { DictationInput } from "./DictationInput";
import { petVoiceError } from "./voice-errors";
import { ComposerAccessories } from "./ComposerAccessories";
import { submissionForAttempt } from "./composer-model";
import { Conversation } from "./Conversation";
import { textareaCaretPoint } from './caret-point';
import { useToolbarPresentation } from './use-toolbar-presentation';
import type {
  PetComposerAttachment,
  PetComposerSubmission,
  PetConversationState,
} from "../../../contracts/desktop-pet-composer";
import type { PetLiveVoiceState } from "../../../contracts/desktop-pet-voice";
import "./pet.css";

installTabFocusPolicy();

export const INITIAL_PET_STATE: PetState = {
  settings: { ...DEFAULT_PET_SETTINGS },
  visible: false,
  menuOpen: false,
  stashedEdge: null,
  tasks: [],
  catalog: BUILT_IN_PETS,
  layout: {
    pet: { x: 0, y: 0, width: 112, height: 122 },
    viewport: { width: 400, height: 500 },
    placement: "bottom-end",
  },
  revision: 0,
};
interface DragState {
  id: number;
  x: number;
  y: number;
  moved: boolean;
  clickTarget: HTMLButtonElement | null;
  samples: Array<{ x: number; y: number; at: number }>;
}

function DesktopPet() {
  const [state, setState] = useState<PetState>(INITIAL_PET_STATE);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [composerPresented, setComposerPresented] = useState(false);
  const [submissionCompact, setSubmissionCompact] = useState(false);
  const submissionCompactRef = useRef(false), presentationRevision = useRef(0), visibleRef = useRef(false);
  submissionCompactRef.current = submissionCompact;
  const openEditor = useCallback(() => { presentationRevision.current++; setSubmissionCompact(false); setComposerPresented(true); setEditing(true); }, []);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const [stackExpanded, setStackExpanded] = useState(false);
  const [animation, setAnimation] = useState<PetAnimation | null>(null);
  const [firstAwake, setFirstAwake] = useState(true);
  const [greeting, setGreeting] = useState(true);
  const [sending, setSending] = useState(false);
  const [voicePanel, setVoicePanel] = useState(false);
  const [dictationBusy, setDictationBusy] = useState(false);
  const [voiceStartRequest, setVoiceStartRequest] = useState(0);
  const [activityOpen, setActivityOpen] = useState(true);
  const [notificationBelow, setNotificationBelow] = useState(false), [notificationTop, setNotificationTop] = useState(0), [notificationLimit, setNotificationLimit] = useState(460);
  const [accessoryShift, setAccessoryShift] = useState({ x: 0, y: 0 }), [notificationShift, setNotificationShift] = useState({ x: 0, y: 0 });
  const [pendingSubmission, setPendingSubmission] = useState<{ id: string; sessionId?: string; title: string; at: number; failed?: boolean } | null>(null);
  const submissionRevision = useRef(0), draftRevision = useRef(0);
  const conversationRef = useRef<PetConversationState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [liveVoice, setLiveVoice] = useState<PetLiveVoiceState | null>(null);
  const [attachments, setAttachments] = useState<PetComposerAttachment[]>([]);
  const [target, setTarget] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [conversation, setConversation] = useState<PetConversationState | null>(null);
  const [conversationOpen, setConversationOpen] = useState(true);
  conversationRef.current = conversation;
  const [replyTo, setReplyTo] = useState<PetComposerSubmission['replyTo']>();
  const [importingAttachments, setImportingAttachments] = useState(false);
  const [pendingCaptures, setPendingCaptures] = useState<Set<string>>(() => new Set());
  const [focusRevision, setFocusRevision] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const draftReady = useRef(false), draftTouched = useRef(false);
  const [inlineInputFocused, setInlineInputFocused] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [caretPoint, setCaretPoint] = useState<{ x: number; y: number } | null>(null);
  const attempt = useRef<PetComposerSubmission | null>(null);
  const frame = useRef<HTMLDivElement>(null),
    sprite = useRef<HTMLDivElement>(null),
    accessories = useRef<HTMLDivElement>(null),
    notifications = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<DragState | null>(null);
  const suppressNativeClick = useRef(false);
  const m = petMessages(state.settings.language);
  const reduceMotion = usePrefersReducedMotion();
  const composerExpanded = composerPresented && !submissionCompact && (editing || draft.length > 0 || attachments.length > 0 || Boolean(replyTo) || pendingCaptures.size > 0);
  const historyPresented = composerExpanded && conversationOpen && Boolean(conversation?.sessionId);
  const toolbarPresented = useToolbarPresentation(frame, state.visible && !state.stashedEdge, !state.settings.showPet || composerExpanded || submissionCompact || voicePanel || Boolean(error) || attachmentMenu || state.menuOpen || dragging || activityOpen && state.settings.showActivity && state.tasks.length > 0);
  const minimized = state.settings.showPet && !toolbarPresented && !composerExpanded;
  const pet =
    state.catalog.find((entry) => entry.id === state.settings.selectedPetId) ??
    state.catalog[0] ??
    BUILT_IN_PETS[0];
  const reportError = useCallback(
    (value: unknown) =>
      setError(value instanceof Error ? value.message : String(value)),
    [],
  );
  const collapseEditor = useCallback(() => {
    presentationRevision.current++;
    editingRef.current = false;
    setSubmissionCompact(false);
    setEditing(false);
    setComposerPresented(false);
    setComposerFocused(false);
    setInlineInputFocused(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);
  const updateCaret = useCallback(() => setCaretPoint(input.current && !submissionCompactRef.current ? textareaCaretPoint(input.current) : null), []);
  useEffect(() => {
    const focused = composerFocused && editing && !submissionCompact && state.visible && !state.stashedEdge;
    void petApi.setComposerFocused(focused).catch(reportError);
    if (!focused) setCaretPoint(null);
    return () => { void petApi.setComposerFocused(false).catch(() => {}); };
  }, [composerFocused, editing, submissionCompact, state.visible, state.stashedEdge, reportError]);
  useLayoutEffect(() => {
    updateCaret();
    document.addEventListener('selectionchange', updateCaret);
    window.addEventListener('resize', updateCaret);
    return () => { document.removeEventListener('selectionchange', updateCaret); window.removeEventListener('resize', updateCaret); };
  }, [draft, editing, composerFocused, state.layout.placement, (state.layout as typeof state.layout & { contentOffset?: { x: number; y: number } }).contentOffset?.x, (state.layout as typeof state.layout & { contentOffset?: { x: number; y: number } }).contentOffset?.y, (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.x, (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.y, conversation?.revision, updateCaret]);
  useEffect(() => {
    let revision = -1, visible = false;
    const receive = (next: PetState) => {
      if (next.revision < revision) return;
      revision = next.revision;
      visibleRef.current = next.visible && next.settings.enabled;
      if (!next.settings.enabled || (visible && !next.visible)) {
        pendingFocus.current = null;
        collapseEditor();
        setVoicePanel(false);
        setAttachmentMenu(false);
      }
      visible = next.visible;
      setState(next);
    };
    const off = petApi.onState(receive),
      focus = petApi.onFocus((payload) => {
        if (payload?.type === "cancel-focus") {
          if (pendingFocus.current === payload.requestId) { pendingFocus.current = null; collapseEditor(); }
          return;
        }
        pendingFocus.current = payload?.type === "focus-input" && typeof payload.requestId === "number" ? payload.requestId : null;
        const next = payload?.type === 'toggle-input' ? !editingRef.current : true;
        editingRef.current = next;
        setSubmissionCompact(false);
        setComposerPresented(next);
        setEditing(next);
        if (!next && document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setFocusRevision(value => value + 1);
      }),
      pointer = petApi.onPointer((point) =>
        window.dispatchEvent(new CustomEvent("pet-pointer", { detail: point })),
      );
    petApi.rendererReady().then(receive).catch(reportError);
    const wave = setTimeout(() => setFirstAwake(false), 2500),
      hello = setTimeout(() => setGreeting(false), 8000);
    return () => {
      off();
      focus();
      pointer();
      clearTimeout(wave);
      clearTimeout(hello);
    };
  }, [reportError, collapseEditor]);
  useEffect(() => {
    let active = true;
    petApi.composerDraft().then(saved => { if (active) { if (!draftTouched.current) { setDraft(saved.text); setReplyTo(saved.replyTo); } draftReady.current = true; } }).catch(reportError);
    return () => { active = false; };
  }, [reportError]);
  useEffect(() => {
    if (draftReady.current) void petApi.saveComposerDraft({ text: draft, ...(replyTo ? { replyTo } : {}) }).catch(reportError);
  }, [draft, replyTo, reportError]);
  useEffect(() => {
    const receive = (next: PetConversationState) => setConversation(current => !current || next.revision >= current.revision ? next : current);
    const off = petApi.onConversation(receive);
    petApi.conversationState().then(receive).catch(reportError);
    return off;
  }, [reportError]);
  useEffect(() => petApi.onCapture(event => {
    setPendingCaptures(current => { const next = new Set(current); if (event.type === 'started') next.add(event.captureId); else next.delete(event.captureId); return next; });
    if (event.type === 'completed') { draftRevision.current++; setAttachments(current => current.some(file => file.id === event.attachment.id) ? current : [...current, event.attachment]); openEditor(); }
    else if (event.type === 'failed') reportError(event.message);
  }), [reportError, openEditor]);
  useEffect(() => {
    if (!conversation?.sessionId) { setTarget(null); setReplyTo(undefined); }
    else setTarget({ id: conversation.sessionId, title: conversation.title || m.conversation });
  }, [conversation?.sessionId, conversation?.title, m.conversation]);
  useLayoutEffect(() => {
    const updateWorkArea = () => {
      const workArea = (state.layout as typeof state.layout & { workArea?: { width: number; height: number } }).workArea;
      document.documentElement.style.setProperty('--pet-work-height', `${workArea?.height ?? window.screen.availHeight}px`);
      document.documentElement.style.setProperty('--pet-work-width', `${workArea?.width ?? window.screen.availWidth}px`);
    };
    updateWorkArea();
    window.addEventListener("resize", updateWorkArea);
    return () => window.removeEventListener("resize", updateWorkArea);
  }, [(state.layout as typeof state.layout & { workArea?: { width: number; height: number } }).workArea?.width, (state.layout as typeof state.layout & { workArea?: { width: number; height: number } }).workArea?.height]);
  useEffect(() => {
    document.documentElement.lang = state.settings.language;
  }, [state.settings.language]);
  useEffect(() => {
    const blur = () => {
      if (submissionCompactRef.current) { presentationRevision.current++; setSubmissionCompact(false); setComposerPresented(false); }
      setEditing(false); setComposerFocused(false); setInlineInputFocused(false);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);
  useEffect(() => {
    if (!error) return;
    const timeout = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timeout);
  }, [error]);
  const wantsKeyboard = state.visible && (editing || voicePanel || inlineInputFocused);
  useEffect(() => {
    if (pendingFocus.current !== null) return;
    petApi
      .setKeyboard(wantsKeyboard)
      .catch(reportError);
  }, [wantsKeyboard, focusRevision, reportError]);
  useLayoutEffect(() => {
    if (!editing || !state.visible || pendingFocus.current !== null) return;
    let current = true;
    void petApi.setKeyboard(true).then(() => { if (current && pendingFocus.current === null) input.current?.focus(); }).catch(reportError);
    return () => { current = false; };
  }, [editing, focusRevision, state.visible, reportError]);
  useEffect(() => {
    if (!document.activeElement?.matches("input,textarea,select"))
      setInlineInputFocused(false);
  }, [state.tasks]);
  const publishLayout = useCallback(() => {
    if (!frame.current || !sprite.current) return;
    const body = frame.current.getBoundingClientRect(),
      mascot = sprite.current.getBoundingClientRect();
    const tray = notifications.current?.getBoundingClientRect(), area = state.layout.workArea;
    const origin = state.layout.origin ?? { x: window.screenX, y: window.screenY };
    const controlRects = Array.from(accessories.current?.children ?? []).map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const union = (rects: DOMRect[]) => rects.length ? {
      x: Math.min(...rects.map(rect => rect.x)), y: Math.min(...rects.map(rect => rect.y)),
      width: Math.max(...rects.map(rect => rect.right)) - Math.min(...rects.map(rect => rect.x)),
      height: Math.max(...rects.map(rect => rect.bottom)) - Math.min(...rects.map(rect => rect.y)),
    } : undefined;
    if (area) {
      const fit = (rect: ReturnType<typeof union>, shift: { x: number; y: number }) => {
        if (!rect) return { x: 0, y: 0 };
        const x = origin.x + rect.x - shift.x, y = origin.y + rect.y - shift.y;
        const marginX = Math.min(16, Math.max(0, (area.width - rect.width) / 2)), marginY = Math.min(16, Math.max(0, (area.height - rect.height) / 2));
        return { x: Math.round(Math.max(area.x + marginX, Math.min(x, area.x + area.width - marginX - rect.width)) - x), y: Math.round(Math.max(area.y + marginY, Math.min(y, area.y + area.height - marginY - rect.height)) - y) };
      };
      const controls = fit(union(controlRects), accessoryShift), notification = fit(tray ? union([tray]) : undefined, notificationShift);
      if (controls.x !== accessoryShift.x || controls.y !== accessoryShift.y || notification.x !== notificationShift.x || notification.y !== notificationShift.y) {
        setAccessoryShift(controls); setNotificationShift(notification); return;
      }
    }
    if (tray && area && !dragging) {
      const controls = union(controlRects), top = Math.min(mascot.y, controls?.y ?? mascot.y), bottom = Math.max(mascot.bottom, controls ? controls.y + controls.height : mascot.bottom);
      const above = origin.y + top - area.y - 28, below = area.y + area.height - origin.y - bottom - 28;
      const nextBelow = above < tray.height && below > above, limit = Math.max(0, Math.floor(nextBelow ? below : above));
      if (nextBelow !== notificationBelow || limit !== notificationLimit) { setNotificationBelow(nextBelow); setNotificationLimit(limit); return; }
      const nextTop = nextBelow ? bottom - body.y + 12 : top - body.y - tray.height - 12;
      if (Math.abs(nextTop - notificationTop) > 0.5) { setNotificationTop(nextTop); return; }
    }
    const accessory = union([...controlRects, ...(tray && tray.width > 0 && tray.height > 0 ? [tray] : [])]);
    const focusRequestId = editing ? pendingFocus.current : null;
    void petApi
      .setLayout({
        width: Math.ceil(body.width),
        height: Math.ceil(body.height),
        pet: {
          x: mascot.x - body.x,
          y: mascot.y - body.y,
          width: mascot.width,
          height: mascot.height,
        },
        accessories: accessory && (accessory.width > 0 || accessory.height > 0) ? { x: accessory.x - body.x, y: accessory.y - body.y, width: accessory.width, height: accessory.height } : { x: 0, y: 0, width: 0, height: 0 },
        ...(focusRequestId !== null ? { focusRequestId } : {}),
      } as Parameters<typeof petApi.setLayout>[0])
      .then(async next => {
        if (focusRequestId === null || pendingFocus.current !== focusRequestId) return;
        const revision = (next.layout as typeof next.layout & { revision?: number }).revision;
        if (revision === undefined) return;
        if (await petApi.completeFocus(focusRequestId, revision) && pendingFocus.current === focusRequestId) { pendingFocus.current = null; input.current?.focus(); }
      })
      .catch(reportError);
    petApi
      .setRegions(
        [...document.querySelectorAll<HTMLElement>("[data-pet-hit]")].filter(element => getComputedStyle(element).visibility !== "hidden").map(
          (element) => {
            const rect = element.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
          },
        ),
      )
      .catch(reportError);
  }, [editing, dragging, notificationBelow, notificationTop, notificationLimit, accessoryShift.x, accessoryShift.y, notificationShift.x, notificationShift.y, state.layout.origin?.x, state.layout.origin?.y, state.layout.workArea?.x, state.layout.workArea?.y, state.layout.workArea?.width, state.layout.workArea?.height, (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.x, (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.y, reportError]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(publishLayout);
    if (frame.current) observer.observe(frame.current);
    if (accessories.current) observer.observe(accessories.current);
    if (notifications.current) observer.observe(notifications.current);
    publishLayout();
    return () => observer.disconnect();
  }, [publishLayout, activityOpen, state.tasks.length, Boolean(pendingSubmission), state.settings.showActivity]);
  useLayoutEffect(publishLayout, [
    state.layout.placement,
    (state.layout as typeof state.layout & { contentOffset?: { x: number; y: number } }).contentOffset?.x,
    (state.layout as typeof state.layout & { contentOffset?: { x: number; y: number } }).contentOffset?.y,
    (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.x,
    (state.layout as typeof state.layout & { accessoryOffset?: { x: number; y: number } }).accessoryOffset?.y,
    state.settings.size,
    state.settings.showPet,
    state.settings.showActivity,
    state.stashedEdge,
    stackExpanded,
    editing,
    error,
    greeting,
    focusRevision,
    toolbarPresented,
    composerExpanded,
    activityOpen,
    conversationOpen,
    conversation?.revision,
    publishLayout,
  ]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || !composerExpanded) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(120, Math.max(33, element.scrollHeight))}px`;
    publishLayout();
  }, [draft, composerExpanded, publishLayout]);
  const dragStart = (event: ReactPointerEvent) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      !(event.target instanceof Element) ||
      event.target.closest("textarea,input,select,[data-pet-no-drag]")
    )
      return;
    const clickTarget = event.target.closest<HTMLButtonElement>("button");
    if (clickTarget?.disabled || clickTarget && !event.currentTarget.classList.contains("pet-bar")) return;
    event.preventDefault();
    suppressNativeClick.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.screenX,
      y: event.screenY,
      moved: false,
      clickTarget,
      samples: [{ x: event.screenX, y: event.screenY, at: event.timeStamp }],
    };
    setDragging(true);
    petApi
      .dragStart({
        x: event.clientX,
        y: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
      })
      .catch(reportError);
  };
  const dragMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const delta = event.screenX - current.x;
    const step = event.screenX - (current.samples.at(-1)?.x ?? current.x);
    if (Math.hypot(delta, event.screenY - current.y) > 4) current.moved = true;
    current.samples.push({
      x: event.screenX,
      y: event.screenY,
      at: event.timeStamp,
    });
    current.samples = current.samples.filter(
      (sample) => event.timeStamp - sample.at < 120,
    );
    if (current.moved) {
      setAnimation(
        step >= 4 ? "running-right" : step <= -4 ? "running-left" : "running",
      );
      petApi
        .dragMove({
          x: event.clientX,
          y: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
        })
        .catch(reportError);
    }
  };
  const dragEnd = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    requestAnimationFrame(() => { suppressNativeClick.current = false; });
    setAnimation(null);
    const cancelled = event.type === "pointercancel";
    const samples = [...current.samples, { x: event.screenX, y: event.screenY, at: event.timeStamp }].filter(sample => event.timeStamp - sample.at <= 120);
    const oldest = samples[0], newest = samples.at(-1), elapsed = oldest && newest ? newest.at - oldest.at : 0;
    const velocity = oldest && newest && elapsed > 0 ? { x: (newest.x - oldest.x) * 1000 / elapsed, y: (newest.y - oldest.y) * 1000 / elapsed } : { x: 0, y: 0 };
    void petApi
      .dragEnd({
        x: event.clientX,
        y: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        altKey: event.altKey,
      })
      .then(() => current.moved && !event.altKey && !cancelled && Math.hypot(velocity.x, velocity.y) >= 65 ? petApi.throw(velocity) : undefined)
      .catch(reportError);
    if (!current.moved && !cancelled) {
      if (current.clickTarget) {
        if (current.clickTarget.isConnected && !current.clickTarget.disabled)
          current.clickTarget.click();
        return;
      }
      if (state.stashedEdge) petApi.stash(null).catch(reportError);
      else if (event.currentTarget.classList.contains('pet-mascot-slot')) petApi.openMain().catch(reportError);
    }
  };
  const send = async () => {
    if (dictationBusy || draft.length > 8000 || (!draft.trim() && !attachments.length) || sending || importingAttachments || pendingCaptures.size) return;
    const submitted = { text: draft, attachments, replyTo, target };
    const revision = ++submissionRevision.current, contentRevision = draftRevision.current, viewRevision = presentationRevision.current;
    const selectedSession = target?.id ?? null;
    const request = submissionForAttempt(attempt.current, {
      text: draft, attachmentIds: attachments.map(attachment => attachment.id),
      ...(target ? { targetTaskId: target.id } : {}), ...(replyTo ? { replyTo } : {}),
    }, () => crypto.randomUUID());
    attempt.current = request;
    submissionCompactRef.current = true;
    input.current?.focus();
    setEditing(true);
    setSending(true); setDraft(''); setAttachments([]); setReplyTo(undefined); setAttachmentMenu(false);
    setSubmissionCompact(true); setConversationOpen(false);
    if (!selectedSession) {
      setPendingSubmission({ id: request.submissionId, title: submitted.text.trim() || submitted.attachments[0]?.name || m.startingChat, at: Date.now() });
      setActivityOpen(true); setStackExpanded(false);
      if (!state.settings.showActivity) void petApi.updateSettings({ showActivity: true }).catch(reportError);
    }
    const restore = () => {
      if (submissionRevision.current !== revision || draftRevision.current !== contentRevision || (conversationRef.current?.sessionId ?? null) !== selectedSession) return false;
      setDraft(submitted.text); setAttachments(submitted.attachments); setReplyTo(submitted.replyTo);
      setSubmissionCompact(false); setPendingSubmission(null);
      if (presentationRevision.current === viewRevision && visibleRef.current) setComposerPresented(true);
      return true;
    };
    try {
      const result = await petApi.submitMessage(request);
      if (!result) { restore(); return; }
      setPendingSubmission(current => current?.id === request.submissionId ? { ...current, sessionId: result.sessionId } : current);
      if (attempt.current === request) attempt.current = null;
    } catch (failure) {
      if (!restore()) setPendingSubmission(current => current?.id === request.submissionId ? { ...current, failed: true } : current);
      reportError(failure);
    } finally { if (submissionRevision.current === revision) setSending(false); }
  };
  const addFiles = async (files: File[]) => {
    if (sending || importingAttachments || !files.length) return;
    setImportingAttachments(true);
    try {
      for (const file of files) {
        const attachment = await petApi.importAttachment({ name: file.name || `Pasted-${Date.now()}.png`, mimeType: file.type, data: await file.arrayBuffer() });
        draftRevision.current++; setAttachments(current => [...current, attachment]);
      }
      openEditor();
    } catch (failure) { reportError(failure); }
    finally { setImportingAttachments(false); }
  };
  const actualTasks = state.settings.showActivity ? state.tasks : [];
  const pendingTask: PetTask | null = pendingSubmission && !(pendingSubmission.sessionId && actualTasks.some(task => task.id === pendingSubmission.sessionId || task.sessionId === pendingSubmission.sessionId)) ? {
    id: pendingSubmission.sessionId || pendingSubmission.id, title: pendingSubmission.title,
    status: pendingSubmission.failed ? 'failed' : 'running', summary: pendingSubmission.failed ? m.unableStartChat : pendingSubmission.sessionId ? m.thinking : m.startingChat,
    startedAt: pendingSubmission.at, updatedAt: pendingSubmission.at,
  } : null;
  const tasks = pendingTask ? [pendingTask, ...actualTasks.filter(task => task.id !== conversation?.sessionId || pendingSubmission?.sessionId)] : actualTasks;
  const seenActivity = useRef(new Set<string>());
  useEffect(() => {
    const keys = new Set(state.tasks.map(task => `${task.id}:${task.startedAt ?? ''}`));
    if (state.settings.showActivity && [...keys].some(key => !seenActivity.current.has(key))) setActivityOpen(true);
    seenActivity.current = keys;
  }, [state.tasks, state.settings.showActivity]);
  useEffect(() => {
    if (pendingSubmission?.sessionId && state.tasks.some(task => task.id === pendingSubmission.sessionId || task.sessionId === pendingSubmission.sessionId)) setPendingSubmission(null);
  }, [state.tasks, pendingSubmission?.sessionId]);
  // She only starts something on her own while truly idle: nobody interacting,
  // no task driving her, not stashed or greeting, and motion allowed.
  const spontaneousEnabled = spontaneousAllowed({
    visible: state.visible,
    menuOpen: state.menuOpen,
    stashed: Boolean(state.stashedEdge),
    editing,
    voicePanel,
    attachmentMenu,
    greeting,
    reducedMotion: reduceMotion,
    busyTasks: tasks.length,
    reacting: animation !== null,
  });
  const spontaneous = useSpontaneousAnimation(spontaneousEnabled);
  const activeAnimation = resolveActiveAnimation({
    reaction: animation,
    spontaneous,
    topTaskStatus: tasks[0]?.status,
    firstAwake,
  });
  const rows = stackExpanded ? tasks : tasks.slice(0, 1);
  const top = state.layout.placement.startsWith("top");
  const contentOffset = (state.layout as typeof state.layout & { contentOffset?: { x: number; y: number } }).contentOffset ?? { x: 0, y: 0 };
  return (
    <div
      className={`pet-window ${top ? "pet-top" : "pet-bottom"} ${composerExpanded || voicePanel || activityOpen ? 'pet-panel-open' : 'pet-controls-only'} ${state.layout.placement.endsWith("start") ? "pet-start" : "pet-end"} ${state.stashedEdge ? `pet-stashed pet-stashed-${state.stashedEdge}` : ""}`}
      ref={frame}
      style={{ transform: `translate(${contentOffset.x}px, ${contentOffset.y}px)` }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={event => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); void addFiles(files); } }}
      onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); } }}
      onPointerDownCapture={(event) => {
        const field = (event.target as Element).closest<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >("input,textarea,select");
        if (field) {
          setInlineInputFocused(true);
          void petApi
            .setKeyboard(true)
            .then(() => field.focus())
            .catch(reportError);
        }
      }}
      onFocusCapture={(event) => {
        if ((event.target as Element).matches("input,textarea,select"))
          setInlineInputFocused(true);
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Element) ||
          !event.relatedTarget.matches("input,textarea,select")
        )
          setInlineInputFocused(false);
      }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return;
        event.preventDefault();
        if (!voicePanel) petApi.contextMenu().catch(reportError);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (event.nativeEvent.isComposing || event.defaultPrevented) return;
          event.preventDefault();
          if (replyTo) { setReplyTo(undefined); input.current?.focus(); }
          else if (composerExpanded || voicePanel) {
            setEditing(false);
            setVoicePanel(false);
            setAttachmentMenu(false);
            if (!draft.trim() && !pendingCaptures.size) setAttachments([]);
            if (!draft.trim()) setDraft('');
            input.current?.blur();
          } else petApi.hide().catch(reportError);
        }
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          if (!voicePanel) petApi.contextMenu().catch(reportError);
        }
      }}
    >
      {!state.stashedEdge && !historyPresented && activityOpen && tasks.length > 0 && <div className={`pet-notification-slot${notificationBelow ? ' pet-notification-below' : ''}`} ref={notifications} style={{ top: notificationTop, maxHeight: notificationLimit, visibility: notificationLimit < 56 ? "hidden" : undefined, transform: `translate(calc(-50% + ${notificationShift.x}px), ${notificationShift.y}px)` }}>
          {activityOpen && tasks.length > 0 && (
            <div
              className={`pet-activity ${stackExpanded ? "pet-activity-expanded" : ""}`}
              role="list"
              aria-label={m.notification}
            >
              {rows.map((task) => (
                <TaskNotification key={task.id} task={task} language={state.settings.language} pending={task === pendingTask} onLayout={publishLayout}
                  stackCollapsed={!stackExpanded && tasks.length > 1} menusEnabled={!voicePanel}
                  onOpen={() => { if (!stackExpanded && tasks.length > 1) setStackExpanded(true); else void petApi.openTask(task.id).catch(reportError); }}
                  onDismiss={() => { if (task === pendingTask) setPendingSubmission(null); else void petApi.dismissTask(task.id).catch(reportError); }}
                  onError={reportError} />
              ))}
              {tasks.length > 1 && (
                <button
                  className="pet-stack-toggle"
                  data-pet-hit
                  aria-expanded={stackExpanded}
                  onClick={() => setStackExpanded((value) => !value)}
                >
                  {stackExpanded
                    ? m.collapse
                    : `${m.activity} · ${tasks.length}`}{" "}
                  <Icon name="chevron-down" size={12} />
                </button>
              )}
            </div>
          )}
      </div>}
      <div
        className="pet-mascot-slot"
        ref={sprite}
        data-pet-hit={state.settings.showPet || state.stashedEdge ? true : undefined}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
      >
        {state.settings.showPet && (
          <PetSprite
            pet={pet}
            size={state.settings.size}
            state={activeAnimation as PetAnimation}
            trackPointer
            loop={Boolean(drag.current)}
            transientState={animation ?? undefined}
            lookAt={caretPoint}
          />
        )}
        {state.stashedEdge && (
          <button
            className="pet-restore"
            aria-label={m.restore}
            onClick={() => petApi.stash(null).catch(reportError)}
          >
            <Icon
              name={state.stashedEdge === "left" ? "chevron-right" : "back"}
              size={20}
            />
            {tasks.length > 0 && <b>{tasks.length}</b>}
          </button>
        )}
      </div>
      <div className="pet-accessories" ref={accessories} style={{ transform: `translate(${accessoryShift.x}px, ${accessoryShift.y}px)` }}>
      <VoiceControls
        language={state.settings.language}
        visible={voicePanel && !state.stashedEdge}
        startRequest={voiceStartRequest}
        onClose={() => setVoicePanel(false)}
        onError={reportError}
        onStateChange={setLiveVoice}
        targetSessionId={conversation?.sessionId ?? undefined}
        onReturnToConversation={async sessionId => {
          setFocusRevision(value => value + 1);
          setConversationOpen(true); openEditor(); setReplyTo(undefined);
          await petApi.selectConversation(sessionId);
        }}
      />
      {!state.stashedEdge && (
        <>
          {error && (
            <div className="pet-error" data-pet-hit role="alert">
              {error}
              <button aria-label={m.close} onClick={() => setError("")}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {state.settings.showActivity && greeting && !tasks.length && (
            <div className="pet-greeting" data-pet-hit role="status">
              <strong>
                {m.greeting} {pet.name}
              </strong>
              <span>{m.greetingBody}</span>
              <button aria-label={m.close} onClick={() => setGreeting(false)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {composerExpanded && conversationOpen && conversation && <Conversation state={conversation} language={state.settings.language} onClose={() => setConversationOpen(false)} onError={reportError} onReply={message => {
            draftRevision.current++; setReplyTo({ id: message.id, text: message.text, role: message.role }); openEditor(); setFocusRevision(value => value + 1);
          }} />}
          {composerExpanded && !conversationOpen && conversation?.sessionId && <button className="pet-conversation-reopen" data-pet-hit onClick={() => setConversationOpen(true)}>{conversation.title || m.conversation}<Icon name="chevron-down" size={13} /></button>}
          {composerExpanded && replyTo && <div className="pet-message-reply" data-pet-hit><span>{replyTo.text}</span><button aria-label={m.targetRemove} onClick={() => setReplyTo(undefined)}><Icon name="close" size={13} /></button></div>}
          {composerExpanded && <ComposerAccessories
            attachments={attachments}
            language={state.settings.language}
            disabled={sending || importingAttachments || pendingCaptures.size > 0}
            menuOpen={attachmentMenu}
            closeMenu={() => setAttachmentMenu(false)}
            onAdded={(added) => {
              draftRevision.current++;
              setAttachments((current) => [
                ...current,
                ...added.filter(
                  (item) =>
                    !current.some((existing) => existing.id === item.id),
                ),
              ]);
            }}
            onRemoved={(id) => {
              draftRevision.current++;
              setAttachments((current) =>
                current.filter((item) => item.id !== id),
              );
            }}
            onError={reportError}
          />}
          {pendingCaptures.size > 0 && <p className="pet-attachment-busy" data-pet-hit role="status">{m.screenshotCapturing}</p>}
          {composerExpanded && draft.length > 8000 && <p className="pet-voice-inline-error" data-pet-hit role="alert">{m.dictationTooLong}</p>}
          <div
            className={`pet-bar ${composerExpanded ? 'pet-bar-editing' : 'pet-bar-compact'} ${minimized ? 'pet-bar-minimized' : ''} ${tasks.length ? 'pet-bar-has-activity' : ''}`}
            data-presentation={composerExpanded ? 'editor' : minimized ? 'handle' : 'controls'}
            data-pet-hit
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
            onClickCapture={(event) => {
              if (suppressNativeClick.current && event.nativeEvent.isTrusted) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <div className="pet-bar-controls" inert={minimized} aria-hidden={minimized || undefined}>
            {(composerExpanded || submissionCompact) && (
              <div className={`pet-editor-controls${submissionCompact ? ' pet-editor-submitted' : ''}`}>
                <button
                  className="pet-attachment-add"
                  aria-label={m.attachFiles}
                  aria-expanded={attachmentMenu}
                  disabled={sending}
                  onClick={() => setAttachmentMenu((value) => !value)}
                >
                  <Icon name="plus" size={16} />
                </button>
                <textarea
                  ref={input}
                  rows={1}
                  maxLength={8000}
                  value={draft}
                  placeholder={m.ask}
                  aria-label={m.ask}
                  onChange={(event) => { draftTouched.current = true; draftRevision.current++; if (submissionCompact) setConversationOpen(true); setSubmissionCompact(false); setDraft(event.target.value); setComposerPresented(true); }}
                  onFocus={() => { if (!submissionCompactRef.current) openEditor(); setComposerFocused(true); updateCaret(); }}
                  onBlur={(event) => { setComposerFocused(false); setCaretPoint(null); if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.pet-bar')) { setEditing(false); if (submissionCompactRef.current) { presentationRevision.current++; setSubmissionCompact(false); setComposerPresented(false); } } }}
                  onScroll={updateCaret}
                  onSelect={updateCaret}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <DictationInput
                  key={conversation?.sessionId ?? 'new-conversation'}
                  language={state.settings.language}
                  active={state.visible && !state.stashedEdge && !voicePanel}
                  disabled={sending || Boolean(liveVoice && liveVoice.phase !== 'inactive')}
                  onBusyChange={setDictationBusy}
                  onError={error => reportError(petVoiceError(error, state.settings.language))}
                  onText={text => {
                    draftTouched.current = true; draftRevision.current++;
                    setDraft(current => current + (current && !/\s$/.test(current) ? ' ' : '') + text);
                    openEditor(); setFocusRevision(value => value + 1);
                  }}
                />
                <button
                  className="pet-send"
                  aria-label={m.send}
                  disabled={dictationBusy || draft.length > 8000 || (!draft.trim() && !attachments.length) || sending || importingAttachments || pendingCaptures.size > 0}
                  onClick={() => void send()}
                >
                  <Icon
                    name={sending ? "chat-scroll-to-bottom-spin" : "send-arrow"}
                    size={16}
                  />
                </button>
              </div>
            )}
            {!composerExpanded && (
              <button
                className="pet-compose-button"
                aria-label={m.newConversation}
                onClick={() => { openEditor(); setConversationOpen(true); setFocusRevision(value => value + 1); }}
              >
                <Icon name="edit" size={20} />
              </button>
            )}
            <span className="pet-bar-divider" />
            <button
              className={`pet-voice ${liveVoice?.phase === "active" ? "pet-voice-active" : ""}`}
              aria-label={m.voiceChat}
              aria-expanded={voicePanel}
              disabled={dictationBusy}
              onClick={() => { setEditing(false); input.current?.blur(); setVoicePanel(true); if (liveVoice?.phase !== 'active' && liveVoice?.phase !== 'connecting') setVoiceStartRequest(value => value + 1); }}
            >
              <Icon name="voice-waveform" size={20} />
            </button>
            {tasks.length > 0 && <><span className="pet-bar-divider" />
            <button
              className="pet-activity-button"
              aria-label={m.notification}
              aria-expanded={activityOpen}
              onClick={() => setActivityOpen(value => !value)}
            >
              <Icon name="chevron-down" size={20} cls={activityOpen ? 'pet-chevron-open' : undefined} />
              {tasks.some(task => task.unread) && <span className="pet-activity-badge" />}
            </button></>}
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<DesktopPet />);
