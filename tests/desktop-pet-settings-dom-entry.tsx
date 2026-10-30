import { createRoot } from 'react-dom/client';
import '../frontend/bridge/klaus-api';
import { PetsSettingsTab } from '../frontend/src/pages/settings/pets-tab';
import '../frontend/src/pages/settings/settings.module.css';

Object.assign(window, { currentLang: document.documentElement.lang, closeSettings: () => {} });
const mount = document.getElementById('fixture-root');
if (!mount) throw new Error('The desktop companion settings fixture has no mount');
createRoot(mount).render(<PetsSettingsTab />);
