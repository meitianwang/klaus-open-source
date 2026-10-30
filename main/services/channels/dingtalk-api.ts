import { randomBytes } from 'node:crypto';
import { string, type JsonObject } from '../service-types';
import { ChannelHttp, ChannelHttpError, channelUrl, waitForChannelOperation, type ChannelHttpOptions } from './channel-http';
import { DINGTALK_ROBOT_TOPIC, dingtalkId, dingtalkTarget, dingtalkTitle } from './dingtalk-wire';
import type { ChannelInbound, ChannelSend } from './types';

export interface DingTalkApiOptions extends ChannelHttpOptions { now?: () => number }
export class DingTalkAuthenticationError extends Error {}
const CARD_TEMPLATE = '382e4302-551d-4880-bf29-a30acfab2e71.schema';

export class DingTalkApi {
  private readonly http: ChannelHttp;
  private token?: { value: string; refreshAt: number };
  private tokenRequest?: Promise<string>;
  constructor(private readonly clientId: string, private readonly secret: string, signal: AbortSignal, private readonly options: DingTalkApiOptions = {}) {
    dingtalkId(clientId, 'client id');
    if (!secret.trim() || Buffer.byteLength(secret) > 16_384 || /[\u0000-\u001f\u007f]/u.test(secret)) throw new Error('Invalid DingTalk client secret');
    this.http = new ChannelHttp('DingTalk', 'https://api.dingtalk.com', signal, options);
  }
  async close(): Promise<void> { await this.http.close(); await this.tokenRequest?.catch(() => undefined); this.token = undefined; }
  accessToken(signal = this.http.signal): Promise<string> {
    this.http.active(signal);
    if (this.token && (this.options.now?.() ?? Date.now()) < this.token.refreshAt) return Promise.resolve(this.token.value);
    if (!this.tokenRequest) this.tokenRequest = (async () => {
      let value: JsonObject;
      try { value = await this.http.request('/v1.0/oauth2/accessToken', 'POST', { appKey: this.clientId, appSecret: this.secret }); }
      catch (error) { if (error instanceof ChannelHttpError && [401, 403].includes(error.status ?? 0)) throw new DingTalkAuthenticationError('DingTalk access token was rejected'); throw error; }
      const token = string(value.accessToken), ttl = value.expireIn;
      if (!token || Buffer.byteLength(token) > 16_384 || /[\u0000-\u0020\u007f]/u.test(token) || !Number.isSafeInteger(ttl) || Number(ttl) <= 0 || Number(ttl) > 31_536_000) throw new DingTalkAuthenticationError('DingTalk access token response is malformed');
      this.http.active(); this.token = { value: token, refreshAt: (this.options.now?.() ?? Date.now()) + Math.max(1, Number(ttl) * 1000 - 300_000) }; return token;
    })().finally(() => { this.tokenRequest = undefined; });
    return waitForChannelOperation(this.tokenRequest, AbortSignal.any([this.http.signal, signal]), 'DingTalk');
  }
  async gateway(): Promise<string> {
    let value: JsonObject;
    try { value = await this.http.request('/v1.0/gateway/connections/open', 'POST', { clientId: this.clientId, clientSecret: this.secret, ua: 'klaus-dingtalk', subscriptions: [{ type: 'EVENT', topic: '*' }, { type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }] }); }
    catch (error) { if (error instanceof ChannelHttpError && [400, 401, 403].includes(error.status ?? 0)) throw new DingTalkAuthenticationError('DingTalk gateway rejected the account'); throw error; }
    if (!string(value.endpoint) || !string(value.ticket) || Buffer.byteLength(string(value.ticket)) > 16_384) throw new Error('DingTalk gateway response is malformed');
    const url = channelUrl(string(value.endpoint), true); url.searchParams.set('ticket', string(value.ticket)); return url.toString();
  }
  private async call(path: string, method: string, payload: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const token = await this.accessToken(signal);
    let value: JsonObject;
    try { value = await this.http.request(path, method, payload, { 'x-acs-dingtalk-access-token': token }, signal); }
    catch (error) { if (error instanceof ChannelHttpError && error.status === 401 && this.token?.value === token) this.token = undefined; throw error; }
    if (value.success === false || (value.code !== undefined && value.code !== 0 && value.code !== '0')) throw new ChannelHttpError('DingTalk API rejected the operation', 'rejected');
    return value;
  }
  private text(params: ChannelSend): string {
    if (!['sendText', 'sendMessage'].includes(params.action ?? 'sendText')) throw new Error('DingTalk does not support this action');
    if (params.files?.length) throw new Error('DingTalk channel replies do not support attachments yet');
    if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('DingTalk channel reply text is empty');
    if (Buffer.byteLength(params.text) > 64 * 1024) throw new Error('DingTalk channel reply exceeds the size limit');
    return params.text;
  }
  async send(params: ChannelSend, signal = this.http.signal): Promise<JsonObject> {
    this.http.active(signal); const text = this.text(params), target = dingtalkTarget(params);
    const payload: JsonObject = { robotCode: this.clientId, ...(target.group ? { openConversationId: target.id } : { userIds: [target.id] }), msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: dingtalkTitle(text), text }) };
    const value = await this.call(target.group ? '/v1.0/robot/groupMessages/send' : '/v1.0/robot/oToMessages/batchSend', 'POST', payload, signal);
    const id = dingtalkId(value.processQueryKey, 'delivery receipt');
    if (Array.isArray(value.invalidStaffIdList) && value.invalidStaffIdList.length) throw new Error('DingTalk rejected the message recipient');
    return { ok: true, messageId: id, messageIds: [id] };
  }
  async reply(message: ChannelInbound, text: string, signal = this.http.signal): Promise<JsonObject> {
    const params: ChannelSend = { targetId: message.targetId!, chatType: message.chatType, text }; this.text(params); const target = dingtalkTarget(params);
    const outTrackId = 'card_' + (this.options.now?.() ?? Date.now()) + '_' + randomBytes(6).toString('hex');
    let contentAttempted = false, contentAccepted = false;
    try {
      await this.call('/v1.0/card/instances', 'POST', { cardTemplateId: CARD_TEMPLATE, outTrackId, cardData: { cardParamMap: {} }, callbackType: 'STREAM', imGroupOpenSpaceModel: { supportForward: true }, imRobotOpenSpaceModel: { supportForward: true } }, signal);
      await this.call('/v1.0/card/instances/deliver', 'POST', { outTrackId, userIdType: 1, openSpaceId: 'dtv1.card//' + (target.group ? 'IM_GROUP.' : 'IM_ROBOT.') + target.id,
        ...(target.group ? { imGroupOpenDeliverModel: { robotCode: this.clientId } } : { imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT' } }) }, signal);
      const update = (status: string, content: string): JsonObject => ({ outTrackId, cardData: { cardParamMap: { flowStatus: status, msgContent: content, staticMsgContent: '', sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }) } } });
      await this.call('/v1.0/card/instances', 'PUT', update('2', ''), signal);
      contentAttempted = true;
      await this.call('/v1.0/card/streaming', 'PUT', { outTrackId, guid: randomBytes(16).toString('hex'), key: 'msgContent', content: text, isFull: true, isFinalize: true, isError: false }, signal);
      contentAccepted = true;
      await this.call('/v1.0/card/instances', 'PUT', update('3', text), signal);
      return { ok: true, messageId: outTrackId, messageIds: [outTrackId], delivery: 'card' };
    } catch (error) {
      this.http.active(signal);
      // Do not duplicate a possibly delivered answer when a streaming reply lost its response.
      if (contentAccepted || (contentAttempted && !(error instanceof ChannelHttpError && error.kind === 'rejected'))) throw new Error('DingTalk card completion was not confirmed; delivery may be partial');
      return { ...await this.send(params, signal), delivery: 'markdown' };
    }
  }
}
