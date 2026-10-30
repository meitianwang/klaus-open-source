import type { CSSProperties, ReactNode } from 'react';
/** One line of a diff. `context` lines are unchanged. */
export interface DiffLine {
    kind: 'added' | 'removed' | 'context';
    /** Line number in the OLD file. Absent on an added line. */
    oldLine?: number;
    /** Line number in the NEW file. Absent on a removed line. */
    newLine?: number;
    content: string;
}
/** Which side of the diff a line belongs to, for anchoring a comment. */
export type DiffSide = 'old' | 'new';
/** Where a comment is attached. */
export interface DiffAnchor {
    line: number;
    side: DiffSide;
    /** The line's text at the time the comment was made, so a stale anchor is
     *  visible rather than silently pointing at different code. */
    content?: string;
}
/** A stable key for an anchor, for React keys and store lookups. */
export declare function diffAnchorKey(anchor: DiffAnchor): string;
export interface DiffGroupProps {
    /** The file this hunk belongs to. Shown only when `showHeader`. */
    filename?: string;
    lines: DiffLine[];
    /** Show the file header row. Off when `FileReview` already drew one. */
    showHeader?: boolean;
    /** Called when a line's gutter is clicked, to start a comment. */
    onLineClick?: (anchor: DiffAnchor) => void;
    /** Rendered under a line: an existing comment thread, or a draft editor. */
    renderBelowLine?: (anchor: DiffAnchor) => ReactNode;
    /** Collapse runs of unchanged lines longer than this. 0 disables. */
    collapseContext?: number;
    style?: CSSProperties;
}
export declare function DiffGroup({ filename, lines, showHeader, onLineClick, renderBelowLine, collapseContext, style, }: DiffGroupProps): import("react").JSX.Element;
export interface ThreadComment {
    id: string;
    author: string;
    body: ReactNode;
    /** Rendered as given. Format it for the reader. */
    timestamp?: ReactNode;
}
export interface ReviewCommentProps {
    comment: ThreadComment;
    style?: CSSProperties;
}
export declare function ReviewComment({ comment, style }: ReviewCommentProps): import("react").JSX.Element;
export interface ReviewThreadProps {
    anchor: DiffAnchor;
    comments: ThreadComment[];
    status?: 'open' | 'resolved';
    onResolve?: () => void;
    /** Rendered under the comments: a reply box, a fix button. */
    footer?: ReactNode;
    style?: CSSProperties;
}
/** A comment thread on one line. */
export declare function ReviewThread({ anchor, comments, status, onResolve, footer, style }: ReviewThreadProps): import("react").JSX.Element;
export interface CommentDraftProps {
    anchor: DiffAnchor;
    /** Called with the typed text. */
    onSubmit: (text: string) => void;
    onCancel: () => void;
    submitLabel?: string;
    placeholder?: string;
    style?: CSSProperties;
}
/** The box a reviewer types a new comment into. */
export declare function CommentDraft({ anchor, onSubmit, onCancel, submitLabel, placeholder, style, }: CommentDraftProps): import("react").JSX.Element;
export interface ReviewThreadRecord {
    id: string;
    anchor: DiffAnchor;
    comments: ThreadComment[];
    status?: 'open' | 'resolved';
}
export interface FileReviewProps {
    filename: string;
    lines: DiffLine[];
    threads?: ReviewThreadRecord[];
    /** The line currently being commented on. */
    draftAnchor?: DiffAnchor;
    onRequestComment?: (anchor: DiffAnchor) => void;
    onDiscardDraft?: () => void;
    onSubmitDraft?: (anchor: DiffAnchor, text: string) => void;
    onResolveThread?: (threadId: string) => void;
    /** Rendered per thread, e.g. a SendToChatButton that asks for the fix. */
    renderThreadFooter?: (thread: ReviewThreadRecord) => ReactNode;
    collapseContext?: number;
    style?: CSSProperties;
}
/**
 * One file's diff with its comment threads.
 *
 * The composition that makes a review canvas: a diff, threads pinned to lines,
 * and a draft box on the line being commented. Wiring these together per canvas
 * is how three canvases end up with three different anchoring rules.
 */
export declare function FileReview({ filename, lines, threads, draftAnchor, onRequestComment, onDiscardDraft, onSubmitDraft, onResolveThread, renderThreadFooter, collapseContext, style, }: FileReviewProps): import("react").JSX.Element;
export interface CodeBlockProps {
    code: string;
    /** Shown in the header. Not used for highlighting — see the module comment. */
    language?: string;
    filename?: string;
    /** Start numbering here, for an excerpt from the middle of a file. */
    startLine?: number;
    /** 1-based line numbers to tint, relative to `startLine`. */
    highlightLines?: number[];
    maxHeight?: number | string;
    style?: CSSProperties;
}
/** A source excerpt with line numbers. For quoting code that is not a diff. */
export declare function CodeBlock({ code, language, filename, startLine, highlightLines, maxHeight, style, }: CodeBlockProps): import("react").JSX.Element;
export interface ReviewThreadStore {
    threads: ReviewThreadRecord[];
    /** The line a comment is being written on, if any. */
    draft?: DiffAnchor;
    /** Open the draft editor on a line. */
    requestComment: (anchor: DiffAnchor) => void;
    discardDraft: () => void;
    /** Turn the draft into a thread. Returns the new thread id. */
    submitDraft: (anchor: DiffAnchor, comment: Omit<ThreadComment, 'id'>) => string;
    appendComment: (threadId: string, comment: Omit<ThreadComment, 'id'>) => void;
    resolveThread: (threadId: string) => void;
    reset: () => void;
}
/**
 * The thread bookkeeping a review canvas would otherwise rewrite every time.
 *
 * `FileReview` is deliberately controlled — it renders the threads it is handed
 * and reports clicks — because a review canvas may want threads that came from
 * the agent, from disk, or from the user in this session. The cost is that every
 * such canvas re-implements the same five operations, and gets id generation
 * wrong the same way: reusing the anchor as the id, so a second comment on one
 * line silently replaces the first.
 *
 * In-memory by design. Persisting through `useCanvasState` would write every
 * keystroke of an in-progress comment into the sidecar; a canvas that wants
 * threads to survive a reload should store the SUBMITTED ones itself.
 */
export declare function useReviewThreadStore(): ReviewThreadStore;
