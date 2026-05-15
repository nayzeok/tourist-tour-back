import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  UseGuards,
  Req,
  Res,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { RentProgService } from './rentprog.service'
import { RentUserService } from '~/app/rent-user/rent-user.service'
import { PayKeeperService } from '~/app/paykeeper/paykeeper.service'
import { MailService } from '~/services/mail.service'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import { FastifyRequest, FastifyReply } from 'fastify'
import axios from 'axios'

interface AuthRequest extends FastifyRequest {
  user?: { id: string; email: string; role: string; firstName?: string | null; lastName?: string | null; phone?: string | null }
}

@Controller('rent')
export class RentProgController {
  private readonly logger = new Logger(RentProgController.name)

  constructor(
    private readonly rentprog: RentProgService,
    private readonly rentUser: RentUserService,
    private readonly paykeeper: PayKeeperService,
    private readonly mail: MailService,
  ) {}

  // ─── GET /rent/image-proxy?url=... ────────────────────────────────────────
  // Проксирует изображение с Яндекс-хранилища через наш сервер
  @Get('image-proxy')
  async proxyImage(
    @Query('url') url: string,
    @Res() reply: FastifyReply,
  ) {
    if (!url) throw new BadRequestException('url обязателен')

    // Разрешаем только rentprog.storage.yandexcloud.net
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new BadRequestException('Некорректный url')
    }
    if (!parsedUrl.hostname.endsWith('yandexcloud.net') && !parsedUrl.hostname.endsWith('rentprog.net')) {
      throw new BadRequestException('Недопустимый источник изображения')
    }

    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })

      const contentType = response.headers['content-type'] || 'image/jpeg'
      reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'public, max-age=86400') // кеш браузера 1 день
        .send(response.data)
    } catch (e: any) {
      this.logger.warn(`image-proxy error for ${url}: ${e?.message}`)
      throw new InternalServerErrorException('Не удалось получить изображение')
    }
  }

  // ─── GET /rent/cars ───────────────────────────────────────────────────────
  @Get('cars')
  async getFreeCars(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('city') city?: string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException('startDate и endDate обязательны')
    }
    try {
      const [freeCars, allFull] = await Promise.all([
        this.rentprog.getFreeCars(startDate, endDate),
        this.rentprog.getAllCarsFull(),
      ])

      const freeList = Array.isArray(freeCars) ? freeCars : []
      const freeById = new Map(freeList.map((c: any) => [String(c.id), c]))

      const fullList = Array.isArray(allFull) ? allFull : []
      const result = fullList
        .filter((car: any) => {
          if (!freeById.has(String(car.id))) return false
          if (city) {
            const carCity = (car.store_place || '').toLowerCase().trim()
            const searchCity = city.toLowerCase().trim()
            return carCity.includes(searchCity) || searchCity.includes(carCity)
          }
          return true
        })
        .map((car: any) => {
          // Берём deposit и selected_price из free_cars (дата-специфичные поля)
          const free = freeById.get(String(car.id))
          return this.mapCar({
            ...car,
            deposit: free?.deposit ?? car.deposit,
            selected_price: free?.selected_price ?? car.selected_price,
          })
        })

      return result
    } catch (e: any) {
      this.logger.error('getFreeCars error', e?.message)
      throw new InternalServerErrorException('Ошибка получения автомобилей')
    }
  }

  // ─── GET /rent/cities ─────────────────────────────────────────────────────
  // Уникальные города из store_place
  @Get('cities')
  async getRentCities() {
    try {
      const data = await this.rentprog.getAllCarsFull()
      const list = Array.isArray(data) ? data : []
      const cities = [...new Set(
        list
          .map((car: any) => (car.store_place || '').trim())
          .filter(Boolean)
          .map((c: string) => c.charAt(0).toUpperCase() + c.slice(1))
      )]
      return cities
    } catch (e: any) {
      this.logger.error('getRentCities error', e?.message)
      throw new InternalServerErrorException('Ошибка получения городов')
    }
  }

  // ─── GET /rent/cars/all ───────────────────────────────────────────────────
  // Все авто (для лендинга)
  @Get('cars/all')
  async getAllCars() {
    try {
      const data = await this.rentprog.getAllCarsFull()
      const list = Array.isArray(data) ? data : []
      return list.map((car: any) => this.mapCar(car))
    } catch (e: any) {
      this.logger.error('getAllCars error', e?.message)
      throw new InternalServerErrorException('Ошибка получения автомобилей')
    }
  }

  // ─── GET /rent/cars/:id ───────────────────────────────────────────────────
  @Get('cars/:id')
  async getCarData(
    @Param('id') id: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    try {
      if (startDate && endDate) {
        const data = await this.rentprog.getCarData(id, startDate, endDate)
        return this.mapCarFull(data)
      }
      const data = await this.rentprog.getCarDataWithBookings(id)
      return this.mapCarFull(data)
    } catch (e: any) {
      this.logger.error(`getCarData ${id} error`, e?.message)
      throw new InternalServerErrorException('Ошибка получения данных автомобиля')
    }
  }

  // ─── POST /rent/bookings ──────────────────────────────────────────────────
  @Post('bookings')
  @UseGuards(JwtAuthGuard)
  async createBooking(
    @Body() body: {
      carId: string
      startDate: string
      endDate: string
      pickupLocation?: string
      returnLocation?: string
      extraOptions?: string[]
      firstName: string
      lastName: string
      phone: string
    },
    @Req() req: AuthRequest,
  ) {
    const user = req.user
    if (!body.carId || !body.startDate || !body.endDate) {
      throw new BadRequestException('carId, startDate, endDate обязательны')
    }

    try {
      // 1. Создаём/находим клиента в RentProg
      const client = await this.rentprog.createClient({
        name: body.firstName,
        lastname: body.lastName,
        phone: body.phone,
        email: user?.email || '',
      })

      this.logger.log(`[BOOKING] createClient response: ${JSON.stringify(client)}`)

      const clientId = client?.id || client?.client?.id

      this.logger.log(`[BOOKING] clientId=${clientId} firstName=${body.firstName} lastName=${body.lastName}`)

      // Всегда обновляем имя/фамилию клиента (на случай если клиент уже существовал с пустым именем)
      if (clientId) {
        try {
          const updateRes = await this.rentprog.updateClient(clientId, {
            name: body.firstName,
            lastname: body.lastName,
            phone: body.phone,
            email: user?.email || '',
          })
          this.logger.log(`[BOOKING] updateClient response: ${JSON.stringify(updateRes)}`)
        } catch (e: any) {
          this.logger.warn(`[BOOKING] updateClient failed: ${e?.message} | ${JSON.stringify(e?.response?.data)}`)
        }
      }

      // 2. Получаем данные авто с ценой
      const carData = await this.rentprog.getCarData(body.carId, body.startDate, body.endDate)
      this.logger.log(`[BOOKING] carData keys: ${JSON.stringify(Object.keys(carData ?? {}))}`)
      this.logger.log(`[BOOKING] price fields: selected_price=${carData?.selected_price} rental_cost=${carData?.rental_cost} price=${carData?.price} prices=${JSON.stringify(carData?.prices)}`)

      // Количество суток
      const days = Math.max(1, Math.ceil(
        (new Date(body.endDate).getTime() - new Date(body.startDate).getTime()) / 86400000
      ))

      // selected_price — цена за 1 сутки для выбранного периода
      const pricePerDay = carData?.selected_price || carData?.rental_cost || carData?.price || 0
      const totalPrice = pricePerDay * days

      // 3. Создаём бронирование
      const bookingPayload = {
        car_id: Number(body.carId),
        start_date: this.toRentProgDate(body.startDate),
        end_date: this.toRentProgDate(body.endDate),
        days,
        start_place: body.pickupLocation || 'Офис аренды',
        end_place: body.returnLocation || body.pickupLocation || 'Офис аренды',
        client_id: clientId || undefined,
        name: body.firstName,
        lastname: body.lastName,
        phone: body.phone,
        email: user?.email || '',
        active: false,
        manual_editing: false,
        rental_cost: totalPrice,
        total: totalPrice,
      }

      this.logger.log(`[BOOKING] carId=${body.carId} pricePerDay=${pricePerDay} days=${days} totalPrice=${totalPrice} client=${body.firstName} ${body.lastName}`)

      // 3. Создаём бронь в RentProg (неактивная, активируется после оплаты)
      const rentprogBooking = await this.rentprog.createBooking(bookingPayload)
      const rentprogId = String(rentprogBooking?.id || rentprogBooking?.booking?.id || '')

      // 4. Сохраняем в нашей БД
      const apiBase = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
      const carImage = carData?.avatar_url
        ? `${apiBase}/rent/image-proxy?url=${encodeURIComponent(carData.avatar_url)}`
        : undefined

      const deposit = carData?.deposit ? Number(carData.deposit) : undefined

      const localBooking = await this.rentUser.createBooking(user!.id, {
        rentprogId,
        carId: body.carId,
        carName: carData?.car_name || `Автомобиль #${body.carId}`,
        carImage,
        city: carData?.store_place || undefined,
        startDate: body.startDate,
        endDate: body.endDate,
        pickupLocation: body.pickupLocation,
        returnLocation: body.returnLocation,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        totalAmount: totalPrice || undefined,
        depositAmount: deposit,
      })

      // 5. Отправляем письма
      const fmt = (d: string) => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      const price = totalPrice ? totalPrice.toLocaleString('ru-RU') + ' ₽' : '—'
      const depositStr = deposit ? deposit.toLocaleString('ru-RU') + ' ₽ (оплачивается при получении авто)' : '—'

      // Письмо администратору
      this.mail.sendMail({
        to: 'nayzeok@gmail.com',
        subject: `Новое бронирование аренды авто: ${carData?.car_name || body.carId}`,
        html: `
          <h2>Новое бронирование аренды автомобиля</h2>
          <ul>
            <li><b>Автомобиль:</b> ${carData?.car_name || body.carId}</li>
            <li><b>Период:</b> ${fmt(body.startDate)} — ${fmt(body.endDate)} (${days} дн.)</li>
            <li><b>Место выдачи:</b> ${body.pickupLocation || '—'}</li>
            <li><b>Место возврата:</b> ${body.returnLocation || '—'}</li>
            <li><b>Клиент:</b> ${body.firstName} ${body.lastName}</li>
            <li><b>Телефон:</b> ${body.phone}</li>
            <li><b>Email:</b> ${user?.email || '—'}</li>
            <li><b>Стоимость аренды:</b> ${price}</li>
            <li><b>Залог:</b> ${depositStr}</li>
            <li><b>ID брони:</b> ${localBooking.id}</li>
          </ul>
        `,
      }).catch((e: any) => this.logger.warn(`Admin email failed: ${e?.message}`))

      // Письмо клиенту
      if (user?.email) {
        this.mail.sendMail({
          to: user.email,
          subject: `Бронирование автомобиля подтверждено`,
          html: `
            <h2>Ваше бронирование принято!</h2>
            <p>Здравствуйте, ${body.firstName}!</p>
            <p>Мы получили вашу заявку на аренду автомобиля. Для завершения бронирования необходимо произвести оплату.</p>
            <ul>
              <li><b>Автомобиль:</b> ${carData?.car_name || body.carId}</li>
              <li><b>Период:</b> ${fmt(body.startDate)} — ${fmt(body.endDate)} (${days} дн.)</li>
              <li><b>Место выдачи:</b> ${body.pickupLocation || '—'}</li>
              <li><b>Стоимость аренды:</b> ${price}</li>
              <li><b>Залог:</b> ${depositStr}</li>
            </ul>
            <p>Перейдите в <a href="https://tourist-tours.ru/acc/rent/${localBooking.id}">личный кабинет</a>, чтобы оплатить бронирование.</p>
            <p>По всем вопросам звоните: 8 800 551 9000</p>
          `,
        }).catch((e: any) => this.logger.warn(`User email failed: ${e?.message}`))
      }

      return {
        booking: {
          id: localBooking.id,
          number: rentprogId || localBooking.id,
          status: 'new',
          startDate: body.startDate,
          endDate: body.endDate,
        },
      }
    } catch (e: any) {
      this.logger.error('createBooking error', e?.message)
      throw new InternalServerErrorException('Ошибка создания бронирования')
    }
  }

  // ─── POST /rent/images/sync ───────────────────────────────────────────────
  @Post('images/sync')
  @UseGuards(JwtAuthGuard)
  async syncImages(@Req() req: AuthRequest) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new BadRequestException('Нет доступа')
    }
    try {
      const result = await this.rentprog.forceResyncImages()
      return result
    } catch (e: any) {
      this.logger.error('syncImages error', e?.message)
      throw new InternalServerErrorException('Ошибка синхронизации фото')
    }
  }

  // ─── GET /rent/bookings/admin ─────────────────────────────────────────────
  @Get('bookings/admin')
  @UseGuards(JwtAuthGuard)
  async getAdminBookings(
    @Query('page') page = '1',
    @Query('per_page') perPage = '20',
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Req() req?: AuthRequest,
  ) {
    if (req?.user?.role !== 'SUPERADMIN' && req?.user?.role !== 'ADMIN') {
      throw new BadRequestException('Нет доступа')
    }
    try {
      if (search?.trim()) {
        return await this.rentprog.searchBookings(search.trim(), Number(page))
      }
      if (type === 'active') {
        return await this.rentprog.getActiveBookings(Number(page), Number(perPage))
      }
      return await this.rentprog.getAllBookings(Number(page), Number(perPage))
    } catch (e: any) {
      this.logger.error('getAdminBookings error', e?.message)
      throw new InternalServerErrorException('Ошибка получения бронирований')
    }
  }

  // ─── POST /rent/bookings/:id/update ──────────────────────────────────────
  @Post('bookings/:id/update')
  @UseGuards(JwtAuthGuard)
  async updateBooking(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthRequest,
  ) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new BadRequestException('Нет доступа')
    }
    try {
      return await this.rentprog.updateBooking(Number(id), body)
    } catch (e: any) {
      this.logger.error(`updateBooking ${id} error`, e?.message)
      throw new InternalServerErrorException('Ошибка обновления бронирования')
    }
  }

  // ─── Маппинг ──────────────────────────────────────────────────────────────

  private toRentProgDate(iso: string): string {
    const d = new Date(iso)
    const day = String(d.getDate()).padStart(2, '0')
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const year = d.getFullYear()
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${day}-${month}-${year} ${hours}:${minutes}`
  }

  private mapCar(car: any) {
    // Цена: из car_data — selected_price, из all_cars_full — prices[0].values[0]
    const pricePerDay =
      car.selected_price ||
      car.prices?.[0]?.values?.[0] ||
      0

    // Локальный кеш → прокси → нет фото
    const carId = String(car.id)
    const apiBase = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
    const localImage = this.rentprog.getLocalImagePath(carId, car.avatar_url)
    const images = localImage
      ? [`${apiBase}${localImage}`]
      : car.avatar_url
        ? [`${apiBase}/rent/image-proxy?url=${encodeURIComponent(car.avatar_url)}`]
        : []

    return {
      id: carId,
      name: car.car_name || '',
      brand: car.car_name?.split(' ')[0] || '',
      model: car.car_name?.split(' ').slice(1).join(' ') || '',
      year: car.year || null,
      class: car.car_class || null,
      bodyType: car.car_type || null,
      transmission: car.transmission || null,
      fuel: car.fuel || null,
      color: car.color || null,
      engineCapacity: car.engine_capacity || null,
      enginePower: car.engine_power || null,
      driveUnit: car.drive_unit || null,
      seats: car.number_seats || null,
      images,
      pricePerDay,
      deposit: car.deposit ?? null,        // залог (есть только в car_data)
      franchise: car.franchise ?? null,    // страховая франшиза (есть в обоих)
      minRentDays: 1,
      mileagePerDay: car.extra_mileage_km || null,
      city: car.store_place || null,
      available: true,
    }
  }

  private mapCarFull(car: any) {
    const base = this.mapCar(car)

    // Ценовые периоды для отображения
    const pricePeriods = car.prices?.[0]?.values?.map((price: number, i: number) => {
      const periods = ['1-3 дня', '4-7 дней', '8-14 дней', '15-21 день', '22+ дней']
      return { period: periods[i] || `Период ${i + 1}`, price }
    }) || []

    return {
      ...base,
      insurance: car.insurance || null,
      minAge: null,
      minExperience: null,
      documents: 'Паспорт РФ и водительское удостоверение',
      returnFuel: 'Возврат с тем же уровнем топлива',
      gasConsumption: car.gas_mileage || null,
      roofType: car.roof || null,
      interior: car.interior || null,
      extraMileagePrice: car.extra_mileage_price || null,
      pricePeriods,
      extraOptions: [],
      pickupLocations: [],
      returnLocations: [],
      description: car.description || null,
    }
  }
}
