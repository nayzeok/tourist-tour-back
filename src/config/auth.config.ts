import { registerAs } from '@nestjs/config'

export type CookieSameSite = 'lax' | 'strict' | 'none'

export interface AuthConfig {
  jwtSecret: string
  accessTokenTtl: string
  cookieName: string
  cookieMaxAgeMs: number
  cookieDomain?: string
  cookieSameSite: CookieSameSite
  cookieSecure: boolean
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const parseSameSite = (raw?: string): CookieSameSite => {
  const normalized = raw?.trim().toLowerCase()
  switch (normalized) {
    case 'strict':
    case 'none':
      return normalized
    default:
      return 'lax'
  }
}

const parseBool = (raw?: string, fallback = false) => {
  if (!raw) {
    return fallback
  }
  const normalized = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

export default registerAs(
  'auth',
  (): AuthConfig => ({
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    accessTokenTtl: process.env.JWT_ACCESS_TTL || '7d',
    cookieName: process.env.AUTH_COOKIE_NAME || 'access_token',
    cookieMaxAgeMs: Number(
      process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * ONE_DAY_MS,
    ),
    cookieDomain: resolveCookieDomain(),
    cookieSameSite: parseSameSite(process.env.AUTH_COOKIE_SAME_SITE),
    cookieSecure: resolveCookieSecure(),
  }),
)

function resolveCookieDomain() {
  const explicitDomain = process.env.AUTH_COOKIE_DOMAIN?.trim()
  if (explicitDomain) {
    return explicitDomain
  }

  const env = process.env.NODE_ENV?.trim().toLowerCase()
  const devLike = env === 'development' || env === 'dev' || env === 'test'

  if (!devLike) {
    return '.tourist-tours.ru'
  }

  return undefined
}

function resolveCookieSecure() {
  const env = process.env.NODE_ENV?.trim().toLowerCase()
  const devLike = env === 'development' || env === 'dev' || env === 'test'

  return parseBool(process.env.AUTH_COOKIE_SECURE, !devLike)
}
