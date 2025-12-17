import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios'
import { OAuthConfig } from '~/config/oauth.config'
import { RedisService } from '~/redis/redis.service'

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
}

@Injectable()
export class OAuthService implements OnModuleInit {
  private readonly logger = new Logger(OAuthService.name)
  private readonly httpClient: AxiosInstance
  private readonly api: AxiosInstance
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly tokenCacheKey = 'oauth:access_token'

  // In-memory cache to reduce Redis hits
  private memoryToken: string | null = null
  private memoryTokenExpiresAt: number | null = null
  private refreshingPromise: Promise<string> | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const oauthConfig = this.configService.get<OAuthConfig>('oauth')
    this.tokenUrl = oauthConfig!.tokenUrl
    this.clientId = oauthConfig!.clientId
    this.clientSecret = oauthConfig!.clientSecret

    // Создаем отдельный HTTP клиент для OAuth запросов
    this.httpClient = axios.create({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'TravelApp/1.0',
      },
    })

    const baseUrl =
      this.configService.get<string>('TL_BASE') || 'https://partner.qatl.ru'

    // Общий API клиент с интерцепторами
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'User-Agent': 'TravelApp/1.0',
      },
    })

    // Request: подставляем Bearer токен
    this.api.interceptors.request.use(async (config) => {
      const token = await this.getValidAccessToken()
      config.headers = config.headers ?? {}
      const headers = config.headers as Record<string, string>
      headers.Authorization = `Bearer ${token}`
      return config
    })

    // Response: авто-рефреш при 401
    this.api.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const original = error.config as AxiosRequestConfig & {
          _retry?: boolean
        }
        if (
          (error.response?.status === 401 || error.response?.status === 403) &&
          original &&
          !original._retry
        ) {
          original._retry = true
          try {
            const newToken = await this.refreshToken()
            original.headers = original.headers ?? {}
            const headers = original.headers as Record<string, string>
            headers.Authorization = `Bearer ${newToken}`
            return this.api.request(original)
          } catch (e) {
            this.logger.error(
              'Token refresh failed',
              (e as AxiosError)?.message || String(e),
            )
          }
        }
        return Promise.reject(error)
      },
    )
  }

  async onModuleInit() {
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn('OAuth credentials not configured')
      return
    }

    // Получаем токен при старте приложения
    try {
      await this.getValidAccessToken()
      this.logger.log('OAuth token obtained successfully')
    } catch (error) {
      this.logger.error('Failed to obtain initial OAuth token', error)
    }
  }

  /**
   * Получает access token через clientCredentials flow
   */
  async getAccessToken(): Promise<string> {
    // Проверяем кэш в Redis
    const cachedToken = await this.redisService.get(this.tokenCacheKey)

    if (cachedToken) {
      this.memoryToken = cachedToken
      this.memoryTokenExpiresAt = null
      console.log('cachedToken', cachedToken)
      return cachedToken
    }

    try {
      // this.logger.debug('Requesting new access token')

      // Подготавливаем данные для запроса
      const params = new URLSearchParams()
      params.append('grant_type', 'client_credentials')
      params.append('client_id', this.clientId)
      params.append('client_secret', this.clientSecret)

      // Альтернативный способ передачи credentials через Authorization header
      const authHeader = Buffer.from(
        `${this.clientId}:${this.clientSecret}`,
      ).toString('base64')

      const response = await this.httpClient.post<TokenResponse>(
        this.tokenUrl,
        params,
        {
          headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      )

      const { access_token, expires_in } = response.data

      // Кэшируем токен в Redis с TTL (за 2 минуты до истечения)
      const ttl = Math.max(expires_in - 120, 60)
      await this.redisService.set(this.tokenCacheKey, access_token, ttl)
      this.memoryToken = access_token
      this.memoryTokenExpiresAt = Date.now() + ttl * 1000

      this.logger.log(`Access token cached for ${ttl} seconds`)
      return access_token
    } catch (error) {
      this.logger.error(
        'Failed to obtain access token',
        (error as AxiosError).response?.data || (error as Error).message,
      )
      throw new Error('OAuth authentication failed')
    }
  }

  /**
   * Создает авторизованный HTTP клиент с Bearer токеном
   */
  async createAuthorizedClient(): Promise<AxiosInstance> {
    const token = await this.getAccessToken()

    return axios.create({
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'TravelApp/1.0',
      },
    })
  }

  /**
   * Базовый универсальный метод запроса
   */
  async request<T = any>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.api.request<T>(config)
    return response.data
  }

  /**
   * Выполняет авторизованный GET запрос
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', url })
  }

  /**
   * Выполняет авторизованный POST запрос
   */
  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', url, data })
  }

  /**
   * Выполняет авторизованный PUT запрос
   */
  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    return this.request<T>({ ...config, method: 'PUT', url, data })
  }

  /**
   * Выполняет авторизованный DELETE запрос
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'DELETE', url })
  }

  /**
   * Принудительно обновляет токен (очищает кэш)
   */
  async refreshToken(): Promise<string> {
    await this.redisService.del(this.tokenCacheKey)
    this.memoryToken = null
    this.memoryTokenExpiresAt = null
    return await this.getValidAccessToken()
  }

  /**
   * Возвращает валидный access token: память -> Redis -> запрос
   */
  async getValidAccessToken(): Promise<string> {
    if (
      typeof this.memoryToken === 'string' &&
      this.memoryToken &&
      (!this.memoryTokenExpiresAt || Date.now() < this.memoryTokenExpiresAt)
    ) {
      return this.memoryToken
    }

    const cachedToken = await this.redisService.get(this.tokenCacheKey)
    if (cachedToken) {
      this.memoryToken = cachedToken
      this.memoryTokenExpiresAt = null
      return cachedToken
    }

    if (!this.refreshingPromise) {
      this.refreshingPromise = this.getAccessToken().finally(() => {
        this.refreshingPromise = null
      })
    }
    return this.refreshingPromise
  }
}
