import { Controller, Get, Post, Body } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CitiesService } from './cities.service'

@ApiTags('Geo')
@Controller()
export class CitiesController {
  constructor(private readonly citiesService: CitiesService) {}

  @Get('cities')
  @ApiOperation({ summary: 'Получить список городов' })
  @ApiResponse({
    status: 200,
    description: 'Географические данные через OAuth2',
  })
  async getGeoData() {
    return await this.citiesService.getGeoData()
  }

  @Post('example')
  @ApiResponse({ status: 201, description: 'Пример POST запроса через OAuth2' })
  async postExample(@Body() payload: any) {
    return await this.citiesService.postExampleData(payload)
  }
}
