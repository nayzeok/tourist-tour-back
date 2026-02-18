import { registerAs } from '@nestjs/config'

export interface MailConfig {
  rusenderKey?: string
  from?: string
  templateWelcome?: string
}

export default registerAs(
  'mail',
  (): MailConfig => ({
    rusenderKey: process.env.RUSENDER_KEY || undefined,
    from: process.env.MAIL_FROM || undefined,
    templateWelcome: process.env.RUSENDER_TEMPLATE_WELCOME || undefined,
  }),
)
