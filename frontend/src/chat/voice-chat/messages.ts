export const voiceChatEn = {
  kb_cmd_start_voice_chat: 'Start voice chat', kb_cmd_start_voice_chat_desc: 'Start live voice in the current conversation.',
  kb_cmd_toggle_voice_chat: 'Toggle voice chat', kb_cmd_toggle_voice_chat_desc: 'Start a new voice conversation or end the current call from any application.',
  voice_chat_start: 'Start voice chat', voice_chat_cancel: 'Cancel voice chat', voice_chat_stop: 'Stop voice chat', voice_chat_ending: 'Ending voice chat…',
  voice_chat_mic_mute: 'Mute microphone', voice_chat_mic_unmute: 'Unmute microphone', voice_chat_speaker_mute: 'Mute speakers', voice_chat_speaker_unmute: 'Unmute speakers',
  voice_chat_starting: 'Starting voice chat', voice_chat_listening: 'Listening', voice_chat_thinking: 'Thinking', voice_chat_speaking: 'Speaking', voice_chat_muted: 'Microphone muted',
  voice_chat_failed: 'Voice chat couldn’t start', voice_chat_retry_hint: 'Try again, or go back', voice_chat_retry: 'Try again', voice_chat_feedback: 'Send feedback', voice_chat_back: 'Back',
  voice_chat_mic_denied: 'Microphone permission denied', voice_chat_mic_hint: 'Allow microphone access in system settings to start a voice chat', voice_chat_system_settings: 'Open system settings',
  voice_chat_unavailable: 'The current voice source does not support live voice chat.', voice_chat_auth: 'Sign in to your model source to start voice chat.',
  voice_chat_not_configured: 'Choose a realtime voice source in Settings → Voice.',
  voice_chat_limit: 'Your model source’s voice usage limit has been reached.', voice_chat_disconnected: 'Voice chat disconnected. Try again.',
  voice_chat_busy: 'Voice chat is already active in another window', voice_chat_return: 'Open voice conversation', voice_chat_transcript: 'Live voice transcript',
  voice_chat_retry_end: 'Try ending voice chat again', voice_chat_stop_failed: 'Unable to stop voice chat', voice_chat_working: 'Working',
  voice_chat_command: 'Running command', voice_chat_editing: 'Editing files', voice_chat_reading: 'Reading files', voice_chat_searching: 'Searching', voice_chat_waiting: 'Waiting for approval', voice_chat_more: '+{count} more',
};
export const voiceChatZh: typeof voiceChatEn = {
  kb_cmd_start_voice_chat: '开始语音聊天', kb_cmd_start_voice_chat_desc: '在当前会话中启动实时语音。',
  kb_cmd_toggle_voice_chat: '切换语音聊天', kb_cmd_toggle_voice_chat_desc: '从任意应用启动新的语音会话，或结束当前通话。',
  voice_chat_start: '开始语音聊天', voice_chat_cancel: '取消语音聊天', voice_chat_stop: '停止语音聊天', voice_chat_ending: '正在结束语音聊天…',
  voice_chat_mic_mute: '将麦克风静音', voice_chat_mic_unmute: '取消麦克风静音', voice_chat_speaker_mute: '将扬声器静音', voice_chat_speaker_unmute: '取消扬声器静音',
  voice_chat_starting: '正在启动语音聊天', voice_chat_listening: '正在聆听', voice_chat_thinking: '正在思考', voice_chat_speaking: '正在说话', voice_chat_muted: '麦克风已静音',
  voice_chat_failed: '无法启动语音聊天', voice_chat_retry_hint: '请重试，或返回', voice_chat_retry: '重试', voice_chat_feedback: '发送反馈', voice_chat_back: '返回',
  voice_chat_mic_denied: '麦克风权限被拒绝', voice_chat_mic_hint: '请在系统设置中允许访问麦克风，以启动语音聊天', voice_chat_system_settings: '打开系统设置',
  voice_chat_unavailable: '当前语音来源不支持实时语音聊天。', voice_chat_auth: '请登录模型来源以启动语音聊天。',
  voice_chat_not_configured: '请先在「设置 → 语音」中选择实时语音来源。',
  voice_chat_limit: '模型来源的语音用量已达上限。', voice_chat_disconnected: '语音聊天已断开，请重试。',
  voice_chat_busy: '另一个窗口中已有正在进行的语音聊天', voice_chat_return: '打开语音会话', voice_chat_transcript: '实时语音转写',
  voice_chat_retry_end: '重试结束语音聊天', voice_chat_stop_failed: '无法停止语音聊天', voice_chat_working: '正在处理',
  voice_chat_command: '正在运行命令', voice_chat_editing: '正在编辑文件', voice_chat_reading: '正在读取文件', voice_chat_searching: '正在搜索', voice_chat_waiting: '等待批准', voice_chat_more: '另有 {count} 项',
};

export function voiceChatErrorKey(value: unknown): keyof typeof voiceChatEn {
  const message = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  if (/realtime-source-not-configured/i.test(message)) return 'voice_chat_not_configured';
  if (/Unable to stop voice|finish closing/i.test(message)) return 'voice_chat_stop_failed';
  if (/NotAllowedError|mic-denied|permission|microphone access/i.test(message)) return 'voice_chat_mic_denied';
  if (/VOICE_BUSY|already active|already owns|does not own this voice session/i.test(message)) return 'voice_chat_busy';
  if (/rate.limit|usage.limit|billing|required.*payment/i.test(message)) return 'voice_chat_limit';
  if (/sign.?in|authenticat|credential|logged.?in/i.test(message)) return 'voice_chat_auth';
  if (/not support|unsupported|realtime-source|configured realtime|explicit realtime/i.test(message)) return 'voice_chat_unavailable';
  return 'voice_chat_disconnected';
}
