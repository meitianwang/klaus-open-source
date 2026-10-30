import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { checkCancelled } from '../services/download';
import { errorMessage, object, string, type JsonObject } from '../services/service-types';

export interface FeedbackTransportDeps {
  serverUrl: string;
  token: () => string | undefined | Promise<string | undefined>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}
export interface SupportSubmission {
  kind: 'suggestion' | 'debug_report';
  id: string;
  description: string;
  createdAt: string;
  filePath: string;
  report: JsonObject;
  attachments: Array<{ filename: string; bytes: Buffer; contentType?: string }>;
}
const value = (env: NodeJS.ProcessEnv, key: string): string => string(env[key]).trim();
export function smtpOptions(env: NodeJS.ProcessEnv): { host: string; port: number; secure: boolean; user: string; pass: string; from: string; to: string } {
  const to = value(env, 'KLAUS_FEEDBACK_EMAIL_TO') || 'support@klaus-ai.cn', user = value(env, 'KLAUS_FEEDBACK_SMTP_USER');
  const raw = value(env, 'KLAUS_FEEDBACK_SMTP_PORT'), number = Number(raw), port = raw && Number.isInteger(number) && number >= 1 && number <= 65535 ? number : undefined;
  const flag = value(env, 'KLAUS_FEEDBACK_SMTP_SECURE').toLowerCase();
  const secure = ['true', '1', 'yes', 'on'].includes(flag) ? true : ['false', '0', 'no', 'off'].includes(flag) ? false : port === 465;
  return { host: value(env, 'KLAUS_FEEDBACK_SMTP_HOST'), port: port ?? (secure ? 465 : 587), secure, user,
    pass: value(env, 'KLAUS_FEEDBACK_SMTP_PASS'), from: value(env, 'KLAUS_FEEDBACK_EMAIL_FROM') || user || to, to };
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkCancelled(signal); let cancel: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('cancelled')); signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}
async function responseBody(response: Response): Promise<JsonObject> {
  if (!response.body) return {};
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const row = await reader.read(); if (row.done) break;
      size += row.value.length; if (size > 256 * 1024) throw new Error('Support response is too large'); parts.push(row.value);
    }
    try { return object(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { return {}; }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Sends only explicit support submissions; account credentials are supplied by their owner. */
export class FeedbackTransport {
  constructor(private readonly deps: FeedbackTransportDeps) {}
  private async smtp(submission: SupportSubmission, config: ReturnType<typeof smtpOptions>, signal: AbortSignal): Promise<JsonObject> {
    const timeout = this.deps.requestTimeoutMs ?? 30_000, sockets = new Set<Socket>();
    const abort = (): void => { for (const socket of sockets) socket.destroy(new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    const options: SMTPTransport.Options = {
      host: config.host, port: config.port, secure: config.secure,
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout, dnsTimeout: timeout,
      ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
      disableFileAccess: true, disableUrlAccess: true,
      getSocket: (_options, callback) => {
        if (signal.aborted) { callback(new Error('cancelled'), false); return; }
        const socket = config.secure ? connectTls({ host: config.host, port: config.port, ...(isIP(config.host) ? {} : { servername: config.host }) })
          : connectTcp({ host: config.host, port: config.port });
        sockets.add(socket); let handedOff = false;
        socket.once('close', () => { sockets.delete(socket); });
        socket.once('error', error => { if (!handedOff) { handedOff = true; callback(error, false); } });
        socket.once(config.secure ? 'secureConnect' : 'connect', () => {
          if (handedOff) return; handedOff = true;
          if (signal.aborted) { socket.destroy(); callback(new Error('cancelled'), false); return; }
          callback(null, { connection: socket, secured: config.secure });
        });
      },
    };
    const transport = nodemailer.createTransport(options);
    try {
      checkCancelled(signal);
      const result = await abortable(transport.sendMail({
        from: config.from, to: config.to, subject: '[Klaus Feedback] ' + submission.id,
        text: 'Feedback ID: ' + submission.id + '\nCreated at: ' + submission.createdAt + '\nReport path: ' + submission.filePath
          + '\n\nDescription:\n' + submission.description + '\n\nThe feedback report is attached as JSON.',
        attachments: [{ filename: submission.id + '.json', content: Buffer.from(JSON.stringify(submission.report, null, 2) + '\n'), contentType: 'application/json' }],
      }), signal);
      if (!result.accepted.length || result.rejected.length) throw new Error('SMTP recipient was not accepted');
      return { attempted: true, sent: true, to: config.to, messageId: result.messageId };
    } catch (error) { return { attempted: true, sent: false, to: config.to, error: errorMessage(error) }; }
    finally {
      transport.close(); signal.removeEventListener('abort', abort);
      const closing = [...sockets].map(socket => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.destroy(); }));
      await Promise.all(closing);
    }
  }
  async send(submission: SupportSubmission, signal: AbortSignal): Promise<JsonObject> {
    const env = this.deps.environment ?? process.env, config = smtpOptions(env), timeout = this.deps.requestTimeoutMs ?? 30_000;
    let token: string | undefined;
    try { token = await abortable(Promise.resolve(this.deps.token()), signal); }
    catch (error) { return { attempted: false, sent: false, to: config.to, error: errorMessage(error) }; }
    if (!token) return { attempted: false, sent: false, to: config.to, skippedReason: 'not_authenticated' };
    const controller = new AbortController(), cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeout);
    let remoteError: unknown;
    try {
      checkCancelled(signal);
      const base = (value(env, 'KLAUS_SUPPORT_SERVER_URL') || this.deps.serverUrl).replace(/\/+$/, ''), url = new URL(base + '/api/support/feedback');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid support endpoint');
      const response = await (this.deps.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ kind: submission.kind, id: submission.id, description: submission.description, createdAt: submission.createdAt,
          report: submission.report, attachments: submission.attachments.map(file => ({ filename: file.filename, dataBase64: file.bytes.toString('base64'),
            ...(file.contentType === undefined ? {} : { contentType: file.contentType }) })) }) });
      if (response.status === 401) { await response.body?.cancel(); return { attempted: true, sent: false, to: config.to, skippedReason: 'not_authenticated' }; }
      const data = await responseBody(response);
      if (!response.ok || data.ok !== true) throw new Error(string(data.error) || 'server_' + response.status);
      const email = object(data.email), result: JsonObject = { attempted: true, sent: email.sent === true, to: string(email.to) || config.to, serverAccepted: true };
      for (const key of ['messageId', 'skippedReason', 'error']) if (email[key] != null) result[key] = email[key]!;
      if (data.submissionId != null) result.submissionId = data.submissionId;
      return result;
    } catch (error) { remoteError = error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    if (signal.aborted || !config.host) return { attempted: true, sent: false, to: config.to, error: signal.aborted ? 'cancelled' : errorMessage(remoteError) };
    const smtpController = new AbortController(), stop = (): void => smtpController.abort();
    signal.addEventListener('abort', stop, { once: true });
    const smtpTimer = setTimeout(stop, timeout);
    try { return await this.smtp(submission, config, smtpController.signal); }
    finally { clearTimeout(smtpTimer); signal.removeEventListener('abort', stop); }
  }
}
