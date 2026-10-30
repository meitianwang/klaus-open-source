/** Extra windows keep draft and panel intent separate, including across renderer reloads. */
export function windowStateKey(key: string): string {
  const search = typeof window === 'undefined' ? '' : window.location?.search ?? '';
  const id = new URLSearchParams(search).get('windowId');
  return id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? `klaus.window.${id}.${key}` : key;
}
