import { registerAs } from '@nestjs/config'

export interface OAuthConfig {
  tokenUrl: string
  clientId: string
  clientSecret: string
}

export default registerAs(
  'oauth',
  (): OAuthConfig => ({
    tokenUrl:
      process.env.OAUTH_TOKEN_URL ||
      `${process.env.TL_BASE || 'https://partner.qatl.ru'}/auth/token`,
    clientId: process.env.OAUTH_CLIENT_ID || '',
    clientSecret: process.env.OAUTH_CLIENT_SECRET || '',
  }),
)
