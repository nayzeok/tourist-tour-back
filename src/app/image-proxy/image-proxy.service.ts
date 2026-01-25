import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import axios from 'axios'

@Injectable()
export class ImageProxyService {
  private readonly logger = new Logger(ImageProxyService.name)
  private readonly cacheDir: string

  constructor() {
    // Директория для кэша изображений
    this.cacheDir = join(process.cwd(), 'uploads', 'images')
    this.ensureCacheDir()
  }

  private ensureCacheDir(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
      this.logger.log(`Created image cache directory: ${this.cacheDir}`)
    }
  }

  /**
   * Генерирует хэш из URL для использования в качестве имени файла
   */
  urlToHash(url: string): string {
    return createHash('md5').update(url).digest('hex')
  }

  /**
   * Кодирует URL в base64 для передачи через query-параметр
   */
  encodeUrl(url: string): string {
    return Buffer.from(url).toString('base64url')
  }

  /**
   * Декодирует URL из base64
   */
  decodeUrl(encoded: string): string {
    return Buffer.from(encoded, 'base64url').toString('utf-8')
  }

  /**
   * Преобразует внешний URL в наш проксированный URL
   * Формат: /images/proxy?url=base64encodedurl
   */
  transformUrl(originalUrl: string, baseUrl?: string): string {
    if (!originalUrl) return originalUrl

    // Если это уже наш URL — не трансформируем
    if (originalUrl.includes('/images/proxy')) {
      return originalUrl
    }

    const encodedUrl = this.encodeUrl(originalUrl)
    const base = baseUrl || process.env.API_BASE_URL || ''
    return `${base}/images/proxy?url=${encodedUrl}`
  }

  /**
   * Трансформирует массив URL
   */
  transformUrls(urls: string[], baseUrl?: string): string[] {
    return urls.map((url) => this.transformUrl(url, baseUrl))
  }

  /**
   * Получает изображение из кэша или скачивает по URL
   */
  async getImageByEncodedUrl(
    encodedUrl: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    // Декодируем URL
    let originalUrl: string
    try {
      originalUrl = this.decodeUrl(encodedUrl)
    } catch (e) {
      this.logger.error(`Failed to decode URL: ${encodedUrl}`)
      throw new NotFoundException('Invalid image URL')
    }

    // Генерируем хэш для имени файла в кэше
    const hash = this.urlToHash(originalUrl)

    // Проверяем кэш
    const cachedFile = this.findCachedFile(hash)
    if (cachedFile) {
      this.logger.debug(`Serving cached image: ${hash}`)
      return {
        buffer: readFileSync(cachedFile.path),
        contentType: cachedFile.contentType,
      }
    }

    // Скачиваем и кэшируем
    return await this.downloadAndCache(hash, originalUrl)
  }

  /**
   * Скачивает изображение и сохраняет в кэш
   */
  private async downloadAndCache(
    hash: string,
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      this.logger.log(`Downloading image: ${url}`)

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; TouristTour/1.0; +https://tourist-tours.ru)',
        },
      })

      const buffer = Buffer.from(response.data)
      const contentType = response.headers['content-type'] || 'image/jpeg'
      const ext = this.contentTypeToExt(contentType)

      // Сохраняем в файловую систему
      const filePath = join(this.cacheDir, `${hash}.${ext}`)
      writeFileSync(filePath, buffer)

      this.logger.log(`Cached image: ${hash}.${ext}`)

      return { buffer, contentType }
    } catch (error) {
      this.logger.error(
        `Failed to download image: ${url}`,
        error instanceof Error ? error.message : error,
      )
      throw new NotFoundException(`Failed to fetch image`)
    }
  }

  /**
   * Ищет закэшированный файл по хэшу
   */
  private findCachedFile(
    hash: string,
  ): { path: string; contentType: string } | null {
    const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif']

    for (const ext of extensions) {
      const filePath = join(this.cacheDir, `${hash}.${ext}`)
      if (existsSync(filePath)) {
        return {
          path: filePath,
          contentType: this.extToContentType(ext),
        }
      }
    }

    return null
  }

  private contentTypeToExt(contentType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    }
    return map[contentType.split(';')[0]] || 'jpg'
  }

  private extToContentType(ext: string): string {
    const map: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
    }
    return map[ext] || 'image/jpeg'
  }
}
