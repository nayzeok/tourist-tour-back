import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigType } from '@nestjs/config'
import axios from 'axios'
import mailConfig from '~/config/mail.config'

export interface SendMailPayload {
  to: string
  subject: string
  text?: string
  html?: string
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)
  private readonly apiKey?: string
  private readonly fromEmail?: string
  private readonly fromName?: string

  constructor(
    @Inject(mailConfig.KEY)
    private readonly config: ConfigType<typeof mailConfig>,
  ) {
    this.apiKey = config.rusenderKey

    if (config.from) {
      const parsed = this.parseFrom(config.from)
      this.fromEmail = parsed.email
      this.fromName = parsed.name
    }

    if (!this.fromEmail) {
      this.logger.warn('MAIL_FROM is not configured. Emails will be logged only.')
    }

    if (!this.apiKey) {
      this.logger.warn(
        'RUSENDER_KEY is not configured. Emails will be logged only.',
      )
    }
  }

  async sendMail(payload: SendMailPayload) {
    if (!payload.to) {
      throw new Error('Recipient email is required')
    }

    if (!this.apiKey || !this.fromEmail) {
      this.logger.log(
        `Mock send mail to ${payload.to} with subject ${payload.subject}`,
      )
      if (payload.text) {
        // this.logger.debug(payload.text)
      }
      if (payload.html) {
        // this.logger.debug(payload.html)
      }
      return
    }

    try {
      await axios.post(
        'https://rusender.ru/api/email/send',
        {
          api_key: this.apiKey,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          from: {
            email: this.fromEmail,
            name: this.fromName ?? undefined,
          },
          from_email: this.fromEmail,
          from_name: this.fromName,
          to: [
            {
              email: payload.to,
            },
          ],
          recipients: [
            {
              email: payload.to,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'X-Api-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(
        `Rusender API error while sending to ${payload.to}: ${message}`,
      )
    }
  }

  private parseFrom(value: string) {
    const angleMatch = value.match(/<([^>]+)>/)
    if (angleMatch) {
      const email = angleMatch[1]?.trim()
      const namePart = value.replace(angleMatch[0], '').trim().replace(/^"|"$/g, '')
      return {
        email: email ?? value.trim(),
        name: namePart.length ? namePart : undefined,
      }
    }

    return { email: value.trim(), name: undefined }
  }
}
