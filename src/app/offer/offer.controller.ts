import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiResponse } from '@nestjs/swagger'
import { OfferService } from '~/app/offer/offer.service'
import { parseDatesRange } from '~/utils/date'
import { PropertyOffersResponse } from '~/shared'

@Controller('offer')
export class OfferController {
  constructor(private offerService: OfferService) {}

  @Get('/:propertyId')
  @ApiOperation({ summary: 'Варианты номеров и минимальная цена на даты' })
  @ApiResponse({ status: 200, description: 'Контент + офферы (Search API)' })
  async getHotelOffers(
    @Param('propertyId') propertyId: string,
    @Query('dates') datesRange: string, // "26.09.2025-28.09.2025"
    @Query('adultCount') adultCountRaw = '1',
    @Query('childAges') childAgesRaw?: string, // "5,10"
    @Query('currency') currency = 'RUB',
    @Query('language') language = 'ru',
  ): Promise<PropertyOffersResponse> {
    if (!propertyId) throw new BadRequestException('propertyId is required')
    if (!datesRange) throw new BadRequestException('dates is required')

    const { arrival, departure } = parseDatesRange(datesRange)

    const adultCount = Number(adultCountRaw ?? '1')
    if (!Number.isFinite(adultCount) || adultCount < 1) {
      throw new BadRequestException('You must have at least 1 adult')
    }

    const childAges = (childAgesRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n >= 0)

    return this.offerService.getPropertyOffers(
      propertyId,
      arrival,
      departure,
      { adultCount, childAges },
      { currency, language },
    )
  }
}
