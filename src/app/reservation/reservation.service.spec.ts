import { Test, TestingModule } from '@nestjs/testing'
import { ReservationService } from './reservation.service'
import { OAuthService } from '~/services'
import { AuthService } from '~/app/auth/auth.service'
import { UserService } from '~/app/user/user.service'
import { MailService } from '~/services/mail.service'
import { RedisService } from '~/redis/redis.service'

describe('ReservationService (alternativeBooking)', () => {
  let service: ReservationService
  let oauthPost: jest.Mock

  beforeEach(async () => {
    oauthPost = jest.fn()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        {
          provide: OAuthService,
          useValue: {
            post: oauthPost,
            get: jest.fn(),
          },
        },
        { provide: AuthService, useValue: {} },
        { provide: UserService, useValue: {} },
        { provide: MailService, useValue: { send: jest.fn() } },
        { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn() } },
      ],
    }).compile()

    service = module.get(ReservationService)
  })

  it('при ответе verify с пустым booking и alternativeBooking возвращает priceChanged и alternativeToken', async () => {
    const verifyResponse = {
      booking: [],
      alternativeBooking: [
        {
          createBookingToken: 'alternative-token-123',
          total: { priceBeforeTax: 2500, priceAfterTax: 2500 },
          roomStays: [],
        },
      ],
    }
    oauthPost.mockResolvedValue(verifyResponse)

    const roomStay = {
      roomTypeId: '355411',
      ratePlanId: '360745',
      checksum: 'original-checksum-base64',
      body: {},
      price: { total: 150, currency: 'RUB' },
      total: { priceBeforeTax: 150, priceAfterTax: 150 },
      currencyCode: 'RUB',
    }

    const result = await service.quickBook({
      propertyId: '8616',
      roomStay,
      arrival: '2026-02-11',
      departure: '2026-02-12',
      guestsCount: { adultCount: 1 },
      customer: {
        firstName: 'Test',
        lastName: 'User',
        phone: '+79991234567',
        email: 'test@example.com',
      },
    })

    expect(oauthPost).toHaveBeenCalled()
    expect(result).toMatchObject({
      priceChanged: true,
      alternativeToken: 'alternative-token-123',
      originalPrice: 150,
      alternativePrice: 2500,
      currencyCode: 'RUB',
      priceDifference: 2350,
    })
    expect(result.created).toBeNull()
  })

  it('при ответе verify с noAvailability (пустые booking и alternativeBooking) возвращает noAvailability и message', async () => {
    oauthPost.mockResolvedValue({
      booking: [],
      alternativeBooking: [],
      warnings: [{ message: 'Нет доступных номеров' }],
    })

    const roomStay = {
      roomTypeId: '355411',
      ratePlanId: '360745',
      checksum: 'some-checksum',
      body: {},
      price: { total: 150, currency: 'RUB' },
      total: { priceBeforeTax: 150, priceAfterTax: 150 },
      currencyCode: 'RUB',
    }

    const result = await service.quickBook({
      propertyId: '8616',
      roomStay,
      arrival: '2026-02-11',
      departure: '2026-02-12',
      guestsCount: { adultCount: 1 },
      customer: {
        firstName: 'Test',
        lastName: 'User',
        phone: '+79991234567',
        email: 'test@example.com',
      },
    })

    expect(result).toMatchObject({
      noAvailability: true,
      priceChanged: false,
      created: null,
    })
    expect((result as any).message).toBeDefined()
  })
})
