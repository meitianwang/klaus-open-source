import { isAbsolute, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { canonicalProfilePath } from '../services/config-root';
import { getDesktopEdition, loadedDesktopEditions } from '../services/desktop-edition';

/** The legacy identity's application, shared by every package built before editions existed. */
export const DESKTOP_INSTANCE_IDENTITY = getDesktopEdition().application;

/** Only a controlled development launch can opt into an isolated test identity. */
export function instanceIdentity(options: {
  packaged: boolean;
  configRoot: string;
  defaultConfigRoot: string;
  env: NodeJS.ProcessEnv;
  application?: string;
}): string {
  const application = options.application ?? DESKTOP_INSTANCE_IDENTITY;
  const edition = Object.values(loadedDesktopEditions(options.env)).find(value => value.application === application);
  if (!edition) throw new Error('Invalid desktop application identity');
  // Development fixtures are a legacy-identity convenience; other editions always use their trusted application.
  if (!edition.legacyIdentity) return application;
  const fixture = options.env.KLAUS_INSTANCE_FIXTURE_ID;
  if (options.packaged || fixture === undefined) return DESKTOP_INSTANCE_IDENTITY;
  if (options.env.KLAUS_TEST !== '1' || !options.env.KLAUS_CONFIG_DIR || !isAbsolute(options.configRoot)
    || resolve(options.configRoot) === resolve(options.defaultConfigRoot)
    || !/^ai\.klaus\.instance-fixture\.[a-zA-Z0-9_-]{1,40}$/.test(fixture)) {
    throw new Error('An instance fixture requires an explicit test identity and an independent absolute data profile');
  }
  if (!lstatSync(options.configRoot).isDirectory()) throw new Error('An instance fixture profile must already be a regular directory');
  if (canonicalProfilePath(options.configRoot) === canonicalProfilePath(options.defaultConfigRoot)) throw new Error('An instance fixture cannot use the default data profile');
  return fixture;
}
