import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigType } from '@nestjs/config'
import axios, { type AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import mailConfig from '~/config/mail.config'

export interface SendMailPayload {
  to: string
  subject: string
  text?: string
  html?: string
  templateId?: string
  templateVariables?: Record<string, unknown>
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)
  private readonly apiBaseUrl = 'https://api.rusender.ru/api/v1/external-mails'
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

    const plainBody = this.buildPlainBody(payload)

    if (payload.templateId) {
      const numericTemplateId = Number(payload.templateId)
      if (Number.isNaN(numericTemplateId)) {
        this.logger.warn(
          `Template id "${payload.templateId}" is not numeric. Falling back to plain email.`,
        )
      } else {
        const templateBody = this.buildTemplateBody(
          payload,
          numericTemplateId,
        )

        try {
          const response = await this.sendViaRusender(
            'send-by-template',
            templateBody,
          )
          this.logger.log(
            `Email sent via template to ${payload.to}${this.extractRusenderUuid(response)}`,
          )
          return
        } catch (error) {
          const message = this.formatAxiosError(error)
          this.logger.warn(
            `Template send failed for ${payload.to}. Falling back to plain email: ${message}`,
          )
        }
      }
    }

    try {
      const response = await this.sendViaRusender('send', plainBody)
      this.logger.log(
        `Email sent to ${payload.to}${this.extractRusenderUuid(response)}`,
      )
    } catch (error) {
      const message = this.formatAxiosError(error)
      this.logger.error(
        `Rusender API error while sending to ${payload.to}: ${message}`,
      )
    }
  }

  private buildPlainBody(payload: SendMailPayload): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      mail: {
        to: { email: payload.to },
        from: {
          email: this.fromEmail,
          name: this.fromName ?? undefined,
        },
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? payload.subject,
      },
    }
  }

  private buildTemplateBody(
    payload: SendMailPayload,
    templateId: number,
  ): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      mail: {
        to: { email: payload.to },
        from: {
          email: this.fromEmail,
          name: this.fromName ?? undefined,
        },
        subject: payload.subject,
        idTemplateMailUser: templateId,
        params: payload.templateVariables ?? {},
      },
    }
  }

  private async sendViaRusender(
    path: 'send' | 'send-by-template',
    body: Record<string, unknown>,
  ): Promise<AxiosResponse<{ uuid?: string }>> {
    return axios.post(`${this.apiBaseUrl}/${path}`, body, {
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    })
  }

  private extractRusenderUuid(response: AxiosResponse<{ uuid?: string }>) {
    const uuid = response?.data?.uuid
    return uuid ? ` (uuid=${uuid})` : ''
  }

  private formatAxiosError(error: unknown) {
    const fallback = error instanceof Error ? error.message : String(error)
    if (!error || typeof error !== 'object') return fallback

    const maybeAxios = error as {
      message?: string
      response?: { status?: number; data?: unknown }
    }
    const status = maybeAxios.response?.status
    const data = maybeAxios.response?.data
    if (status) {
      return `${maybeAxios.message ?? fallback}; status=${status}; response=${JSON.stringify(data)}`
    }
    return maybeAxios.message ?? fallback
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
