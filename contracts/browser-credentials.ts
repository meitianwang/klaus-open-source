/**
 * Browser password and autofill contracts.
 *
 * The host owns the encrypted SQLite store. Renderers only receive metadata,
 * explicit one-time secret reads, or fill messages addressed to one frame. The
 * engine never receives credential values through these shapes.
 */

export type BrowserCredentialPurpose = 'display' | 'copy';

export type BrowserAutofillProfileKind = 'address' | 'contact';

export type BrowserAutofillFieldKind =
  | 'username'
  | 'password'
  | 'email'
  | 'address'
  | 'contact';

export interface BrowserPasswordInput {
  /** Present only when the settings editor updates an existing entry. */
  id?: string;
  originUrl: string;
  username: string;
  password: string;
  label?: string;
}

/** Metadata safe to keep in a list or renderer state. Never contains a password. */
export interface BrowserPasswordSummary {
  id: string;
  originUrl: string;
  username: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserPasswordImportRow {
  originUrl: string;
  username: string;
  password: string;
}

export type BrowserPasswordImportStatus = 'imported' | 'updated' | 'skipped' | 'failed';

export interface BrowserPasswordImportItem {
  index: number;
  status: BrowserPasswordImportStatus;
  credentialId?: string;
  reason?: string;
}

/** A write receipt for the external-browser importer. It contains no secrets. */
export interface BrowserPasswordImportReceipt {
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  items: BrowserPasswordImportItem[];
}

export interface BrowserAddressFields {
  fullName?: string;
  company?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
}

export interface BrowserContactFields {
  name?: string;
  email?: string;
  phone?: string;
}

export interface BrowserAutofillProfileInput {
  kind: BrowserAutofillProfileKind;
  label: string;
  fields: BrowserAddressFields | BrowserContactFields;
}

/** Metadata safe to keep in a list. The encrypted data is not included. */
export interface BrowserAutofillProfileSummary {
  id: string;
  kind: BrowserAutofillProfileKind;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserAutofillProfile extends BrowserAutofillProfileSummary {
  fields: BrowserAddressFields | BrowserContactFields;
}

export interface BrowserAutofillFrame {
  /** Stable frame identity from the host's frame tree. */
  frameId: string;
  /** Exact origin of this frame. Never inherited from the parent frame. */
  origin: string;
  /** Opaque document identity; changes on every committed navigation. */
  documentId: string;
  /** The parent frame's id, when the host can provide it. */
  parentFrameId?: string;
  isTopFrame: boolean;
}

export interface BrowserAutofillCandidate {
  id: string;
  kind: 'password' | BrowserAutofillProfileKind;
  originUrl?: string;
  username?: string;
  label?: string;
  /** Non-secret fields used by the trusted chooser. */
  preview?: string;
}

export interface BrowserAutofillChoice {
  candidateId: string;
}

export interface BrowserAutofillFillMessage {
  type: 'browser-autofill:fill';
  documentId: string;
  frameId: string;
  /** Non-reusable intent created by the preload for the exact form/field gesture. */
  intentId: string;
  kind: 'password' | BrowserAutofillProfileKind;
  values: {
    username?: string;
    password?: string;
    fields?: BrowserAddressFields | BrowserContactFields;
  };
}

export interface BrowserAutofillIntent {
  intentId: string;
  documentId: string;
  kind: BrowserAutofillFieldKind;
  trusted: true;
}

export interface BrowserAutofillDocumentIdentity {
  type: 'browser-autofill:document';
  documentId: string;
}

export interface BrowserAutofillAck {
  documentId: string;
  intentId: string;
  filled: boolean;
  reason?: 'no_target' | 'navigation' | 'cancelled';
}

export interface BrowserAutofillSaveCandidate {
  originUrl: string;
  username: string;
  password: string;
}

/**
 * Frozen at a trusted form submit. The host identity fields come from
 * event.senderFrame, never from page-provided payload. A submission may
 * outlive the document so a normal POST redirect can still be saved.
 */
export interface BrowserAutofillSubmission {
  submissionId: string;
  frameId: string;
  documentId: string;
  contentsId: number;
  processId: number;
  routingId: number;
  frameToken: string;
  frameTreeNodeId: number;
  originUrl: string;
  username: string;
  password: string;
  capturedAt: number;
}

export interface BrowserAutofillSaveReceipt {
  saved: boolean;
  reason?: 'cancelled' | 'navigation' | 'untrusted' | 'invalid' | 'disabled';
  credentialId?: string;
}

export interface BrowserAutofillFillReceipt {
  filled: boolean;
  reason?: 'cancelled' | 'navigation' | 'untrusted' | 'origin_mismatch' | 'not_found' | 'disabled' | 'busy' | 'timeout' | 'no_target' | 'unsafe_document';
}

/** Injected encryption boundary. Production wraps Electron safeStorage. */
export interface BrowserSecretCipher {
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export interface BrowserCredentialsStoreOptions {
  databasePath: string;
  cipher: BrowserSecretCipher;
  now?: () => number;
}

/**
 * Host-side autofill seams for trusted menus, confirmation dialogs and
 * messages addressed to the requesting frame.
 */
export interface BrowserAutofillOptions {
  store: {
    listPasswords(originUrl: string): Promise<BrowserPasswordSummary[]>;
    readPassword(
      id: string,
      purpose: BrowserCredentialPurpose,
      confirm: () => Promise<boolean> | boolean,
    ): Promise<string | null>;
    savePassword(input: BrowserPasswordInput): Promise<BrowserPasswordSummary>;
    listAutofillProfiles(kind?: BrowserAutofillProfileKind): Promise<BrowserAutofillProfileSummary[]>;
    readAutofillProfile(id: string): Promise<BrowserAutofillProfile | null>;
  };
  resolveFrame(frameId: string): Promise<BrowserAutofillFrame | null>;
  chooseCredential(
    candidates: BrowserAutofillCandidate[],
    context: { frame: BrowserAutofillFrame; kind: BrowserAutofillFieldKind; intentId: string },
  ): Promise<BrowserAutofillChoice | null>;
  confirmSave(
    candidate: BrowserAutofillSaveCandidate,
    context: { submission: BrowserAutofillSubmission },
  ): Promise<boolean>;
  /** Host liveness check for a frozen submission (window close, kill switch). */
  isSubmissionAlive?: (submission: BrowserAutofillSubmission) => boolean;
  sendToFrame(frameId: string, message: BrowserAutofillFillMessage): BrowserAutofillAck | Promise<BrowserAutofillAck>;
  /** Bound for waiting on the preload's post-write acknowledgment. */
  ackTimeoutMs?: number;
  /** Parent-owned kill switch for autofill; a disabled controller never sends. */
  enabled?: () => boolean;
  /**
   * Container integrity check run immediately before a fill lands. Returns
   * null when the frame fully contains its document, or a refusal reason code
   * when credentials must not reach it.
   */
  verifyContainer?(frame: BrowserAutofillFrame): Promise<string | null>;
}

export interface BrowserCredentialsApi {
  listPasswords(originUrl?: string): Promise<BrowserPasswordSummary[]>;
  savePassword(input: BrowserPasswordInput): Promise<BrowserPasswordSummary>;
  revealPassword(id: string): Promise<string>;
  copyPassword(id: string): Promise<void>;
  deletePassword(id: string): Promise<void>;
  importPasswords(rows: BrowserPasswordImportRow[]): Promise<BrowserPasswordImportReceipt>;
  listAutofillProfiles(kind?: BrowserAutofillProfileKind): Promise<BrowserAutofillProfileSummary[]>;
  getAutofillProfile(id: string): Promise<BrowserAutofillProfile | null>;
  saveAutofillProfile(input: BrowserAutofillProfileInput): Promise<BrowserAutofillProfileSummary>;
  updateAutofillProfile(id: string, input: BrowserAutofillProfileInput): Promise<BrowserAutofillProfileSummary>;
  deleteAutofillProfile(id: string): Promise<void>;
}

/** Labels are injected so this module does not touch the global i18n catalog. */
export interface BrowserCredentialsLabels {
  title: string;
  description: string;
  passwordsTitle: string;
  addressesTitle: string;
  contactsTitle: string;
  originLabel: string;
  usernameLabel: string;
  passwordLabel: string;
  labelLabel: string;
  saveButton: string;
  editButton?: string;
  revealButton: string;
  copyButton: string;
  deleteButton: string;
  emptyPasswords: string;
  emptyProfiles: string;
  importButton: string;
  fullNameLabel: string;
  companyLabel: string;
  addressLine1Label: string;
  addressLine2Label: string;
  cityLabel: string;
  stateLabel: string;
  postalCodeLabel: string;
  countryLabel: string;
  phoneLabel: string;
  emailLabel: string;
  contactNameLabel: string;
  cancelButton: string;
  errorLabel: string;
  operationFailed: string;
  passwordSearch: string;
  passwordAdd: string;
  passwordAccounts: string;
  passwordNoResults: string;
  copySucceeded: string;
}

export const BROWSER_AUTOFILL_CHANNELS = {
  fill: 'browser-autofill:fill',
  document: 'browser-autofill:document',
  documentRequest: 'browser-autofill:document-request',
  input: 'browser-autofill:input',
  submit: 'browser-autofill:submit',
  ack: 'browser-autofill:ack',
} as const;

export const BROWSER_CREDENTIAL_LIMITS = {
  maxOriginLength: 2_048,
  maxUsernameLength: 320,
  maxPasswordLength: 4_096,
  maxLabelLength: 200,
  maxFieldLength: 2_048,
  maxImportRows: 10_000,
  maxProfilesPerKind: 200,
} as const;
