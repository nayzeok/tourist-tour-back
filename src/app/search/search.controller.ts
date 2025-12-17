import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common'
import { SearchService } from '~/app/search/search.service'
import { parseDatesRange } from '~/utils/date'

@ApiTags('search')
@Controller()
export class SearchController {
  constructor(private readonly hotelService: SearchService) {}

  @Get('hotels')
  @ApiOperation({ summary: 'Получить список отелей' })
  @ApiResponse({ status: 200, description: 'Список отелей' })
  async getHotels(
    @Query('cityId') cityId: string,
    @Query('dates') datesRange: string, // например: "26.09.2025-28.09.2025"
    @Query('adultCount') adultCountRaw = '1',
    @Query('childAges') childAgesRaw?: string,
  ) {
    if (!cityId) throw new BadRequestException('cityId is required')
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

    return this.hotelService.getHotelsList(
      cityId,
      arrival,
      departure,
      { adultCount, childAges },
      { currency: 'RUB', limit: 20 },
    )
  }

  @Get('hotels/:propertyId')
  @ApiOperation({ summary: 'Получить контент отеля по propertyId' })
  @ApiResponse({ status: 200, description: 'Контент объекта из Content API' })
  async getHotelContent(
    @Param('propertyId') propertyId: string,
    @Query('refresh') refresh?: string,
  ) {
    if (!propertyId) {
      throw new BadRequestException('propertyId is required')
    }

    const forceRefresh = ['1', 'true', 'yes'].includes(
      (refresh ?? '').toLowerCase(),
    )

    return this.hotelService.getPropertyContent(propertyId, {
      refresh: forceRefresh,
    })
  }
}
