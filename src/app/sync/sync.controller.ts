import { Controller, Post, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SyncService } from './sync.service'

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('trigger')
  @ApiOperation({ summary: 'Ручной запуск синхронизации контента' })
  @ApiResponse({ status: 200, description: 'Синхронизация запущена' })
  async triggerSync() {
    // Запускаем асинхронно, не ждём завершения
    this.syncService.manualSync().catch((err) => {
      console.error('Manual sync failed:', err)
    })

    return {
      success: true,
      message: 'Sync started in background',
      timestamp: new Date().toISOString(),
    }
  }
}
