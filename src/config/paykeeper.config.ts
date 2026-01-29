import { registerAs } from '@nestjs/config'

export interface PayKeeperConfig {
  server: string
  user: string
  password: string
  secretSeed: string
  enabled: boolean
}

export default registerAs(
  'paykeeper',
  (): PayKeeperConfig => ({
    server: process.env.PAYKEEPER_SERVER ?? 'https://tourist-tours.server.paykeeper.ru',
    user: process.env.PAYKEEPER_USER ?? 'Admin',
    password: process.env.PAYKEEPER_PASSWORD ?? '',
    secretSeed: process.env.PAYKEEPER_SECRET_SEED ?? '',
    enabled: (process.env.PAYKEEPER_ENABLED ?? 'false').trim().toLowerCase() === 'true',
  }),
)
