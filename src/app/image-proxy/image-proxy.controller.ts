import { Controller, Get, Query, Res, NotFoundException } from '@nestjs/common'
import { FastifyReply } from 'fastify'
import { ImageProxyService } from './image-proxy.service'
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger'

@ApiTags('images')
@Controller('images')
export class ImageProxyController {
  constructor(private readonly imageProxyService: ImageProxyService) {}

  @Get('proxy')
  @ApiOperation({ summary: 'Получить проксированное изображение' })
  @ApiQuery({
    name: 'url',
    description: 'Base64-encoded URL изображения',
    example: 'aHR0cHM6Ly9leGFtcGxlLmNvbS9pbWFnZS5qcGc',
  })
  @ApiResponse({ status: 200, description: 'Изображение успешно возвращено' })
  @ApiResponse({ status: 404, description: 'Изображение не найдено' })
  async getImage(
    @Query('url') encodedUrl: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    if (!encodedUrl) {
      throw new NotFoundException('URL parameter is required')
    }

    const { buffer, contentType } =
      await this.imageProxyService.getImageByEncodedUrl(encodedUrl)

    res
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(buffer)
  }
}
