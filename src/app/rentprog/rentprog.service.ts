import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import axios, { AxiosInstance } from 'axios'
import { RedisService } from '~/redis/redis.service'
import { createWriteStream, mkdirSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { Cron, CronExpression } from '@nestjs/schedule'
import * as stream from 'stream'
import { promisify } from 'util'

const pipeline = promisify(stream.pipeline)

const RENTPROG_BASE = 'https://rentprog.net/api/v1/public'
const TOKEN_CACHE_KEY = 'rentprog:access_token'
const TOKEN_TTL_SEC = 3.5 * 60 * 60 // 3.5 часа (токен живёт 4 часа)
const IMAGES_DIR = join(process.cwd(), 'uploads', 'rent-cars')

/** Формат даты RentProg: DD-MM-YYYY H:mm */
function toRentProgDate(iso: string): string {
  const d = new Date(iso)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  const hours = d.getHours()
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${day}-${month}-${year} ${hours}:${minutes}`
}

@Injectable()
export class RentProgService implements OnModuleInit {
  private readonly logger = new Logger(RentProgService.name)
  private readonly companyToken: string
  private readonly http: AxiosInstance

  constructor(private readonly redis: RedisService) {
    this.companyToken = process.env.RENTPROG_TOKEN || process.env.NUXT_PUBLIC_RENTPROG_TOKEN || ''
    this.http = axios.create({ baseURL: RENTPROG_BASE, timeout: 15000 })
    mkdirSync(IMAGES_DIR, { recursive: true })
  }

  async onModuleInit() {
    // Первичная загрузка при старте (без блокировки — запускаем в фоне)
    this.syncCarImages().catch((e) =>
      this.logger.warn('Initial image sync failed: ' + e?.message),
    )
  }

  // ─── Ежедневная синхронизация фото в 3:00 ────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async syncCarImages() {
    this.logger.log('Синхронизация фото автомобилей...')
    try {
      const cars = await this.getAllCarsFull()
      const list = Array.isArray(cars) ? cars : []
      let downloaded = 0

      for (const car of list) {
        const url: string = car.avatar_url
        if (!url) continue

        const carId = String(car.id)
        const ext = extname(url.split('?')[0]) || '.jpg'
        const filePath = join(IMAGES_DIR, `${carId}${ext}`)

        // Пропускаем если файл уже есть (обновим только через cron)
        if (existsSync(filePath)) continue

        try {
          const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 10000,
          })
          await pipeline(response.data, createWriteStream(filePath))
          downloaded++
        } catch (e: any) {
          this.logger.warn(`Не удалось скачать фото для авто ${carId}: ${e?.message}`)
        }
      }

      this.logger.log(`Фото загружено: ${downloaded} из ${list.length}`)
    } catch (e: any) {
      this.logger.error('syncCarImages error: ' + e?.message)
    }
  }

  // ─── Принудительное обновление всех фото (сбрасывает кеш файлов) ──────────

  async forceResyncImages() {
    this.logger.log('Принудительная пересинхронизация фото...')
    try {
      const cars = await this.getAllCarsFull()
      const list = Array.isArray(cars) ? cars : []
      let downloaded = 0

      for (const car of list) {
        const url: string = car.avatar_url
        if (!url) continue

        const carId = String(car.id)
        const ext = extname(url.split('?')[0]) || '.jpg'
        const filePath = join(IMAGES_DIR, `${carId}${ext}`)

        try {
          const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 10000,
          })
          await pipeline(response.data, createWriteStream(filePath))
          downloaded++
        } catch (e: any) {
          this.logger.warn(`Не удалось скачать фото авто ${carId}: ${e?.message}`)
        }
      }

      return { downloaded, total: list.length }
    } catch (e: any) {
      this.logger.error('forceResyncImages error: ' + e?.message)
      throw e
    }
  }

  /** Возвращает локальный путь к фото авто (если скачано) или null */
  getLocalImagePath(carId: string, avatarUrl?: string): string | null {
    if (!avatarUrl) return null
    const ext = extname(avatarUrl.split('?')[0]) || '.jpg'
    const filePath = join(IMAGES_DIR, `${carId}${ext}`)
    if (existsSync(filePath)) {
      return `/uploads/rent-cars/${carId}${ext}`
    }
    return null
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async getToken(): Promise<string> {
    const cached = await this.redis.get(TOKEN_CACHE_KEY)
    if (cached) return cached

    const { data } = await this.http.get('/get_token', {
      params: { company_token: this.companyToken },
    })

    const token: string = data?.token || data?.access_token || data
    if (!token) throw new Error('RentProg: не удалось получить токен')

    await this.redis.set(TOKEN_CACHE_KEY, token, TOKEN_TTL_SEC)
    return token
  }

  private async authHeaders() {
    const token = await this.getToken()
    return { Authorization: token }
  }

  // ─── Cars ─────────────────────────────────────────────────────────────────

  /** Свободные авто на период */
  async getFreeCars(startDate: string, endDate: string) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/free_cars', {
      headers,
      params: {
        start_date: toRentProgDate(startDate),
        end_date: toRentProgDate(endDate),
      },
    })
    return data
  }

  /** Все авто с полными данными (кешируем 10 минут) */
  async getAllCarsFull() {
    const cacheKey = 'rentprog:all_cars_full'
    const cached = await this.redis.getJson(cacheKey)
    if (cached) return cached

    const headers = await this.authHeaders()
    const { data } = await this.http.get('/all_cars_full', { headers })

    await this.redis.setJson(cacheKey, data, 600)
    return data
  }

  /** Авто с ценой под конкретный период */
  async getCarData(id: string, startDate: string, endDate: string) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/car_data', {
      headers,
      params: {
        id,
        start_date: toRentProgDate(startDate),
        end_date: toRentProgDate(endDate),
      },
    })
    return data
  }

  /** Авто с данными о бронях */
  async getCarDataWithBookings(carId: string) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/car_data_with_bookings', {
      headers,
      params: { car_id: carId },
    })
    return data
  }

  // ─── Bookings ─────────────────────────────────────────────────────────────

  async createBooking(payload: Record<string, unknown>) {
    const headers = await this.authHeaders()
    const { data } = await this.http.post('/create_booking', payload, { headers })
    return data
  }

  async updateBooking(bookingId: number, params: Record<string, unknown>) {
    const headers = await this.authHeaders()
    const { data } = await this.http.post('/update_booking', null, {
      headers,
      params: { booking_id: bookingId, ...params },
    })
    return data
  }

  async getAllBookings(page = 1, perPage = 20) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/all_bookings', {
      headers,
      params: { page, per_page: perPage },
    })
    return data
  }

  async getActiveBookings(page = 1, perPage = 20) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/active_bookings', {
      headers,
      params: { page, per_page: perPage },
    })
    return data
  }

  async searchBookings(query: string, page = 1) {
    const headers = await this.authHeaders()
    const { data } = await this.http.get('/search_bookings', {
      headers,
      params: { query, page },
    })
    return data
  }

  // ─── Clients ──────────────────────────────────────────────────────────────

  async createClient(payload: Record<string, unknown>) {
    const headers = await this.authHeaders()
    const { data } = await this.http.post('/create_client', payload, { headers })
    return data
  }

  async updateClient(clientId: number, params: Record<string, unknown>) {
    const headers = await this.authHeaders()
    const { data } = await this.http.post('/update_client', null, {
      headers,
      params: { client_id: clientId, ...params },
    })
    return data
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  async createPayment(bookingId: number, payments: { sum: number; group: number }[]) {
    const headers = await this.authHeaders()
    const { data } = await this.http.post(
      '/create_payments',
      { booking_id: bookingId, payments },
      { headers },
    )
    return data
  }
}
