import { getCACertificates, setDefaultCACertificates } from 'node:tls';

interface CertificateStore {
  get(type: 'default' | 'system'): string[];
  set(certificates: readonly string[]): void;
}

/** Use the operating system's trusted issuers for host HTTP and WebSocket clients. */
export function configureSystemTrust(store: CertificateStore = {
  get: getCACertificates, set: setDefaultCACertificates,
}): number {
  const current = store.get('default');
  const combined = [...new Set([...current, ...store.get('system')])];
  const added = combined.length - new Set(current).size;
  if (added > 0) store.set(combined);
  return added;
}
