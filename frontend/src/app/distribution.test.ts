import { describe, expect, test } from 'bun:test'
import definitions from '../../../contracts/desktop-editions.json'
import vectors from '../../../contracts/vectors/desktop-edition-definition-vectors.json'
import { desktopDistribution, desktopServiceUrl, desktopSiteUrl, parseDesktopDistribution } from './distribution'
import { accountLoginErrorText } from '../chat/account-login-error'
import { I18N } from '../i18n/messages'

type Edition = { application: string; productName: string; protocol: string; serverUrl: string; supportEmail: string; defaultLanguage: string | null }
function metadata(id: string, value: Edition) {
  return { edition: id, application: value.application, productName: value.productName, protocol: value.protocol,
    serverUrl: value.serverUrl, siteUrl: value.serverUrl, supportEmail: value.supportEmail, defaultLanguage: value.defaultLanguage }
}
const publicEditions = definitions.editions as Record<string, Edition>
const sample = vectors.extra as Edition

describe('desktop distribution metadata', () => {
  test('each edition resolves its own services and public site independently of presentation language', () => {
    for (const id of Object.keys(publicEditions)) {
      const value = parseDesktopDistribution(metadata(id, publicEditions[id]!))
      expect(desktopServiceUrl('/api/avatar', value)).toBe(publicEditions[id]!.serverUrl + '/api/avatar')
      expect(desktopSiteUrl('/updates', value)).toBe(publicEditions[id]!.serverUrl + '/updates')
      expect(Object.isFrozen(value)).toBe(true)
      for (const language of ['en', 'zh'] as const) {
        expect(accountLoginErrorText('login_poll_rejected:403', key => I18N[language][key as keyof typeof I18N.en] as string, value.serverUrl))
          .toContain(new URL(value.serverUrl).host)
      }
    }
  })

  test('the host decides the identity, including an edition absent from the public definitions', () => {
    const value = parseDesktopDistribution(metadata('sample', sample))
    expect(value.edition).toBe('sample')
    expect(value.application).toBe(sample.application)
    expect(value.protocol).toBe(sample.protocol)
    expect(desktopSiteUrl('/updates', value)).toBe(sample.serverUrl + '/updates')
    expect(value.defaultLanguage).toBe('en')
  })

  test('the value before the host answers is the default edition', () => {
    expect(desktopDistribution().edition).toBe('domestic')
    expect(desktopDistribution().siteUrl).toBe(publicEditions.domestic!.serverUrl)
  })

  test('malformed identities, credentials and executable service URLs are rejected', () => {
    const base = metadata('sample', sample)
    expect(() => parseDesktopDistribution({ ...base, edition: 'Not An Id' })).toThrow('edition')
    expect(() => parseDesktopDistribution({ ...base, protocol: 'https' })).toThrow('protocol')
    expect(() => parseDesktopDistribution({ ...base, protocol: 'klaus-app' })).toThrow('protocol')
    expect(() => parseDesktopDistribution({ ...base, application: '' })).toThrow('application')
    expect(() => parseDesktopDistribution({ ...base, productName: 'x'.repeat(65) })).toThrow('productName')
    expect(() => parseDesktopDistribution({ ...base, supportEmail: 'not-an-address' })).toThrow('supportEmail')
    expect(() => parseDesktopDistribution({ ...base, defaultLanguage: 'fr' })).toThrow('defaultLanguage')
    expect(() => parseDesktopDistribution({ ...base, siteUrl: 'http://desktop.example.invalid' })).toThrow('URL')
    expect(() => parseDesktopDistribution({ ...base, siteUrl: 'https://desktop.example.invalid/path' })).toThrow('URL')
    expect(() => parseDesktopDistribution({ ...base, serverUrl: 'javascript:fixture' })).toThrow('URL')
    expect(() => parseDesktopDistribution({ ...base, serverUrl: 'https://user:fixture@api.example.invalid' })).toThrow('URL')
    expect(() => parseDesktopDistribution(null)).toThrow('distribution')
  })

  test('an explicitly configured API prefix does not replace the edition public site', () => {
    const value = parseDesktopDistribution({ ...metadata('international', publicEditions.international!), serverUrl: 'http://127.0.0.1:3000/proxy/' })
    expect(desktopServiceUrl('/api/avatar', value)).toBe('http://127.0.0.1:3000/proxy/api/avatar')
    expect(desktopSiteUrl('/updates', value)).toBe(publicEditions.international!.serverUrl + '/updates')
  })
})
